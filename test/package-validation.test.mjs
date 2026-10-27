import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { expectedEntry } from '../scripts/lib/catalog.mjs';
import { treeDigest } from '../scripts/lib/digest.mjs';
import { sha256Hex } from '../scripts/lib/sources.mjs';
import { validateRepo, compareBase } from '../scripts/validate.mjs';
import { fixtureRepo, repoSource } from './helpers.mjs';

async function release(repo, version = '1.0.0') {
  const source = await repoSource();
  const lock = {lockVersion:1, plugin:'knowledgebase', version, sourceSha256:sha256Hex(await readFile(repo.path('sources/knowledgebase.json'))), indexSha256:'a'.repeat(64), fetchedAt:'2026-10-27T11:23:19Z', hosts:{}};
  for (const host of ['codex', 'claude-code']) {
    const target = `plugins/${host}/knowledgebase`;
    for (const name of ['knowledgebase','feature-ranking','feature-handoff']) await repo.write(`${target}/skills/${name}/SKILL.md`, `---\nname: ${name}\ndescription: A skill\n---\nBody\n`);
    const mcp = {mcpServers:{knowledgebase:{type:host === 'codex' ? 'streamable-http' : 'http', url:'https://knowledge.chaselubitz.com/mcp'}}};
    const manifest = {name:'knowledgebase',version,description:'Example'};
    if (host === 'codex') { manifest.extensions = {'com.openai':{interface:{logo:'./assets/logo.png'}}}; await repo.write(`${target}/assets/logo.png`, 'image'); }
    else manifest.mcpServers = './.mcp.json';
    await repo.writeJson(`${target}/${source.hosts[host].manifest}`, manifest);
    await repo.writeJson(`${target}/${host === 'codex' ? 'mcp.json' : '.mcp.json'}`, mcp);
    const tree = await treeDigest(repo.path(target));
    lock.hosts[host] = {url:`https://knowledge.chaselubitz.com/plugins/${host}.zip`,zipSha256:'a'.repeat(64),treeSha256:tree.sha256,fileCount:tree.fileCount};
    const catalog = host === 'codex' ? '.agents/plugins/marketplace.json' : '.claude-plugin/marketplace.json';
    await repo.edit(catalog, c => { c.plugins = [expectedEntry(host, source)]; });
  }
  await repo.writeJson('sources/knowledgebase.lock.json', lock);
}
async function errors(repo) { return (await validateRepo(repo.root)).errors.join('\n'); }
async function rehash(repo, host) {
  const tree = await treeDigest(repo.path(`plugins/${host}/knowledgebase`));
  await repo.edit('sources/knowledgebase.lock.json', lock => {lock.hosts[host].treeSha256 = tree.sha256; lock.hosts[host].fileCount = tree.fileCount;});
}
test('complete portable and legacy packages validate; drift and cross-host skills fail', async () => {
  const repo = await fixtureRepo(); await release(repo);
  assert.equal(await errors(repo), '');
  await repo.write('plugins/codex/knowledgebase/skills/knowledgebase/SKILL.md', '---\nname: knowledgebase\ndescription: changed\n---\n');
  assert.match(await errors(repo), /tree digest/);
  await rehash(repo, 'codex'); assert.match(await errors(repo), /host skill bytes differ/);
});
for (const [name, mutate, expected] of [
  ['foreign MCP', async r => r.edit('plugins/codex/knowledgebase/mcp.json', x => {x.mcpServers.knowledgebase.url='https://evil.example/mcp';}), /invalid MCP/],
  ['inline override', async r => r.edit('plugins/codex/knowledgebase/plugin.json', x => {x.mcpServers={evil:{type:'stdio',command:'run'}};}), /forbidden executable surface|invalid MCP/],
  ['unsafe nested reference', async r => r.edit('plugins/codex/knowledgebase/plugin.json', x => {x.extensions['com.openai'].interface.logo='./../secret';}), /unsafe local reference/],
  ['placeholder', async r => r.write('plugins/codex/knowledgebase/note.txt','{{VALUE}}'), /placeholder/],
  ['denylist', async r => r.write('plugins/codex/knowledgebase/.env.production','x'), /denylisted/],
  ['secret', async r => r.write('plugins/codex/knowledgebase/note.txt','ghp_abcdefghijklmnopqrstuvwxyz123456'), /secret pattern/],
  ['hook', async r => r.edit('plugins/codex/knowledgebase/plugin.json', x => {x.hooks={};}), /forbidden executable surface/],
]) test(`rejects ${name}`, async () => { const repo=await fixtureRepo(); await release(repo); await mutate(repo); await rehash(repo,'codex'); assert.match(await errors(repo),expected); });

test('immutable base distinguishes first addition, unchanged, changed bytes and higher version', async () => {
  const repo = await fixtureRepo();
  const git = (...args) => execFileSync('git', args, {cwd:repo.root, encoding:'utf8'}).trim();
  git('init','-q'); git('config','user.email','fixture@example.invalid'); git('config','user.name','Fixture'); git('add','.'); git('commit','-qm','bootstrap');
  const bootstrap=git('rev-parse','HEAD');
  await release(repo); assert.match((await compareBase(repo.root, bootstrap)).notes.join(), /first addition/);
  git('add','.'); git('commit','-qm','release'); const base=git('rev-parse','HEAD');
  assert.match((await compareBase(repo.root, base)).notes.join(), /unchanged/);
  await repo.write('plugins/codex/knowledgebase/extra.txt','changed');
  assert.match((await compareBase(repo.root, base)).errors.join(), /without an increased version/);
  await repo.edit('sources/knowledgebase.lock.json', x => {x.version='1.0.1';});
  assert.equal((await compareBase(repo.root, base)).errors.length, 0);
  await assert.rejects(compareBase(repo.root, 'HEAD'), /immutable/);
});

test('rejects a second convention MCP declaration, executable files and missing local catalog paths', async () => {
  const repo = await fixtureRepo(); await release(repo);
  await repo.writeJson('plugins/codex/knowledgebase/.mcp.json', {mcpServers:{extra:{type:'streamable-http',url:'https://evil.example/mcp'}}});
  await rehash(repo,'codex'); assert.match(await errors(repo), /invalid MCP server/);
  await repo.write('plugins/codex/knowledgebase/scripts/run.sh','echo nope');
  await rehash(repo,'codex'); assert.match(await errors(repo), /forbidden executable file/);
  await repo.edit('.claude-plugin/marketplace.json', c => {c.plugins[0].source='./missing';});
  assert.match(await errors(repo), /local source .* does not exist/);
});
