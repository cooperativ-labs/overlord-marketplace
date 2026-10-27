import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fixtureRepo } from './helpers.mjs';
import { ingest } from '../scripts/ingest.mjs';
import { validateRepo } from '../scripts/validate.mjs';
import { sha256Hex } from '../scripts/lib/sources.mjs';

async function artifacts(repo, version, body = 'Body') {
  const origin = 'https://knowledge.chaselubitz.com';
  const zips = {};
  for (const host of ['codex','claude-code']) {
    const files = {};
    const prefix = host === 'codex' ? 'knowledgebase/' : '';
    const manifest = {name:'knowledgebase',version,description:'Example'};
    if (host === 'codex') { manifest.extensions = {'com.openai':{interface:{logo:'./assets/logo.png'}}}; files[`${prefix}assets/logo.png`] = 'image'; }
    else manifest.mcpServers = './.mcp.json';
    files[prefix + (host === 'codex' ? 'plugin.json' : '.claude-plugin/plugin.json')] = JSON.stringify(manifest);
    files[prefix + (host === 'codex' ? 'mcp.json' : '.mcp.json')] = JSON.stringify({mcpServers:{knowledgebase:{type:host === 'codex' ? 'streamable-http' : 'http',url:origin+'/mcp'}}});
    for (const name of ['knowledgebase','feature-ranking','feature-handoff']) files[`${prefix}skills/${name}/SKILL.md`] = `---\nname: ${name}\ndescription: A skill\n---\n${body}\n`;
    const zip = join(repo.root, `${host}.zip`);
    execFileSync('python3',['-c',"import json,sys,zipfile\nf=json.loads(sys.stdin.read())\nwith zipfile.ZipFile(sys.argv[1],'w') as z:\n for k,v in f.items(): z.writestr(k,v)",zip], {input:JSON.stringify(files)});
    zips[host] = await readFile(zip);
  }
  const index = {version,codex:{plugin_package:`${origin}/plugins/codex.zip`,plugin_package_sha256:sha256Hex(zips.codex)},claude:{claude_code:{plugin_package:`${origin}/plugins/claude-code.zip`,plugin_package_sha256:sha256Hex(zips['claude-code'])}}};
  const fetcher = async url => {
    if (url.endsWith('index.json')) return new Response(JSON.stringify(index), {headers:{'content-type':'application/json'}});
    const host = url.endsWith('/codex.zip') ? 'codex' : 'claude-code';
    return new Response(zips[host], {headers:{'content-type':'application/zip'}});
  };
  return {index, zips, fetcher};
}
async function snapshot(repo) {
  const paths = ['.agents/plugins/marketplace.json','.claude-plugin/marketplace.json','sources/knowledgebase.lock.json','plugins/codex/knowledgebase','plugins/claude-code/knowledgebase'];
  const result = {};
  for (const p of paths) {
    try { result[p] = execFileSync('python3',['-c',"import hashlib,os,sys\np=sys.argv[1]\nif os.path.isdir(p):\n print(''.join(x+':'+hashlib.sha256(open(os.path.join(r,x),'rb').read()).hexdigest()+'\\n' for r,ds,fs in os.walk(p) for x in sorted(fs)))\nelse: print(hashlib.sha256(open(p,'rb').read()).hexdigest())",repo.path(p)],{encoding:'utf8',stdio:['ignore','pipe','ignore']}); } catch { result[p] = null; }
  }
  return result;
}
test('first release, no-op, dry-run, version and rollback at each replacement', async () => {
  const repo=await fixtureRepo(), a=await artifacts(repo,'1.0.0');
  assert.equal((await ingest(repo.root,'knowledgebase',{fetcher:a.fetcher})).status,'updated');
  assert.equal((await validateRepo(repo.root)).ok,true);
  const before=await snapshot(repo);
  assert.equal((await ingest(repo.root,'knowledgebase',{fetcher:a.fetcher})).status,'up-to-date');
  assert.deepEqual(await snapshot(repo),before);
  const b=await artifacts(repo,'1.1.0','new');
  assert.equal((await ingest(repo.root,'knowledgebase',{fetcher:b.fetcher,dryRun:true})).status,'dry-run');
  assert.deepEqual(await snapshot(repo),before);
  for(let i=0;i<5;i++) {
    await assert.rejects(ingest(repo.root,'knowledgebase',{fetcher:b.fetcher,beforeReplace: async n => {if(n===i) throw new Error('injected');}}),/injected/);
    assert.deepEqual(await snapshot(repo),before);
  }
  const changed=await artifacts(repo,'1.0.0','changed');
  await assert.rejects(ingest(repo.root,'knowledgebase',{fetcher:changed.fetcher}),/without a version bump/);
  const lower=await artifacts(repo,'0.9.0'); await assert.rejects(ingest(repo.root,'knowledgebase',{fetcher:lower.fetcher}),/decreased/);
  assert.equal((await ingest(repo.root,'knowledgebase',{fetcher:b.fetcher})).status,'updated');
});
test('host B failure, checksum, race and URL violations do not publish', async () => {
  const repo=await fixtureRepo(), a=await artifacts(repo,'1.0.0'), before=await snapshot(repo);
  await assert.rejects(ingest(repo.root,'knowledgebase',{fetcher:async url => url.endsWith('claude-code.zip') ? new Response('bad',{status:500}) : a.fetcher(url)}),/HTTP status/);
  assert.deepEqual(await snapshot(repo),before);
  a.index.codex.plugin_package_sha256='0'.repeat(64);
  await assert.rejects(ingest(repo.root,'knowledgebase',{fetcher:a.fetcher}),/checksum mismatch/);
  a.index.codex.plugin_package_sha256=sha256Hex(a.zips.codex);
  let calls=0;
  await assert.rejects(ingest(repo.root,'knowledgebase',{fetcher:async url => {if(url.endsWith('index.json') && ++calls===2) a.index.version='1.0.1'; return a.fetcher(url);}}),/release fields changed/);
  a.index.codex.plugin_package='https://evil.example/file.zip';
  await assert.rejects(ingest(repo.root,'knowledgebase',{fetcher:a.fetcher}),/reviewed origin/);
  assert.deepEqual(await snapshot(repo),before);
});
test('unknown source fails before network', async () => {
  const repo=await fixtureRepo(); await assert.rejects(ingest(repo.root,'../bad',{fetcher:async()=>{throw Error('network called');}}),/unknown source/);
});

