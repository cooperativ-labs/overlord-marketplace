import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, cp, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { after } from 'node:test';
import { fixtureRepo, releaseArtifacts, REPO_ROOT } from './helpers.mjs';
import { audit, prBody, prepare, publish, resolvePlugins, smokePlan, verifyBaseline, verifyBundle } from '../scripts/ci.mjs';
import { ingest } from '../scripts/ingest.mjs';

// Disposable Git only: no user or system config (signing, hooks, credential helpers).
Object.assign(process.env, {GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_NAME: 'Human', GIT_AUTHOR_EMAIL: 'human@example.invalid', GIT_COMMITTER_NAME: 'Human', GIT_COMMITTER_EMAIL: 'human@example.invalid'});
delete process.env.GH_TOKEN;
const dirs = [];
after(async () => { await Promise.all(dirs.map(d => rm(d, {recursive: true, force: true}))); });
const temp = async name => { const d = await mkdtemp(join(tmpdir(), `ci-test-${name}-`)); dirs.push(d); return d; };
const git = (cwd, ...args) => execFileSync('git', args, {cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();

// A fake gh that keeps PRs in a JSON file, so publish runs end to end against a bare remote.
const FAKE_GH = `const fs = require('node:fs');
const file = process.env.FAKE_GH_STATE;
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
const a = process.argv.slice(2);
const opt = k => a[a.indexOf(k) + 1];
state.calls.push(a.filter((x, i) => a[i - 1] !== '--body-file').join(' '));
let out = '';
if (a[0] === 'api') out = JSON.stringify({id: 4242, login: a[1].slice(6)});
else if (a[0] === 'pr' && a[1] === 'list') out = JSON.stringify(state.prs.filter(p => p.headRefName === opt('--head')));
else if (a[0] === 'pr' && a[1] === 'create') { const n = state.prs.length + 1; state.prs.push({number: n, state: 'OPEN', author: {login: 'app/' + state.slug}, title: opt('--title'), body: fs.readFileSync(opt('--body-file'), 'utf8'), headRefName: opt('--head'), isCrossRepository: false}); out = 'https://github.example/pull/' + n; }
else if (a[0] === 'pr' && a[1] === 'edit') { const p = state.prs.find(x => x.number === Number(a[2])); p.title = opt('--title'); p.body = fs.readFileSync(opt('--body-file'), 'utf8'); }
else { process.stderr.write('fake gh: unsupported ' + a.join(' ')); process.exit(1); }
fs.writeFileSync(file, JSON.stringify(state));
process.stdout.write(out);
`;

async function world() {
  const repo = await fixtureRepo();
  await repo.write('.gitignore', '.tmp/\n');
  git(repo.root, 'init', '-q', '-b', 'main');
  git(repo.root, 'add', '.');
  git(repo.root, 'commit', '-qm', 'bootstrap');
  const top = await temp('world');
  const origin = join(top, 'origin.git'), work = join(top, 'work'), pub = join(top, 'pub'), bin = join(top, 'bin'), state = join(top, 'gh.json');
  git(top, 'clone', '-q', '--bare', repo.root, origin);
  git(top, 'clone', '-q', origin, work);
  git(top, 'clone', '-q', origin, pub);
  await mkdir(bin);
  await writeFile(join(bin, 'gh.cjs'), FAKE_GH);
  await writeFile(join(bin, 'gh'), `#!/bin/sh\nexec node "${join(bin, 'gh.cjs')}" "$@"\n`);
  await chmod(join(bin, 'gh'), 0o755);
  await writeFile(state, JSON.stringify({slug: 'marketplace-bot', prs: [], calls: []}));
  process.env.PATH = `${bin}:${process.env.PATH}`;
  process.env.FAKE_GH_STATE = state;
  return {top, origin, work, pub, readState: async () => JSON.parse(await readFile(state, 'utf8')), writeState: async s => writeFile(state, JSON.stringify(s))};
}
const opts = {slug: 'marketplace-bot', repo: 'cooperativ-labs/overlord-marketplace'};
const remoteRef = (w, ref) => git(w.top, 'ls-remote', w.origin, ref).split(/\s/)[0] || '';
const sync = (w, cwd) => { git(cwd, 'fetch', '-q', 'origin'); git(cwd, 'reset', '-q', '--hard', 'origin/main'); return git(cwd, 'rev-parse', 'HEAD'); };

test('resolve-plugins accepts only discovered source ids', async () => {
  const repo = await fixtureRepo();
  assert.deepEqual(await resolvePlugins(repo.root, 'schedule', ''), ['knowledgebase']);
  assert.deepEqual(await resolvePlugins(repo.root, 'workflow_dispatch', 'all'), ['knowledgebase']);
  assert.deepEqual(await resolvePlugins(repo.root, 'workflow_dispatch', 'knowledgebase'), ['knowledgebase']);
  assert.deepEqual(await resolvePlugins(repo.root, 'repository_dispatch', 'knowledgebase'), ['knowledgebase']);
  for (const bad of ['../sources/x', 'Knowledgebase', 'scribe', 'knowledgebase --dry-run', 'knowledgebase\n', '$(id)']) {
    await assert.rejects(resolvePlugins(repo.root, 'workflow_dispatch', bad), /source id/);
  }
  for (const bad of ['', 'all', undefined]) await assert.rejects(resolvePlugins(repo.root, 'repository_dispatch', bad), /client_payload\.plugin/);
});

test('baseline must be a full ancestor commit and the smoke plan follows the release state', async () => {
  const w = await world();
  const base = git(w.work, 'rev-parse', 'HEAD');
  assert.equal(verifyBaseline(w.work, base), base);
  assert.throws(() => verifyBaseline(w.work, base.slice(0, 12)), /full commit SHA/);
  assert.throws(() => verifyBaseline(w.work, 'f'.repeat(40)));
  git(w.work, 'checkout', '-q', '--orphan', 'other');
  git(w.work, 'commit', '-q', '--allow-empty', '-m', 'unrelated');
  assert.throws(() => verifyBaseline(w.work, base), /not an ancestor/);
  git(w.work, 'checkout', '-q', 'main');
  assert.deepEqual(await smokePlan(w.work), {mode: 'bootstrap', released: []});
  const a = await releaseArtifacts(w.top, '1.0.0');
  await ingest(w.work, 'knowledgebase', {fetcher: a.fetcher});
  assert.equal((await smokePlan(w.work)).mode, 'fresh');
  assert.deepEqual(await smokePlan(w.work, base), {mode: 'compare', released: ['knowledgebase'], base});
});

test('prepare, verify and publish build idempotent bot-owned release PRs', async () => {
  const w = await world();
  const a = await releaseArtifacts(w.top, '1.0.0', 'fixture A');
  const base = git(w.work, 'rev-parse', 'HEAD');
  const bundleA = join(w.top, 'bundle-a');
  const manifest = await prepare(w.work, ['knowledgebase'], bundleA, {fetcher: a.fetcher});
  assert.deepEqual(manifest.plugins.map(p => [p.id, p.status, p.version]), [['knowledgebase', 'updated', '1.0.0']]);
  assert.equal(git(w.work, 'status', '--porcelain'), '', 'prepare leaves the checkout untouched');
  assert.equal(git(w.work, 'worktree', 'list').split('\n').length, 1);
  const body = await readFile(join(bundleA, 'knowledgebase', 'body.md'), 'utf8');
  assert.match(body, /overlord-ingest:v1 plugin=knowledgebase version=1\.0\.0 /);
  assert.match(body, /no auto-merge/);
  assert.deepEqual(await verifyBundle(w.pub, bundleA, base), ['knowledgebase']);
  await assert.rejects(verifyBundle(w.pub, bundleA, 'a'.repeat(40)), /HEAD is not the bundle base/);

  // First publish opens the PR on a branch whose only commit is the bot's, on top of base.
  let results = await publish(w.pub, bundleA, base, opts);
  assert.deepEqual(results.map(r => r.action), ['opened PR']);
  const first = remoteRef(w, 'refs/heads/sync/knowledgebase');
  git(w.pub, 'fetch', '-q', 'origin');
  assert.equal(git(w.pub, 'rev-parse', `${first}^`), base);
  assert.equal(git(w.pub, 'log', '-1', '--format=%an <%ae>', first), 'marketplace-bot[bot] <4242+marketplace-bot[bot]@users.noreply.github.com>');
  assert.deepEqual(git(w.pub, 'diff', '--name-only', base, first).split('\n').map(p => p.split('/').slice(0, 3).join('/')).filter((p, i, all) => all.indexOf(p) === i).sort(),
    ['.agents/plugins/marketplace.json', '.claude-plugin/marketplace.json', 'plugins/claude-code/knowledgebase', 'plugins/codex/knowledgebase', 'sources/knowledgebase.lock.json']);
  assert.equal(git(w.pub, 'status', '--porcelain'), '');
  assert.equal(git(w.pub, 'rev-parse', 'HEAD'), base);

  // A rerun (e.g. after a partial API failure) neither pushes nor opens a second PR.
  results = await publish(w.pub, bundleA, base, opts);
  assert.deepEqual(results.map(r => [r.action, r.detail]), [['updated PR', 'sync/knowledgebase already current']]);
  assert.equal(remoteRef(w, 'refs/heads/sync/knowledgebase'), first);
  let state = await w.readState();
  assert.equal(state.prs.length, 1);

  // Merge the release; the next poll is a no-op.
  git(w.pub, 'push', '-q', 'origin', `${first}:refs/heads/main`);
  state.prs[0].state = 'MERGED'; await w.writeState(state);
  const merged = sync(w, w.work);
  const noop = await prepare(w.work, ['knowledgebase'], join(w.top, 'bundle-noop'), {fetcher: a.fetcher});
  assert.deepEqual(noop.plugins.map(p => p.status), ['up-to-date']);

  // A human commit on the sync branch stops automation and leaves the branch as it is.
  const b = await releaseArtifacts(w.top, '1.1.0', 'fixture B');
  const bundleB = join(w.top, 'bundle-b');
  assert.deepEqual((await prepare(w.work, ['knowledgebase'], bundleB, {fetcher: b.fetcher})).plugins.map(p => [p.status, p.oldVersion, p.version]), [['updated', '1.0.0', '1.1.0']]);
  sync(w, w.pub);
  const human = join(w.top, 'human');
  git(w.top, 'clone', '-q', '-b', 'sync/knowledgebase', w.origin, human);
  await writeFile(join(human, 'NOTE.md'), 'maintainer note\n');
  git(human, 'add', '.'); git(human, 'commit', '-qm', 'maintainer edit'); git(human, 'push', '-q', 'origin', 'sync/knowledgebase');
  const humanRef = remoteRef(w, 'refs/heads/sync/knowledgebase');
  results = await publish(w.pub, bundleB, merged, opts);
  assert.equal(results[0].action, 'error');
  assert.match(results[0].detail, /not made by marketplace-bot\[bot\]/);
  assert.equal(remoteRef(w, 'refs/heads/sync/knowledgebase'), humanRef);
  assert.equal(git(w.pub, 'status', '--porcelain'), '');

  // Once the maintainer removes their branch, a newer release updates through a new PR.
  git(human, 'push', '-q', 'origin', '--delete', 'sync/knowledgebase');
  results = await publish(w.pub, bundleB, merged, opts);
  assert.deepEqual(results.map(r => r.action), ['opened PR']);
  state = await w.readState();
  assert.equal(state.prs.length, 2);
  assert.equal(state.prs[1].title, 'knowledgebase 1.0.0 → 1.1.0');

  // A release PR closed without merging is not reopened for the same version.
  state.prs[1].state = 'CLOSED'; await w.writeState(state);
  results = await publish(w.pub, bundleB, merged, opts);
  assert.equal(results[0].action, 'skipped');
  assert.equal((await w.readState()).prs.length, 2);

  // A human-opened PR on the bot branch is never edited.
  state = await w.readState(); state.prs.push({number: 3, state: 'OPEN', author: {login: 'maintainer'}, body: '', headRefName: 'sync/knowledgebase', isCrossRepository: false}); await w.writeState(state);
  results = await publish(w.pub, bundleB, merged, opts);
  assert.match(results[0].detail, /was not opened by/);
});

test('bundles cannot write outside the plugin generated paths', async () => {
  const w = await world();
  const a = await releaseArtifacts(w.top, '1.0.0');
  const base = git(w.work, 'rev-parse', 'HEAD');
  const bundle = join(w.top, 'bundle');
  await prepare(w.work, ['knowledgebase'], bundle, {fetcher: a.fetcher});
  const tamper = async (name, edit) => {
    const copy = join(w.top, name), x = join(w.top, `${name}-x`);
    await cp(bundle, copy, {recursive: true}); await mkdir(x);
    execFileSync('tar', ['-xf', join(copy, 'knowledgebase', 'payload.tar'), '-C', x]);
    await edit(x);
    execFileSync('tar', ['-cf', join(copy, 'knowledgebase', 'payload.tar'), '-C', x, ...await readdir(x)], {env: {...process.env, COPYFILE_DISABLE: '1'}});
    return copy;
  };
  const escape = await tamper('escape', async x => { await mkdir(join(x, 'scripts')); await writeFile(join(x, 'scripts', 'evil.mjs'), 'x'); });
  await assert.rejects(verifyBundle(w.pub, escape, base), /outside knowledgebase's generated files/);
  const link = await tamper('link', async x => symlink('/etc/passwd', join(x, 'plugins/codex/knowledgebase/link')));
  await assert.rejects(verifyBundle(w.pub, link, base), /non-regular entry/);
  const invalid = await tamper('invalid', async x => writeFile(join(x, 'plugins/codex/knowledgebase/skills/knowledgebase/SKILL.md'), 'edited by hand\n'));
  await assert.rejects(verifyBundle(w.pub, invalid, base), /candidate is invalid/);
  const unknown = join(w.top, 'unknown');
  await cp(bundle, unknown, {recursive: true});
  const m = JSON.parse(await readFile(join(unknown, 'manifest.json'), 'utf8')); m.plugins[0].id = 'scribe';
  await writeFile(join(unknown, 'manifest.json'), JSON.stringify(m));
  await assert.rejects(verifyBundle(w.pub, unknown, base), /unknown source/);
  await writeFile(join(w.pub, 'stray.txt'), 'x');
  await assert.rejects(verifyBundle(w.pub, bundle, base), /uncommitted changes/);
});

test('PR bodies are bounded and neutralise markup from release data', () => {
  const report = {version: '1.0.0', oldVersion: null, sourceSha256: 'a'.repeat(64), indexSha256: 'b'.repeat(64),
    hosts: {codex: {url: 'https://x/`c`|d', zipSha256: 'c'.repeat(64), treeSha256: 'd'.repeat(64), fileCount: 3}, 'claude-code': {url: 'https://x/e', zipSha256: 'e'.repeat(64), treeSha256: 'f'.repeat(64), fileCount: 3}},
    changedPaths: {codex: {count: 1, paths: ['skills/`x`\n|y']}, 'claude-code': {count: 0, paths: []}}};
  const body = prBody(report, 'knowledgebase', '0'.repeat(40));
  assert.match(body, /first release 1\.0\.0/);
  assert.doesNotMatch(body, /`c`|`x`|\n\|y/);
  report.changedPaths.codex = {count: 9999, paths: Array.from({length: 2000}, (_, i) => `skills/${'p'.repeat(200)}${i}`)};
  assert.ok(prBody(report, 'knowledgebase', '0'.repeat(40)).length <= 60_001);
});

test('audit flags personal paths and email addresses and passes the real distribution', async () => {
  // Assembled at runtime so this file does not itself trip the audit.
  const home = ['', 'Users', 'alice'].join('/'), email = ['alice', 'corp.example.com'].join('@');
  const dir = await temp('audit');
  git(dir, 'init', '-q');
  await writeFile(join(dir, 'bad.md'), `see ${home}/notes and write to ${email}\n`);
  await writeFile(join(dir, 'ok.sh'), 'HOME="$root/home/.config" git -c user.email=smoke@example.invalid\nurl=https://user@knowledge.chaselubitz.com\nnpm i @openai/codex@0.164.0 knowledgebase@Overlord\n');
  await mkdir(join(dir, '.overlord')); await writeFile(join(dir, '.overlord', 'project.json'), `${home}\n`);
  assert.deepEqual(await audit(dir), [`bad.md:1: home path ${home}`, `bad.md:1: email address ${email}`]);
  assert.deepEqual(await audit(REPO_ROOT), []);
});
