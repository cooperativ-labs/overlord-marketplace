import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { REPO_ROOT } from './helpers.mjs';

// Node has no YAML parser; the Ruby standard library does. CI runners ship Ruby, so a
// missing interpreter is a failure there and a skip only on a developer machine.
const ruby = spawnSync('ruby', ['-e', 'require "yaml"; require "json"'], {encoding: 'utf8'}).status === 0;
const skip = !ruby && !process.env.CI ? 'ruby with yaml/json is unavailable' : false;
const DIR = join(REPO_ROOT, '.github/workflows');
const files = existsSync(DIR) ? readdirSync(DIR).filter(f => f.endsWith('.yml')).sort() : [];
function load(file) {
  const json = execFileSync('ruby', ['-ryaml', '-rjson', '-e', 'puts JSON.generate(YAML.safe_load(File.read(ARGV[0]), aliases: false))', join(DIR, file)], {encoding: 'utf8'});
  const doc = JSON.parse(json);
  doc.on ??= doc.true; // YAML 1.1 reads the bare key `on` as boolean true.
  return {doc, text: readFileSync(join(DIR, file), 'utf8')};
}
const steps = doc => Object.entries(doc.jobs).flatMap(([job, j]) => (j.steps ?? []).map(s => ({job, ...s})));
const CI_COMMANDS = ['baseline', 'smoke-plan', 'resolve-plugins', 'prepare', 'verify-bundle', 'publish', 'audit'];

test('the three workflows exist', {skip}, () => {
  assert.deepEqual(files, ['cli-drift.yml', 'ingest.yml', 'validate.yml']);
});

