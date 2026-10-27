import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { expectedEntry } from '../scripts/lib/catalog.mjs';
import { sha256Hex } from '../scripts/lib/sources.mjs';
import { validateRepo } from '../scripts/validate.mjs';
import { fixtureRepo, REPO_ROOT, repoSource } from './helpers.mjs';

const CODEX = '.agents/plugins/marketplace.json';
const CLAUDE = '.claude-plugin/marketplace.json';
const LEGACY = 'policy/legacy-entries.json';

const failsWith = async (repo, fragment) => {
  const result = await validateRepo(repo.root);
  assert.equal(result.ok, false, `expected failure containing "${fragment}"`);
  assert.ok(result.errors.some((e) => e.includes(fragment)), `no error contains "${fragment}":\n${result.errors.join('\n')}`);
  return result;
};

async function lockFor(repo, overrides = {}) {
  const bytes = await readFile(repo.path('sources/knowledgebase.json'));
  const host = (name) => ({ url: `https://knowledge.chaselubitz.com/plugins/${name}.zip`, zipSha256: 'a'.repeat(64), treeSha256: 'b'.repeat(64), fileCount: 5 });
  return {
    lockVersion: 1,
    plugin: 'knowledgebase',
    version: '0.1.1',
    sourceSha256: sha256Hex(bytes),
    indexSha256: 'c'.repeat(64),
    fetchedAt: '2026-10-27T11:23:19Z',
    hosts: { codex: host('knowledgebase-chatgpt'), 'claude-code': host('knowledgebase-claude-code') },
    ...overrides,
  };
}

test('the repository itself validates in its current release state', async () => {
  const result = await validateRepo(REPO_ROOT);
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
  assert.ok(['bootstrap', 'released'].includes(result.state));
});

test('fixture copy of the bootstrap validates', async () => {
  const repo = await fixtureRepo();
  const result = await validateRepo(repo.root);
  assert.deepEqual(result.errors, []);
  assert.equal(result.state, 'bootstrap');
});

test('catalog name is exactly Overlord in both hosts', async () => {
  const repo = await fixtureRepo();
  await repo.edit(CODEX, (c) => { c.name = 'overlord'; });
  await failsWith(repo, 'name must be exactly "Overlord"');
  const other = await fixtureRepo();
  await other.edit(CLAUDE, (c) => { c.name = 'overlord-local'; });
  await failsWith(other, 'name must be exactly "Overlord"');
});

test('missing or malformed catalogs fail rather than bootstrapping', async () => {
  const repo = await fixtureRepo();
  await repo.write(CLAUDE, '{ "name": ');
  await failsWith(repo, 'invalid JSON');
  const missing = await fixtureRepo();
  await missing.write(CODEX, '');
  await failsWith(missing, 'invalid JSON');
});

test('an entry for a source without a lock is rejected', async () => {
  const repo = await fixtureRepo();
  const source = await repoSource();
  await repo.edit(CODEX, (c) => { c.plugins.push(expectedEntry('codex', source)); });
  await repo.edit(CLAUDE, (c) => { c.plugins.push(expectedEntry('claude-code', source)); });
  await failsWith(repo, 'has no lock');
});

test('an entry owned by neither a source nor the legacy policy is rejected', async () => {
  const repo = await fixtureRepo();
  await repo.edit(CLAUDE, (c) => { c.plugins.push({ name: 'stray', source: './stray' }); });
  await failsWith(repo, 'owned by neither a source nor');
});

test('legacy entries are preserved exactly', async () => {
  const entry = { name: 'scribe', source: { source: 'github', repo: 'example/scribe' }, description: 'kept' };
  const repo = await fixtureRepo();
  await repo.edit(LEGACY, (p) => { p.entries.push({ host: 'claude-code', reason: 'predates source ingest', entry }); });
  await repo.edit(CLAUDE, (c) => { c.plugins.push(entry); });
  assert.deepEqual((await validateRepo(repo.root)).errors, []);

  await repo.edit(CLAUDE, (c) => { c.plugins[0].description = 'rewritten'; });
  await failsWith(repo, 'legacy entry "scribe" was changed');

  await repo.edit(CLAUDE, (c) => { c.plugins = []; });
  await failsWith(repo, 'legacy entry "scribe" was removed');
});

test('legacy entries cannot claim generated paths or source names', async () => {
  const repo = await fixtureRepo();
  const entry = { name: 'other', source: './plugins/claude-code/other' };
  await repo.edit(LEGACY, (p) => { p.entries.push({ host: 'claude-code', reason: 'x', entry }); });
  await repo.edit(CLAUDE, (c) => { c.plugins.push(entry); });
  await failsWith(repo, 'may not point into plugins/');

  const named = await fixtureRepo();
  const kb = { name: 'knowledgebase', source: './elsewhere' };
  await named.edit(LEGACY, (p) => { p.entries.push({ host: 'claude-code', reason: 'x', entry: kb }); });
  await failsWith(named, 'collides with source');
});

