#!/usr/bin/env node
// GitHub Actions helpers. Every subcommand also runs locally against disposable repos;
// see test/ci.test.mjs. Workflow event text reaches this file only as arguments or
// environment values, never as shell code.
//
//   baseline --sha <sha>                 verify an immutable PR base (validate.yml)
//   smoke-plan [--base <sha>]            choose bootstrap / fresh / compare native smoke
//   resolve-plugins --event <name>       PLUGIN_REQUEST env -> sorted source ids (ingest.yml)
//   prepare --plugins <json> --out <dir> ingest each id from HEAD, no credentials
//   verify-bundle --bundle <dir> --base <sha>
//   publish --bundle <dir> --base <sha>  commit, push sync/<id>, open or update the PR
//   audit [--root <dir>]                 personal paths and email addresses in the distribution
import { appendFile, cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { HOSTS, HOST_IDS, SOURCES_DIR } from './lib/policy.mjs';
import { discoverSources, isSourceId, readSource } from './lib/sources.mjs';
import { validateRepo } from './validate.mjs';
import { ingest } from './ingest.mjs';

// Plugins the native smoke harness (scripts/smoke.sh) knows how to install and check.
// A released plugin outside this list fails CI instead of being skipped.
export const SMOKE_PLUGINS = Object.freeze(['knowledgebase']);
export const SYNC_PREFIX = 'sync/';
const MARKER = 'overlord-ingest:v1';
const MAX_BODY = 60_000;
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

const exists = async p => !!(await stat(p).catch(e => e.code === 'ENOENT' ? null : Promise.reject(e)));
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, {encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 100_000_000, ...opts});
const git = (root, args, opts) => run('git', args, {cwd: root, ...opts}).trim();
const gh = (args, opts) => run('gh', args, opts);
// COPYFILE_DISABLE keeps macOS tar from adding AppleDouble (._*) entries.
const tar = args => run('tar', args, {env: {...process.env, COPYFILE_DISABLE: '1'}});

async function output(values) {
  const lines = Object.entries(values).map(([k, v]) => `${k}=${v}\n`).join('');
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, lines);
  else process.stdout.write(lines);
}
async function summary(text) {
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, text);
  else process.stderr.write(text);
}

export function verifyBaseline(root, sha) {
  if (!SHA.test(sha ?? '')) throw new Error('baseline must be a full commit SHA');
  if (git(root, ['rev-parse', '--verify', `${sha}^{commit}`]) !== sha) throw new Error('baseline is not an exact commit');
  try { git(root, ['merge-base', '--is-ancestor', sha, 'HEAD']); }
  catch { throw new Error('baseline is not an ancestor of the candidate; fetch full history or update the branch'); }
  return sha;
}

export async function smokePlan(root, base = null) {
  const result = await validateRepo(root);
  if (!result.ok) throw new Error(`candidate is invalid: ${result.errors.join('; ')}`);
  const unsupported = result.released.filter(id => !SMOKE_PLUGINS.includes(id));
  if (unsupported.length) throw new Error(`native smoke does not cover released plugin(s): ${unsupported.join(', ')}`);
  if (result.released.length === 0) return {mode: 'bootstrap', released: []};
  return {mode: base ? 'compare' : 'fresh', released: result.released, ...(base ? {base} : {})};
}

// Dispatch input is untrusted text: only an exact discovered source id, or "all" where allowed.
export async function resolvePlugins(root, event, request) {
  const found = await discoverSources(root);
  if (found.errors.length) throw new Error(found.errors.join('; '));
  const value = typeof request === 'string' ? request : '';
  if (event === 'repository_dispatch') {
    if (!isSourceId(value) || !found.sources.includes(value)) throw new Error('repository_dispatch requires client_payload.plugin naming one source id');
    return [value];
  }
  if (event === 'schedule' || value === '' || value === 'all') return found.sources;
  if (!isSourceId(value) || !found.sources.includes(value)) throw new Error('plugin must be "all" or a source id from sources/<id>.json');
  return [value];
}

// Paths one plugin's ingest may write, derived from the reviewed pointer at the base.
export async function ownedPaths(root, id) {
  const {json} = await readSource(root, id);
  return [...HOST_IDS.map(h => json.hosts[h].target), ...HOST_IDS.map(h => HOSTS[h].catalog), `${SOURCES_DIR}/${id}.lock.json`];
}
const within = (path, owned) => owned.some(o => path === o || path.startsWith(`${o}/`));

