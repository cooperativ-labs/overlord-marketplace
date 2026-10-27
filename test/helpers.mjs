import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after } from 'node:test';

export const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

// Files a validation fixture copies from the real repository.
const FIXTURE_FILES = [
  '.agents/plugins/marketplace.json',
  '.claude-plugin/marketplace.json',
  'policy/legacy-entries.json',
  'sources/knowledgebase.json',
];

const created = [];
after(async () => {
  await Promise.all(created.map((dir) => rm(dir, { recursive: true, force: true })));
});

export async function fixtureRepo() {
  const root = await mkdtemp(join(tmpdir(), 'ovld-marketplace-test-'));
  created.push(root);
  for (const file of FIXTURE_FILES) {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await cp(join(REPO_ROOT, file), join(root, file));
  }
  // Fixtures begin at bootstrap even when the checkout contains an ingested release.
  for (const file of FIXTURE_FILES.slice(0, 2)) {
    const path = join(root, file);
    const catalog = JSON.parse(await readFile(path, 'utf8'));
    catalog.plugins = catalog.plugins.filter((entry) => entry.name !== 'knowledgebase');
    await writeFile(path, `${JSON.stringify(catalog, null, 2)}\n`);
  }
  return {
    root,
    path: (file) => join(root, file),
    async readJson(file) {
      return JSON.parse(await readFile(join(root, file), 'utf8'));
    },
    async writeJson(file, value) {
      await mkdir(dirname(join(root, file)), { recursive: true });
      await writeFile(join(root, file), `${JSON.stringify(value, null, 2)}\n`);
    },
    async write(file, text) {
      await mkdir(dirname(join(root, file)), { recursive: true });
      await writeFile(join(root, file), text);
    },
    async edit(file, fn) {
      const value = await this.readJson(file);
      await this.writeJson(file, fn(value) ?? value);
    },
  };
}

export async function repoSource() {
  return JSON.parse(await readFile(join(REPO_ROOT, 'sources/knowledgebase.json'), 'utf8'));
}

// Public synthetic release for both hosts, served through an injected fetcher.
export async function releaseArtifacts(dir, version, body = 'Body') {
  const { execFileSync } = await import('node:child_process');
  const { createHash } = await import('node:crypto');
  const origin = 'https://knowledge.chaselubitz.com';
  const zips = {};
  for (const host of ['codex', 'claude-code']) {
    const files = {};
    const prefix = host === 'codex' ? 'knowledgebase/' : '';
    const manifest = { name: 'knowledgebase', version, description: 'Example' };
    if (host === 'codex') { manifest.extensions = { 'com.openai': { interface: { logo: './assets/logo.png' } } }; files[`${prefix}assets/logo.png`] = 'image'; }
    else manifest.mcpServers = './.mcp.json';
    files[prefix + (host === 'codex' ? 'plugin.json' : '.claude-plugin/plugin.json')] = JSON.stringify(manifest);
    files[prefix + (host === 'codex' ? 'mcp.json' : '.mcp.json')] = JSON.stringify({ mcpServers: { knowledgebase: { type: host === 'codex' ? 'streamable-http' : 'http', url: `${origin}/mcp` } } });
    for (const name of ['knowledgebase', 'feature-ranking', 'feature-handoff']) files[`${prefix}skills/${name}/SKILL.md`] = `---\nname: ${name}\ndescription: A skill\n---\n${body}\n`;
    const zip = join(dir, `${host}-${version}.zip`);
    execFileSync('python3', ['-c', "import json,sys,zipfile\nf=json.loads(sys.stdin.read())\nwith zipfile.ZipFile(sys.argv[1],'w') as z:\n for k,v in f.items(): z.writestr(k,v)", zip], { input: JSON.stringify(files) });
    zips[host] = await readFile(zip);
    await rm(zip);
  }
  const sha = (b) => createHash('sha256').update(b).digest('hex');
  const index = { version, codex: { plugin_package: `${origin}/plugins/codex.zip`, plugin_package_sha256: sha(zips.codex) }, claude: { claude_code: { plugin_package: `${origin}/plugins/claude-code.zip`, plugin_package_sha256: sha(zips['claude-code']) } } };
  const fetcher = async (url) => url.endsWith('index.json')
    ? new Response(JSON.stringify(index), { headers: { 'content-type': 'application/json' } })
    : new Response(zips[url.endsWith('/codex.zip') ? 'codex' : 'claude-code'], { headers: { 'content-type': 'application/zip' } });
  return { index, zips, fetcher };
}
