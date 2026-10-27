import { mkdtemp, mkdir, cp, readFile, writeFile, rm } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ingest } from './ingest.mjs';
import { sha256Hex } from './lib/sources.mjs';
const source = resolve(fileURLToPath(new URL('..', import.meta.url)));
const root = await mkdtemp(join('/tmp', 'marketplace-synthetic-'));
const env = {PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM:'1', GIT_CONFIG_GLOBAL:'/dev/null', GIT_TERMINAL_PROMPT:'0', GIT_ALLOW_PROTOCOL:'file'};
const run = (cmd, args, options = {}) => execFileSync(cmd, args, {cwd: root, env, stdio:'inherit', ...options});
try {
  for (const path of ['.agents/plugins/marketplace.json','.claude-plugin/marketplace.json','policy/legacy-entries.json','sources/knowledgebase.json']) {
    await mkdir(dirname(join(root,path)), {recursive:true}); await cp(join(source,path),join(root,path));
  }
  for (const path of ['.agents/plugins/marketplace.json','.claude-plugin/marketplace.json']) {
    const f=join(root,path), c=JSON.parse(await readFile(f)); c.plugins=c.plugins.filter(x=>x.name!=='knowledgebase'); await writeFile(f,JSON.stringify(c,null,2)+'\n');
  }
  async function release(version, marker) {
    const zips = {};
    for (const host of ['codex','claude-code']) {
      const files = {}, prefix = host === 'codex' ? 'knowledgebase/' : '';
      const manifest = {name:'knowledgebase',version,description:'Synthetic test plugin'};
      if (host === 'codex') {manifest.$schema='https://agent-plugins.org/schemas/1.0.0/plugin.schema.json'; manifest.extensions={'com.openai':{interface:{logo:'./assets/logo.png'}}}; files[prefix+'assets/logo.png']='image';}
      else manifest.mcpServers='./.mcp.json';
      files[prefix+(host==='codex'?'plugin.json':'.claude-plugin/plugin.json')]=JSON.stringify(manifest);
      files[prefix+(host==='codex'?'mcp.json':'.mcp.json')]=JSON.stringify({...host==='codex'?{$schema:'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json'}:{},mcpServers:{knowledgebase:{type:host==='codex'?'streamable-http':'http',url:'https://knowledge.chaselubitz.com/mcp'}}});
      for (const name of ['knowledgebase','feature-ranking','feature-handoff']) files[`${prefix}skills/${name}/SKILL.md`]=`---\nname: ${name}\ndescription: Synthetic test skill\n---\n${marker}\n`;
      const zip=join(root,host+'.zip');
      execFileSync('python3',['-c','import json,sys,zipfile\nf=json.load(sys.stdin)\nwith zipfile.ZipFile(sys.argv[1],"w") as z:\n for k,v in f.items(): z.writestr(k,v)',zip],{input:JSON.stringify(files),env});
      zips[host]=await readFile(zip); await rm(zip);
    }
    const origin='https://knowledge.chaselubitz.com';
    const index={version,codex:{plugin_package:origin+'/plugins/codex.zip',plugin_package_sha256:sha256Hex(zips.codex)},claude:{claude_code:{plugin_package:origin+'/plugins/claude-code.zip',plugin_package_sha256:sha256Hex(zips['claude-code'])}}};
    const fetcher=async url=>url.endsWith('index.json')?new Response(JSON.stringify(index),{headers:{'content-type':'application/json'}}):new Response(zips[url.endsWith('/codex.zip')?'codex':'claude-code'],{headers:{'content-type':'application/zip'}});
    await ingest(root,'knowledgebase',{fetcher});
  }
  run('git',['init','-q','-b','main']);
  run('git',['add','.']); run('git',['-c','user.name=Smoke','-c','user.email=smoke@example.invalid','commit','-qm','bootstrap']);
  const bootstrap=execFileSync('git',['rev-parse','HEAD'],{cwd:root,env,encoding:'utf8'}).trim();
  await release('1.0.0','fixture A marker');
  console.log('Synthetic A lock:', await readFile(join(root,'sources/knowledgebase.lock.json'),'utf8'));
  run('git',['add','.']); run('git',['-c','user.name=Smoke','-c','user.email=smoke@example.invalid','commit','-qm','fixture A']);
  const a=execFileSync('git',['rev-parse','HEAD'],{cwd:root,env,encoding:'utf8'}).trim();
  await release('1.1.0','fixture B changed marker');
  console.log('Synthetic B lock:', await readFile(join(root,'sources/knowledgebase.lock.json'),'utf8'));
  run('bash',[join(source,'scripts/smoke.sh'),root,'--upgrade-from',a]);
  if (process.argv.includes('--matrix')) {
    run('bash',[join(source,'scripts/smoke.sh'),root,'--upgrade-from',bootstrap]);
    run('git',['add','.']); run('git',['-c','user.name=Smoke','-c','user.email=smoke@example.invalid','commit','-qm','fixture B']);
    const b=execFileSync('git',['rev-parse','HEAD'],{cwd:root,env,encoding:'utf8'}).trim();
    await writeFile(join(root,'README.md'),'Synthetic docs-only candidate.\n');
    run('bash',[join(source,'scripts/smoke.sh'),root,'--upgrade-from',b]);
  }
} finally { await rm(root,{recursive:true,force:true}); }