function statusPaths(root) {
  const out = run('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {cwd: root});
  const paths = [];
  const parts = out.split('\0').filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    paths.push(parts[i].slice(3));
    if (parts[i][0] === 'R' || parts[i][0] === 'C') paths.push(parts[++i]);
  }
  return paths;
}

const cell = text => String(text).replace(/[`|\r\n\u0000-\u001f]/g, '?').slice(0, 256);
export function prTitle(report, id) {
  return report.oldVersion ? `${id} ${report.oldVersion} → ${report.version}` : `${id}: first release ${report.version}`;
}
export function prBody(report, id, base) {
  const lines = [
    `<!-- ${MARKER} plugin=${id} version=${report.version} -->`,
    `## ${prTitle(report, id)}`,
    '',
    `Automated ingest of the public release artifacts declared in \`${SOURCES_DIR}/${id}.json\`.`,
    'Human review is required and there is no auto-merge. Merging to `main` releases this version;',
    'users receive it the next time they run the explicit refresh commands in README.md.',
    '',
    '| Field | Value |', '| --- | --- |',
    `| Version | ${report.oldVersion ? `${cell(report.oldVersion)} → ` : ''}${cell(report.version)} |`,
    ...(report.releaseId ? [`| Release id | \`${cell(report.releaseId)}\` |`] : []),
    `| Index SHA-256 | \`${cell(report.indexSha256)}\` |`,
    `| Source pointer SHA-256 | \`${cell(report.sourceSha256)}\` |`,
    `| Based on \`main\` | \`${cell(base)}\` |`,
    '',
    '| Host | Artifact | ZIP SHA-256 | Tree SHA-256 | Files | Changed |', '| --- | --- | --- | --- | --- | --- |',
    ...HOST_IDS.map(h => { const x = report.hosts[h], c = report.changedPaths?.[h]; return `| ${h} | ${cell(x.url)} | \`${cell(x.zipSha256)}\` | \`${cell(x.treeSha256)}\` | ${cell(x.fileCount)} | ${cell(c?.count ?? '?')} |`; }),
    '',
    '### Changed files',
    '',
    ...HOST_IDS.flatMap(h => { const c = report.changedPaths?.[h]; return [`**${h}** (${cell(c?.count ?? 0)}; first 50 listed)`, '', ...(c?.paths ?? []).map(p => `- \`${cell(p)}\``), '']; }),
    'Review the skill diffs in **Files changed**. The `validate` check must pass before merging;',
    'rebase and revalidate if `main` has moved.',
  ];
  return lines.join('\n').slice(0, MAX_BODY) + '\n';
}