test('interruption at every replacement is recovered on next invocation', async () => {
  const repo=await fixtureRepo(), a=await artifacts(repo,'1.0.0'), b=await artifacts(repo,'1.1.0','upgrade');
  await ingest(repo.root,'knowledgebase',{fetcher:a.fetcher});
  const before=await snapshot(repo);
  const data={index:b.index, codex:b.zips.codex.toString('base64'), claude:b.zips['claude-code'].toString('base64')};
  await writeFile(repo.path('fixture.json'),JSON.stringify(data));
  const moduleUrl=new URL('../scripts/ingest.mjs',import.meta.url).href;
  const code=`import {ingest} from ${JSON.stringify(moduleUrl)}; import {readFile} from 'node:fs/promises';
    const d=JSON.parse(await readFile('fixture.json')); const fetcher=async u=>u.endsWith('index.json')?new Response(JSON.stringify(d.index),{headers:{'content-type':'application/json'}}):new Response(Buffer.from(u.endsWith('/codex.zip')?d.codex:d.claude,'base64'),{headers:{'content-type':'application/zip'}});
    await ingest(process.cwd(),'knowledgebase',{fetcher,beforeReplace:async i=>{if(i===Number(process.argv[1])) process.exit(91)}});`;
  for(let i=0;i<=5;i++) {
    const run=spawnSync(process.execPath,['--input-type=module','-e',code,String(i)],{cwd:repo.root,encoding:'utf8'});
    assert.equal(run.status,91,run.stderr);
    // Recovery runs before fetching; an intentionally failed fetch leaves restored bytes.
    await assert.rejects(ingest(repo.root,'knowledgebase',{fetcher:async()=>{throw Error('stop after recovery');}}),/stop after recovery/);
    assert.deepEqual(await snapshot(repo),before);
    assert.equal((await validateRepo(repo.root)).ok,true);
  }
});
test('preserves unrelated catalog entries and rejects a changed source at the same version', async () => {
  const repo=await fixtureRepo();
  const entry={name:'other',source:{source:'local',path:'./other'},policy:{installation:'AVAILABLE',authentication:'ON_USE'},category:'Other'};
  await repo.write('other/file.txt','unrelated');
  await repo.edit('.agents/plugins/marketplace.json',c=>{c.plugins.push(entry); c.extra='preserved';});
  await repo.edit('policy/legacy-entries.json',p=>{p.entries.push({host:'codex',reason:'legacy',entry});});
  const a=await artifacts(repo,'1.0.0'); await ingest(repo.root,'knowledgebase',{fetcher:a.fetcher});
  const catalog=await repo.readJson('.agents/plugins/marketplace.json');
  assert.deepEqual(catalog.plugins[0],entry); assert.equal(catalog.extra,'preserved'); assert.equal(await readFile(repo.path('other/file.txt'),'utf8'),'unrelated');
  await repo.edit('sources/knowledgebase.json',s=>{s.hosts.codex.catalogEntry.category='Other';});
  await assert.rejects(ingest(repo.root,'knowledgebase',{fetcher:a.fetcher}),/without a version bump/);
});
test('rejects redirects off origin, invalid media and oversized streams', async () => {
  const repo=await fixtureRepo();
  await assert.rejects(ingest(repo.root,'knowledgebase',{fetcher:async()=>new Response(null,{status:302,headers:{location:'https://evil.example/'}})}),/reviewed origin/);
  await assert.rejects(ingest(repo.root,'knowledgebase',{fetcher:async()=>new Response('{}',{headers:{'content-type':'text/plain'}})}),/media type/);
  await assert.rejects(ingest(repo.root,'knowledgebase',{fetcher:async()=>new Response('x'.repeat(262145),{headers:{'content-type':'application/json'}})}),/body limit/);
});