test('every workflow follows the shared security rules', {skip}, () => {
  for (const file of files) {
    const {doc, text} = load(file);
    assert.ok(doc.permissions !== undefined, `${file}: top-level permissions`);
    assert.ok(!('pull_request_target' in doc.on), `${file}: pull_request_target is forbidden`);
    for (const line of text.split('\n').filter(l => /^\s*-?\s*uses:/.test(l))) {
      assert.match(line, /uses: [\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/, `${file}: action pinned by SHA with version comment: ${line.trim()}`);
    }
    for (const [name, job] of Object.entries(doc.jobs)) {
      assert.ok(Number.isInteger(job['timeout-minutes']), `${file}/${name}: timeout-minutes`);
      assert.ok(job.permissions === undefined || typeof job.permissions === 'object', `${file}/${name}: explicit permission map`);
    }
    for (const step of steps(doc)) {
      if (step.uses?.startsWith('actions/checkout@')) assert.equal(step.with?.['persist-credentials'], false, `${file}/${step.job}: checkout must not persist credentials`);
      if (step.run === undefined) continue;
      // Event text reaches shell only through env; `${{` inside run is an injection risk.
      assert.doesNotMatch(step.run, /\$\{\{/, `${file}/${step.job}/${step.name}: expression inside run`);
      const check = spawnSync('bash', ['-n'], {input: step.run, encoding: 'utf8'});
      assert.equal(check.status, 0, `${file}/${step.job}/${step.name}: bash syntax: ${check.stderr}`);
      for (const [, path] of step.run.matchAll(/\b(scripts\/[\w./-]+\.(?:mjs|sh|py))/g)) assert.ok(existsSync(join(REPO_ROOT, path)), `${file}: ${path} exists`);
      for (const [, command] of step.run.matchAll(/scripts\/ci\.mjs ([a-z-]+)/g)) assert.ok(CI_COMMANDS.includes(command), `${file}: ci.mjs ${command}`);
    }
    assert.doesNotMatch(text, /gh pr merge|--auto\b|auto-merge:/, `${file}: no v1 auto-merge`);
    if (file !== 'ingest.yml') assert.doesNotMatch(text, /\$\{\{\s*(?:secrets|vars)\./, `${file}: no repository secrets or App variables`);
  }
});

test('validate.yml compares an immutable baseline across Linux and macOS behind one aggregate check', {skip}, () => {
  const {doc} = load('validate.yml');
  assert.deepEqual(Object.keys(doc.on).sort(), ['pull_request', 'push']);
  assert.deepEqual(doc.on.push.branches, ['main']);
  assert.deepEqual(doc.permissions, {contents: 'read'});
  assert.match(doc.env.CODEX_VERSION, /^\d+\.\d+\.\d+$/);
  assert.match(doc.env.CLAUDE_CODE_VERSION, /^\d+\.\d+\.\d+$/);
  assert.match(doc.env.GITLEAKS_LINUX_X64_SHA256, /^[0-9a-f]{64}$/);
  assert.deepEqual(doc.jobs.checks.strategy.matrix.os, ['ubuntu-24.04', 'macos-15']);
  assert.equal(doc.jobs.checks.strategy['fail-fast'], false);
  const checkout = doc.jobs.checks.steps.find(s => s.uses?.startsWith('actions/checkout@'));
  assert.equal(checkout.with['fetch-depth'], 0);
  const base = doc.jobs.checks.steps.find(s => s.id === 'base');
  assert.equal(base.env.PR_BASE_SHA, '${{ github.event.pull_request.base.sha }}');
  const runs = doc.jobs.checks.steps.map(s => s.run ?? '').join('\n');
  for (const needle of ['npm test', 'scripts/validate.mjs', '--base "$BASE"', 'synthetic-smoke.mjs --matrix', 'smoke.sh . --upgrade-from "$BASE"', 'smoke.sh .', 'claude plugin validate .', 'plugins/claude-code/*/']) assert.ok(runs.includes(needle), needle);
  const aggregate = doc.jobs.validate;
  const others = Object.keys(doc.jobs).filter(j => j !== 'validate').sort();
  assert.equal(aggregate.if, 'always()');
  assert.deepEqual([...aggregate.needs].sort(), others);
  assert.match(aggregate.steps.at(-1).run, new RegExp(`length == ${others.length} and`));
  assert.ok(steps(doc).some(s => s.job === 'distribution-scan' && /gitleaks" dir \. --config \.gitleaks\.toml/.test(s.run ?? '')));
  assert.ok(steps(doc).some(s => s.job === 'distribution-scan' && /sha256sum -c/.test(s.run ?? '')));
});

test('ingest.yml serializes writers and confines the App token to publication', {skip}, () => {
  const {doc, text} = load('ingest.yml');
  assert.deepEqual(Object.keys(doc.on).sort(), ['repository_dispatch', 'schedule', 'workflow_dispatch']);
  assert.deepEqual(doc.on.repository_dispatch.types, ['plugin-release']);
  assert.match(doc.on.schedule[0].cron, /^\d+ \*\/6 \* \* \*$/);
  assert.deepEqual(doc.permissions, {contents: 'read'});
  assert.deepEqual(doc.concurrency, {group: 'overlord-marketplace-catalog-writer', 'cancel-in-progress': false});
  const prepare = doc.jobs.prepare.steps;
  assert.match(prepare[0].run, /refs\/heads\/main/);
  assert.ok(!JSON.stringify(doc.jobs.prepare).includes('secrets.'), 'prepare holds no credentials');
  const publish = doc.jobs.publish.steps;
  const tokenAt = publish.findIndex(s => s.uses?.startsWith('actions/create-github-app-token@'));
  const verifyAt = publish.findIndex(s => /ci\.mjs verify-bundle/.test(s.run ?? ''));
  const publishAt = publish.findIndex(s => /ci\.mjs publish/.test(s.run ?? ''));
  assert.ok(verifyAt >= 0 && verifyAt < tokenAt && tokenAt === publishAt - 1, 'verify, then mint, then publish');
  assert.deepEqual(publish[tokenAt].with, {'client-id': '${{ vars.MARKETPLACE_APP_CLIENT_ID }}', 'private-key': '${{ secrets.MARKETPLACE_APP_PRIVATE_KEY }}', 'permission-contents': 'write', 'permission-pull-requests': 'write'});
  assert.equal(publish[publishAt].env.GH_TOKEN, '${{ steps.app.outputs.token }}');
  assert.equal(text.match(/\$\{\{\s*secrets\./g).length, 1);
  assert.equal(text.match(/steps\.app\.outputs\.token/g).length, 1);
  assert.equal(doc.jobs.publish.if, "${{ !cancelled() && needs.prepare.outputs.publish == 'true' }}");
  assert.equal(publish.find(s => s.uses?.startsWith('actions/checkout@')).with.ref, '${{ needs.prepare.outputs.base }}');
});

test('cli-drift.yml tests latest CLIs and reports through a separate issues-only job', {skip}, () => {
  const {doc} = load('cli-drift.yml');
  assert.deepEqual(Object.keys(doc.on).sort(), ['schedule', 'workflow_dispatch']);
  assert.deepEqual(doc.permissions, {});
  assert.deepEqual(doc.jobs['smoke-latest'].permissions, {contents: 'read'});
  assert.deepEqual(doc.jobs.report.permissions, {issues: 'write'});
  assert.ok(!doc.jobs.report.steps.some(s => s.uses?.startsWith('actions/checkout@')), 'report job runs no repository code');
  const install = doc.jobs['smoke-latest'].steps.map(s => s.run ?? '').join('\n');
  assert.match(install, /@openai\/codex@latest @anthropic-ai\/claude-code@latest/);
  assert.match(install, /npm ls -g/);
  assert.match(doc.jobs.report.steps.at(-1).run, /gh issue close/);
});

test('drift report keeps exactly one open issue and closes it on recovery', {skip}, async () => {
  const {doc} = load('cli-drift.yml');
  const script = doc.jobs.report.steps.at(-1).run;
  const dir = await mkdtemp(join(tmpdir(), 'drift-report-'));
  try {
    execFileSync('mkdir', ['-p', join(dir, 'bin'), join(dir, 'drift-results')]);
    execFileSync('sh', ['-c', `cat > "${dir}/drift-results/ubuntu-24.04.json" <<'EOF'\n{"os":"ubuntu-24.04","codex":"codex-cli 9.9.9","claude":"9.9.9 (Claude Code)"}\nEOF`]);
    // Fake gh: issues live in a JSON file; every call is logged.
    execFileSync('sh', ['-c', `cat > "${dir}/bin/gh" <<'EOF'\n#!/bin/sh\necho "$*" >> "$STATE.log"\ncase "$1 $2" in\n"issue list") cat "$STATE" ;;\n"issue create") echo '[{"number":7,"title":"CLI drift: native smoke fails with the latest host CLIs"}]' > "$STATE" ;;\n"issue close") echo '[]' > "$STATE" ;;\nesac\nEOF\nchmod +x "${dir}/bin/gh"; echo '[]' > "${dir}/issues.json"`]);
    const runReport = result => spawnSync('bash', ['-eo', 'pipefail', '-c', script], {cwd: dir, encoding: 'utf8', env: {...process.env, PATH: `${dir}/bin:${process.env.PATH}`, STATE: join(dir, 'issues.json'), RUNNER_TEMP: dir, REPO: 'o/r', RESULT: result, RUN_URL: 'https://example.invalid/run'}});
    const log = async () => (await readFile(join(dir, 'issues.json.log'), 'utf8').catch(() => '')).trim().split('\n').map(l => l.split(' ').slice(0, 2).join(' '));
    for (const [result, calls] of [['success', ['issue list']], ['failure', ['issue list', 'issue list', 'issue create']], ['failure', ['issue list', 'issue list', 'issue create', 'issue list', 'issue comment']], ['success', ['issue list', 'issue list', 'issue create', 'issue list', 'issue comment', 'issue list', 'issue comment', 'issue close']]]) {
      const r = runReport(result);
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(await log(), calls);
    }
    assert.match(readFileSync(join(dir, 'body.md'), 'utf8'), /\| ubuntu-24\.04 \| codex-cli 9\.9\.9 \| 9\.9\.9 \(Claude Code\) \|/);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('ci.mjs writes step outputs and rejects unknown commands', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ci-cli-'));
  try {
    const out = join(dir, 'out');
    const cli = (args, env = {}) => spawnSync(process.execPath, [join(REPO_ROOT, 'scripts/ci.mjs'), ...args], {cwd: REPO_ROOT, encoding: 'utf8', env: {...process.env, GITHUB_OUTPUT: out, ...env}});
    assert.equal(cli(['resolve-plugins', '--event', 'workflow_dispatch'], {PLUGIN_REQUEST: 'all'}).status, 0);
    assert.equal(readFileSync(out, 'utf8'), 'plugins=["knowledgebase"]\n');
    assert.equal(cli(['resolve-plugins', '--event', 'workflow_dispatch'], {PLUGIN_REQUEST: '../x'}).status, 1);
    assert.equal(cli(['nope']).status, 2);
    assert.equal(cli(['prepare', '--plugins', '["../x"]', '--out', dir]).status, 1);
  } finally { await rm(dir, {recursive: true, force: true}); }
});