// Ingest each plugin in its own worktree of HEAD. Writes <out>/manifest.json and, for
// updated plugins, <out>/<id>/{payload.tar,report.json,title.txt,body.md}.
export async function prepare(root, ids, out, {fetcher} = {}) {
  const base = git(root, ['rev-parse', 'HEAD']);
  await mkdir(out, {recursive: true});
  const plugins = [];
  for (const id of ids) {
    const wt = await mkdtemp(join(tmpdir(), `ingest-${id}-`));
    await rm(wt, {recursive: true});
    git(root, ['worktree', 'add', '--quiet', '--detach', wt, base]);
    try {
      const report = await ingest(wt, id, fetcher ? {fetcher} : {});
      if (report.status === 'up-to-date') { plugins.push({id, status: 'up-to-date', version: report.version, zipChanged: report.zipChanged}); continue; }
      if (report.status !== 'updated') throw new Error(`unexpected ingest status ${report.status}`);
      const owned = await ownedPaths(wt, id);
      const stray = statusPaths(wt).filter(p => !within(p, owned));
      if (stray.length) throw new Error(`ingest changed paths it does not own: ${stray.slice(0, 20).join(', ')}`);
      const dir = join(out, id);
      await mkdir(dir, {recursive: true});
      const present = [];
      for (const p of owned) if (await exists(join(wt, p))) present.push(p);
      tar(['-cf', join(dir, 'payload.tar'), '-C', wt, '--', ...present]);
      await writeFile(join(dir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
      await writeFile(join(dir, 'title.txt'), `${prTitle(report, id)}\n`);
      await writeFile(join(dir, 'body.md'), prBody(report, id, base));
      plugins.push({id, status: 'updated', version: report.version, oldVersion: report.oldVersion});
    } catch (e) {
      plugins.push({id, status: 'error', error: String(e.message).slice(0, 2000)});
    } finally {
      git(root, ['worktree', 'remove', '--force', wt]);
    }
  }
  const manifest = {bundleVersion: 1, base, plugins};
  await writeFile(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export function prepareSummary(manifest) {
  const rows = manifest.plugins.map(p => `| ${p.id} | ${p.status} | ${cell(p.oldVersion ? `${p.oldVersion} → ${p.version}` : p.version ?? '')} | ${cell(p.error ?? (p.zipChanged?.length ? `ZIP bytes changed without a tree change: ${p.zipChanged.join(', ')}` : ''))} |`);
  return ['### Ingest', '', `Base \`${manifest.base}\``, '', '| Plugin | Status | Version | Detail |', '| --- | --- | --- | --- |', ...rows, ''].join('\n') + '\n';
}

// Check a bundle against the reviewed pointers at <base> before applying it anywhere.
async function readBundle(root, bundle, base) {
  const manifest = JSON.parse(await readFile(join(bundle, 'manifest.json'), 'utf8'));
  if (manifest.bundleVersion !== 1 || manifest.base !== base) throw new Error('bundle was not prepared from this base');
  const {sources} = await discoverSources(root);
  const updated = manifest.plugins.filter(p => p.status === 'updated');
  for (const p of updated) if (!isSourceId(p.id) || !sources.includes(p.id)) throw new Error('bundle names an unknown source');
  return updated;
}
async function applyPayload(root, bundle, id) {
  const owned = await ownedPaths(root, id);
  const file = join(bundle, id, 'payload.tar');
  for (const line of tar(['-tvf', file]).split('\n').filter(Boolean)) {
    if (!'-d'.includes(line[0])) throw new Error(`payload contains a non-regular entry: ${cell(line)}`);
  }
  for (const name of tar(['-tf', file]).split('\n').filter(Boolean)) {
    const path = name.replace(/\/$/, '');
    if (path.startsWith('/') || path.split('/').some(s => s === '..' || s === '.' || s === '') || !(within(path, owned) || owned.some(o => o.startsWith(`${path}/`)))) throw new Error(`payload path outside ${id}'s generated files: ${cell(name)}`);
  }
  const tmp = await mkdtemp(join(tmpdir(), `payload-${id}-`));
  try {
    tar(['-xf', file, '-C', tmp]);
    for (const p of owned) {
      await rm(join(root, p), {recursive: true, force: true});
      if (await exists(join(tmp, p))) await cp(join(tmp, p), join(root, p), {recursive: true});
    }
  } finally { await rm(tmp, {recursive: true, force: true}); }
  const stray = statusPaths(root).filter(p => !within(p, owned));
  if (stray.length) throw new Error(`applying ${id} changed unowned paths: ${stray.slice(0, 20).join(', ')}`);
  const result = await validateRepo(root);
  if (!result.ok) throw new Error(`${id} candidate is invalid: ${result.errors.join('; ')}`);
  return owned;
}
function requireClean(root, base) {
  if (git(root, ['rev-parse', 'HEAD']) !== base) throw new Error('checkout HEAD is not the bundle base');
  if (statusPaths(root).length) throw new Error('checkout has uncommitted changes; publish runs only in a clean CI checkout');
}

export async function verifyBundle(root, bundle, base) {
  requireClean(root, base);
  const updated = await readBundle(root, bundle, base);
  for (const {id} of updated) {
    const wt = await mkdtemp(join(tmpdir(), `verify-${id}-`));
    await rm(wt, {recursive: true});
    git(root, ['worktree', 'add', '--quiet', '--detach', wt, base]);
    try { await applyPayload(wt, bundle, id); }
    finally { git(root, ['worktree', 'remove', '--force', wt]); }
  }
  return updated.map(p => p.id);
}

function authEnv() {
  const env = {...process.env, GIT_TERMINAL_PROMPT: '0'};
  const token = process.env.GH_TOKEN;
  if (token) {
    const n = Number(env.GIT_CONFIG_COUNT ?? 0);
    env.GIT_CONFIG_COUNT = String(n + 1);
    env[`GIT_CONFIG_KEY_${n}`] = 'http.https://github.com/.extraheader';
    env[`GIT_CONFIG_VALUE_${n}`] = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
  }
  return env;
}

// Publish verified bundles as bot-owned sync/<id> branches and PRs. The branch is rebuilt
// from <base>; an existing branch is replaced only when every commit on it is the bot's.
export async function publish(root, bundle, base, {slug = process.env.APP_SLUG, repo = process.env.GITHUB_REPOSITORY} = {}) {
  if (!slug || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(slug)) throw new Error('APP_SLUG is missing or invalid');
  if (!repo || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error('GITHUB_REPOSITORY is missing or invalid');
  requireClean(root, base);
  const updated = await readBundle(root, bundle, base);
  const env = authEnv();
  const userId = JSON.parse(gh(['api', `users/${slug}[bot]`])).id;
  if (!Number.isInteger(userId)) throw new Error('could not resolve the App bot user');
  const name = `${slug}[bot]`, email = `${userId}+${slug}[bot]@users.noreply.github.com`;
  const botLogins = [`app/${slug}`, name];
  const results = [];
  for (const {id} of updated) {
    const branch = `${SYNC_PREFIX}${id}`;
    const report = JSON.parse(await readFile(join(bundle, id, 'report.json'), 'utf8'));
    const title = (await readFile(join(bundle, id, 'title.txt'), 'utf8')).trim();
    const bodyFile = join(bundle, id, 'body.md');
    try {
      const owned = await applyPayload(root, bundle, id);
      git(root, ['add', '-A', '--', ...owned]);
      git(root, ['commit', '--quiet', '--no-verify', '-m', title, '-m', `<!-- ${MARKER} plugin=${id} version=${report.version} -->`], {env: {...process.env, GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email}});
      const commit = git(root, ['rev-parse', 'HEAD']), tree = git(root, ['rev-parse', 'HEAD^{tree}']);
      const prs = JSON.parse(gh(['pr', 'list', '--repo', repo, '--head', branch, '--state', 'all', '--limit', '50', '--json', 'number,state,author,body,isCrossRepository'])).filter(p => !p.isCrossRepository);
      const open = prs.find(p => p.state === 'OPEN');
      if (open && !botLogins.includes(open.author?.login)) throw new Error(`open PR #${open.number} on ${branch} was not opened by ${name}; leaving it for a maintainer`);
      if (!open && prs.some(p => p.state === 'CLOSED' && String(p.body ?? '').includes(`${MARKER} plugin=${id} version=${report.version} `))) {
        results.push({id, action: 'skipped', detail: `a PR for ${id} ${report.version} was closed without merging; publish a higher upstream version or reopen it`});
        continue;
      }
      const remote = git(root, ['ls-remote', 'origin', `refs/heads/${branch}`], {env}).split(/\s/)[0] || '';
      let pushed = false;
      if (remote) {
        git(root, ['fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`], {env});
        const foreign = git(root, ['log', '--format=%H %ae %ce', `${base}..${remote}`]).split('\n').filter(Boolean).filter(l => { const [, a, c] = l.split(' '); return a !== email || c !== email; });
        if (foreign.length) throw new Error(`${branch} has commits not made by ${name}; leaving it for a maintainer`);
      }
      if (!(remote && git(root, ['rev-parse', `${remote}^{tree}`]) === tree && git(root, ['rev-parse', `${remote}^`]) === base)) {
        git(root, ['push', '--quiet', `--force-with-lease=refs/heads/${branch}:${remote}`, 'origin', `${commit}:refs/heads/${branch}`], {env});
        pushed = true;
      }
      if (open) gh(['pr', 'edit', String(open.number), '--repo', repo, '--title', title, '--body-file', bodyFile]);
      else gh(['pr', 'create', '--repo', repo, '--base', 'main', '--head', branch, '--title', title, '--body-file', bodyFile]);
      results.push({id, action: open ? 'updated PR' : 'opened PR', detail: pushed ? `pushed ${branch}` : `${branch} already current`});
    } catch (e) {
      results.push({id, action: 'error', detail: String(e.message).slice(0, 2000)});
    } finally {
      git(root, ['reset', '--quiet', '--hard', base]);
      git(root, ['clean', '-fdq', '--', ...(await ownedPaths(root, id))]);
    }
  }
  return results;
}

// Personal data that must never ship: absolute home paths and real email addresses.
const HOME_PATH = /(?<![\w$}.-])\/(?:Users|home)\/[A-Za-z0-9_][A-Za-z0-9._-]*/g;
const EMAIL = /(?<![\w.%+-]|:\/\/)[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g;
const ALLOWED_EMAIL = /@(?:example\.invalid|users\.noreply\.github\.com)$/;
export async function audit(root) {
  const files = run('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {cwd: root}).split('\0').filter(f => f && !f.startsWith('.overlord/'));
  const findings = [];
  for (const file of files) {
    let text;
    try { text = await readFile(join(root, file), 'utf8'); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    if (text.includes('\u0000')) continue;
    text.split('\n').forEach((line, i) => {
      for (const m of line.matchAll(HOME_PATH)) findings.push(`${file}:${i + 1}: home path ${cell(m[0])}`);
      for (const m of line.matchAll(EMAIL)) if (!ALLOWED_EMAIL.test(m[0])) findings.push(`${file}:${i + 1}: email address ${cell(m[0])}`);
    });
  }
  return findings;
}

function flags(argv, allowed) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, '');
    if (!argv[i].startsWith('--') || !allowed.includes(key) || argv[i + 1] === undefined) throw new Error(`unexpected argument ${JSON.stringify(argv[i])}`);
    out[key] = argv[++i];
  }
  return out;
}

async function main([command, ...argv]) {
  const root = process.cwd();
  try {
    if (command === 'baseline') {
      const {sha} = flags(argv, ['sha']);
      await output({base: verifyBaseline(root, sha)});
    } else if (command === 'smoke-plan') {
      const {base = null} = flags(argv, ['base']);
      if (base) verifyBaseline(root, base);
      const plan = await smokePlan(root, base);
      console.error(JSON.stringify(plan));
      await output({mode: plan.mode});
    } else if (command === 'resolve-plugins') {
      const {event} = flags(argv, ['event']);
      const ids = await resolvePlugins(root, event, process.env.PLUGIN_REQUEST);
      await output({plugins: JSON.stringify(ids)});
    } else if (command === 'prepare') {
      const {plugins, out} = flags(argv, ['plugins', 'out']);
      const ids = JSON.parse(plugins);
      if (!Array.isArray(ids) || ids.some(id => !isSourceId(id))) throw new Error('plugins must be a JSON array of source ids');
      const manifest = await prepare(root, ids, resolve(out));
      await summary(prepareSummary(manifest));
      await output({base: manifest.base, publish: String(manifest.plugins.some(p => p.status === 'updated')), failed: String(manifest.plugins.some(p => p.status === 'error'))});
    } else if (command === 'verify-bundle') {
      const {bundle, base} = flags(argv, ['bundle', 'base']);
      console.log(`verified: ${(await verifyBundle(root, resolve(bundle), base)).join(', ')}`);
    } else if (command === 'publish') {
      const {bundle, base} = flags(argv, ['bundle', 'base']);
      const results = await publish(root, resolve(bundle), base);
      await summary(['### Publish', '', '| Plugin | Action | Detail |', '| --- | --- | --- |', ...results.map(r => `| ${r.id} | ${r.action} | ${cell(r.detail)} |`), ''].join('\n') + '\n');
      if (results.some(r => r.action === 'error')) return 1;
    } else if (command === 'audit') {
      const {root: dir = root} = flags(argv, ['root']);
      const findings = await audit(resolve(dir));
      for (const f of findings) console.error(`error: ${f}`);
      console.log(findings.length ? `audit: ${findings.length} finding(s)` : 'audit: ok');
      if (findings.length) return 1;
    } else {
      console.error('usage: node scripts/ci.mjs <baseline|smoke-plan|resolve-plugins|prepare|verify-bundle|publish|audit> [options]');
      return 2;
    }
    return 0;
  } catch (e) {
    console.error(`ci ${command}: ${String(e.message).slice(0, 4000)}`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
