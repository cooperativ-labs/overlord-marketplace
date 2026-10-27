// Offline validation of the deliberately limited v1 Knowledgebase package surface.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { treeDigest } from './digest.mjs';
import { parseSemver } from './semver.mjs';

const skills = ['feature-handoff', 'feature-ranking', 'knowledgebase'];
const denied = /^(?:\.env.*|.*\.(?:pem|key|p12)|id_.*|\.npmrc|\.netrc|auth\.json|credentials.*)$/i;
const secret = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[bp]-[A-Za-z0-9-]{20,}|AKIA[0-9A-Z]{16})\b|["']?(?:token|secret|password|apiKey)["']?\s*[:=]\s*["'][A-Za-z0-9+/=_-]{32,}["']/i;
const forbidden = /^(?:command|args|env|headers|headersHelper|hooks|scripts|lspServers|lsp|apps|app|installer|installCommand|install|package|packages)$/i;
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const allowedManifest = new Set(['$schema','name','version','description','displayName','author','homepage','repository','license','keywords','skills','mcpServers','extensions','interface']);
const allowedInterface = new Set(['displayName','shortDescription','longDescription','developerName','category','capabilities','websiteURL','privacyPolicyURL','termsOfServiceURL','defaultPrompt','brandColor','composerIcon','logo','screenshots','icon']);

export async function verifyPackage(root, host, source, lock) {
  const errors = [];
  const fail = x => errors.push(`${host}: ${x}`);
  let tree;
  try { tree = await treeDigest(root, source); } catch (e) { return { errors: [`${host}: package tree: ${e.message}`], skills: new Map() }; }
  const files = new Map(tree.files.map(f => [f.path, f]));
  if (tree.sha256 !== lock.hosts[host].treeSha256 || tree.fileCount !== lock.hosts[host].fileCount) fail('tree digest or file count differs from lock');
  for (const f of tree.files) {
    if (denied.test(f.path.split('/').at(-1))) fail(`denylisted file ${f.path}`);
    if (/(?:^|\/)(?:hooks|scripts)(?:\/|$)|\.(?:sh|bash|zsh|py|js|mjs|cjs|ts|exe|dll|so|dylib|wasm|bat|cmd|ps1)$/i.test(f.path)) fail(`forbidden executable file ${f.path}`);
    const text = f.bytes.toString('utf8');
    if (/\{\{[^{}]*\}\}/s.test(text)) fail(`placeholder in ${f.path}`);
    if (secret.test(text)) fail(`secret pattern in ${f.path}`);
  }
  const ref = (path, kind = 'file') => {
    if (typeof path !== 'string' || !path.startsWith('./') || /[\\\x00-\x1f\x7f]/.test(path) || path.slice(2).split('/').some(s => !s || s === '.' || s === '..')) { fail(`unsafe local reference ${JSON.stringify(path)}`); return null; }
    const p = path.slice(2);
    if (kind === 'dir' ? ![...files.keys()].some(x => x.startsWith(p + '/')) : !files.has(p)) { fail(`missing reference ${path}`); return null; }
    return p;
  };
  const json = p => { try { return JSON.parse(files.get(p).bytes.toString('utf8')); } catch { fail(`invalid or missing JSON ${p}`); return null; } };
  const manifestPath = source.hosts[host].manifest;
  const manifest = json(manifestPath);
  const sets = new Map();
  for (const name of skills) {
    const p = `skills/${name}/SKILL.md`, file = files.get(p);
    if (!file) { fail(`missing skill ${p}`); continue; }
    const text = file.bytes.toString('utf8');
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
    if (!match || !new RegExp(`^name:\\s*["']?${name}["']?\\s*$`, 'm').test(match[1]) || !/^description:\s*\S/m.test(match[1])) fail(`invalid skill frontmatter ${p}`);
    sets.set(name, file.hash);
  }
  for (const p of files.keys()) if (/^skills\/[^/]+\/SKILL\.md$/.test(p) && !skills.includes(p.split('/')[1])) fail(`unexpected skill ${p}`);
  if (!object(manifest)) { fail('manifest must be an object'); return { errors, skills: sets }; }
  for (const key of Object.keys(manifest)) if (!allowedManifest.has(key)) fail(`unsupported manifest field ${key}`);
  for (const k of ['description','displayName','homepage','repository','license']) if (manifest[k] !== undefined && typeof manifest[k] !== 'string') fail(`invalid manifest field ${k}`);
  if (manifest.author !== undefined && (!object(manifest.author) || typeof manifest.author.name !== 'string' || Object.keys(manifest.author).some(k => !['name','url','email'].includes(k)))) fail('invalid manifest author');
  if (manifest.keywords !== undefined && (!Array.isArray(manifest.keywords) || manifest.keywords.some(x => typeof x !== 'string'))) fail('invalid manifest keywords');
  if (manifest.name !== source.plugin || !parseSemver(manifest.version) || manifest.version !== lock.version) fail('manifest name or version differs from lock');
  const scanForbidden = (value, path = 'manifest') => {
    if (Array.isArray(value)) return value.forEach((v,i) => scanForbidden(v, `${path}[${i}]`));
    if (!object(value)) return;
    for (const [key,v] of Object.entries(value)) {
      if (forbidden.test(key)) fail(`forbidden executable surface ${path}.${key}`);
      scanForbidden(v, `${path}.${key}`);
    }
  };
  scanForbidden(manifest);
  const refs = value => {
    if (typeof value === 'string') ref(value, value.endsWith('/SKILL.md') ? 'file' : 'dir');
    else if (Array.isArray(value)) value.forEach(refs);
    else fail('unsupported skills reference');
  };
  if (manifest.skills !== undefined) refs(manifest.skills);
  const iface = value => {
    if (!object(value)) { fail('interface must be an object'); return; }
    for (const [k,v] of Object.entries(value)) {
      if (!allowedInterface.has(k)) fail(`unsupported interface field ${k}`);
      if (['capabilities','defaultPrompt'].includes(k) && (!Array.isArray(v) || v.some(x => typeof x !== 'string'))) fail(`invalid interface field ${k}`);
      if (!['capabilities','defaultPrompt','screenshots'].includes(k) && typeof v !== 'string') fail(`invalid interface field ${k}`);
      if (['logo','composerIcon','icon'].includes(k)) ref(v);
      if (k === 'screenshots') { if (!Array.isArray(v)) fail('screenshots must be an array'); else v.forEach(x => ref(x)); }
    }
  };
  if (manifest.interface !== undefined) iface(manifest.interface);
  let openai = {};
  if (manifest.extensions !== undefined) {
    if (!object(manifest.extensions) || Object.keys(manifest.extensions).some(k => k !== 'com.openai') || !object(manifest.extensions['com.openai'])) fail('unsupported extensions');
    else {
      openai = manifest.extensions['com.openai'];
      for (const k of Object.keys(openai)) if (!['interface','skills','mcpServers'].includes(k)) fail(`unsupported OpenAI extension field ${k}`);
      if (openai.interface !== undefined) iface(openai.interface);
      if (openai.skills !== undefined) refs(openai.skills);
    }
  }
  const servers = new Map();
  const mcpPaths = new Set();
  const addServers = (value, where) => {
    if (typeof value === 'string') { const p = ref(value); if (p && !mcpPaths.has(p)) { mcpPaths.add(p); addServers(json(p), p); } return; }
    if (!object(value)) { fail(`invalid MCP declaration ${where}`); return; }
    const map = object(value.mcpServers) ? value.mcpServers : value;
    if (map !== value && Object.keys(value).some(k => !['$schema','mcpServers'].includes(k))) fail(`unsupported MCP wrapper ${where}`);
    for (const [name, config] of Object.entries(map)) {
      if (!object(config) || Object.keys(config).some(k => !['type','url'].includes(k)) || config.type !== (host === 'codex' ? 'streamable-http' : 'http') || !source.allowedMcpUrls.includes(config.url) || !source.expectedMcpServers.includes(name)) { fail(`invalid MCP server ${name} in ${where}`); continue; }
      if (servers.has(name) && servers.get(name) !== config.url) fail(`conflicting MCP server ${name}`);
      servers.set(name, config.url);
    }
  };
  for (const convention of ['mcp.json', '.mcp.json']) if (files.has(convention)) addServers(json(convention), convention);
  for (const other of ['plugin.json', '.codex-plugin/plugin.json', '.claude-plugin/plugin.json']) if (other !== manifestPath && files.has(other)) fail(`unexpected extra manifest ${other}`);
  if (manifest.mcpServers !== undefined) addServers(manifest.mcpServers, 'manifest');
  if (openai.mcpServers !== undefined) addServers(openai.mcpServers, 'OpenAI extension');
  if (servers.size !== source.expectedMcpServers.length || source.expectedMcpServers.some(n => !servers.has(n))) fail('MCP server identity does not match source');
  return { errors, skills: sets };
}