test('hand-added generated directories are unowned', async () => {
  const repo = await fixtureRepo();
  await repo.write('plugins/codex/knowledgebase/plugin.json', '{}\n');
  await failsWith(repo, 'not owned by a locked source');

  const stray = await fixtureRepo();
  await stray.write('plugins/cursor/x/plugin.json', '{}\n');
  await failsWith(stray, 'unexpected entry');

  const file = await fixtureRepo();
  await file.write('plugins/codex/README.md', 'x\n');
  await failsWith(file, 'unexpected non-directory entry');
});

test('locks need a source, a matching source digest and on-origin URLs', async () => {
  const orphan = await fixtureRepo();
  await orphan.writeJson('sources/other.lock.json', { plugin: 'other' });
  await failsWith(orphan, 'lock has no source pointer');

  const drift = await fixtureRepo();
  await drift.writeJson('sources/knowledgebase.lock.json', await lockFor(drift, { sourceSha256: 'd'.repeat(64) }));
  await failsWith(drift, 'sourceSha256 does not match');

  const offOrigin = await fixtureRepo();
  const lock = await lockFor(offOrigin);
  lock.hosts.codex.url = 'https://mirror.example.com/knowledgebase-chatgpt.zip';
  await offOrigin.writeJson('sources/knowledgebase.lock.json', lock);
  await failsWith(offOrigin, 'hosts.codex.url must be an HTTPS URL on');

  const badVersion = await fixtureRepo();
  await badVersion.writeJson('sources/knowledgebase.lock.json', await lockFor(badVersion, { version: '01.0.0' }));
  await failsWith(badVersion, '$.version');
});

test('a malformed release fails package verification', async () => {
  const repo = await fixtureRepo();
  const source = await repoSource();
  await repo.writeJson('sources/knowledgebase.lock.json', await lockFor(repo));
  await repo.edit(CODEX, (c) => { c.plugins.push(expectedEntry('codex', source)); });
  await repo.edit(CLAUDE, (c) => { c.plugins.push(expectedEntry('claude-code', source)); });
  await repo.write('plugins/codex/knowledgebase/plugin.json', '{}\n');
  await repo.write('plugins/claude-code/knowledgebase/.claude-plugin/plugin.json', '{}\n');
  const result = await failsWith(repo, 'tree digest or file count differs from lock');
  assert.equal(result.state, 'released');
});

test('a locked source needs both packages and both catalog entries', async () => {
  const repo = await fixtureRepo();
  const source = await repoSource();
  await repo.writeJson('sources/knowledgebase.lock.json', await lockFor(repo));
  await repo.edit(CODEX, (c) => { c.plugins.push(expectedEntry('codex', source)); });
  await repo.write('plugins/codex/knowledgebase/plugin.json', '{}\n');
  await failsWith(repo, '.claude-plugin/marketplace.json: locked source "knowledgebase" has no catalog entry');
  await failsWith(repo, 'plugins/claude-code/knowledgebase: locked source has no generated package');
});

test('a source-owned entry must equal its derived entry', async () => {
  const repo = await fixtureRepo();
  const source = await repoSource();
  await repo.writeJson('sources/knowledgebase.lock.json', await lockFor(repo));
  const entry = expectedEntry('codex', source);
  entry.source.path = './plugins/claude-code/knowledgebase';
  await repo.edit(CODEX, (c) => { c.plugins.push(entry); });
  await failsWith(repo, 'differs from the entry derived from');
});

test('stray files under sources/ are rejected', async () => {
  const repo = await fixtureRepo();
  await repo.write('sources/notes.txt', 'x\n');
  await failsWith(repo, 'sources/notes.txt: not a valid source');
  const upper = await fixtureRepo();
  await upper.writeJson('sources/Other.json', {});
  await failsWith(upper, 'not a valid source');
});

test('an invalid source pointer is reported', async () => {
  const repo = await fixtureRepo();
  await repo.edit('sources/knowledgebase.json', (s) => { s.allowedMcpUrls = ['https://evil.example.com/mcp']; });
  await failsWith(repo, 'is not on an allowed MCP origin');
});

test('CLI exit codes', () => {
  const run = (...args) => spawnSync(process.execPath, [join(REPO_ROOT, 'scripts/validate.mjs'), ...args], { encoding: 'utf8' });
  const ok = run('--root', REPO_ROOT, '--json');
  assert.equal(ok.status, 0, ok.stderr);
  assert.ok(['bootstrap', 'released'].includes(JSON.parse(ok.stdout).state));
  assert.equal(run('--frobnicate').status, 2);
  assert.equal(run('--base', 'HEAD').status, 2);
});

test('smoke rejects missing arguments before creating client state', () => {
  const smoke = spawnSync('bash', [join(REPO_ROOT, 'scripts/smoke.sh')], { encoding: 'utf8' });
  assert.equal(smoke.status, 2);
});
