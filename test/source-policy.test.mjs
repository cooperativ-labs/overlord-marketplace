import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { compileSchema } from '../scripts/lib/schema.mjs';
import { canonicalOrigin, checkSourceSemantics, isSourceId } from '../scripts/lib/sources.mjs';
import { REPO_ROOT, repoSource } from './helpers.mjs';

const validate = compileSchema(JSON.parse(await readFile(join(REPO_ROOT, 'schemas/source.schema.json'), 'utf8')));
const check = (source, id = 'knowledgebase') => [...validate(source), ...(validate(source).length ? [] : checkSourceSemantics(id, source))];

async function mutated(fn) {
  const source = await repoSource();
  fn(source);
  return source;
}

test('the reviewed Knowledgebase source pointer passes schema and policy', async () => {
  const source = await repoSource();
  assert.deepEqual(check(source), []);
  assert.equal(source.deploymentUrl, 'https://knowledge.chaselubitz.com');
  assert.deepEqual(source.allowedMcpUrls, ['https://knowledge.chaselubitz.com/mcp']);
  assert.deepEqual(source.expectedMcpServers, ['knowledgebase']);
  assert.equal(source.surfacePolicy, 'remote-http-mcp-only');
  assert.equal(source.hosts.codex.target, 'plugins/codex/knowledgebase');
  assert.equal(source.hosts['claude-code'].target, 'plugins/claude-code/knowledgebase');
});

const rejections = {
  'plain HTTP deployment': (s) => { s.deploymentUrl = 'http://knowledge.chaselubitz.com'; },
  'deployment with trailing slash': (s) => { s.deploymentUrl = 'https://knowledge.chaselubitz.com/'; },
  'deployment with a path': (s) => { s.deploymentUrl = 'https://knowledge.chaselubitz.com/app'; },
  'deployment with userinfo': (s) => { s.deploymentUrl = 'https://user@knowledge.chaselubitz.com'; },
  'deployment with a port': (s) => { s.deploymentUrl = 'https://knowledge.chaselubitz.com:8443'; },
  'deployment with uppercase host': (s) => { s.deploymentUrl = 'https://Knowledge.chaselubitz.com'; },
  'index with traversal': (s) => { s.index = '/plugins/../secret.json'; },
  'index with query': (s) => { s.index = '/plugins/index.json?token=x'; },
  'relative index': (s) => { s.index = 'plugins/index.json'; },
  'plugin id differs from file id': (s) => { s.plugin = 'other'; },
  'codex target outside its host prefix': (s) => { s.hosts.codex.target = 'plugins/claude-code/knowledgebase'; },
  'target for another plugin': (s) => { s.hosts.codex.target = 'plugins/codex/other'; },
  'target escaping plugins/': (s) => { s.hosts.codex.target = '../knowledgebase'; },
  'zipRoot with traversal': (s) => { s.hosts.codex.zipRoot = '../'; },
  'zipRoot with two segments': (s) => { s.hosts.codex.zipRoot = 'a/b/'; },
  'unsupported Codex manifest path': (s) => { s.hosts.codex.manifest = 'manifest.json'; },
  'unsupported Claude manifest path': (s) => { s.hosts['claude-code'].manifest = 'plugin.json'; },
  'missing host': (s) => { delete s.hosts['claude-code']; },
  'unknown host': (s) => { s.hosts.cursor = s.hosts.codex; },
  'unknown top-level field': (s) => { s.indexUrl = 'https://example.com/index.json'; },
  'MCP URL off the allowed origins': (s) => { s.allowedMcpUrls = ['https://evil.example.com/mcp']; },
  'MCP URL with query': (s) => { s.allowedMcpUrls = ['https://knowledge.chaselubitz.com/mcp?key=1']; },
  'MCP URL over HTTP': (s) => { s.allowedMcpUrls = ['http://knowledge.chaselubitz.com/mcp']; },
  'MCP origin with path': (s) => { s.allowedMcpOrigins = ['https://knowledge.chaselubitz.com/mcp']; },
  'no expected MCP server': (s) => { s.expectedMcpServers = []; },
  'artifact limit above ceiling': (s) => { s.maxArtifactBytes = 50_000_001; },
  'per-file limit above 2 MB': (s) => { s.maxFileBytes = 2_000_001; },
  'per-file limit above expanded limit': (s) => { s.maxExpandedBytes = 1_000; s.maxFileBytes = 2_000; },
  'non-integer entry limit': (s) => { s.maxEntries = 1.5; },
  'surface policy that admits executables': (s) => { s.surfacePolicy = 'stdio'; },
  'default installation': (s) => { s.hosts.codex.catalogEntry.policy.installation = 'INSTALLED_BY_DEFAULT'; },
  'catalog entry overriding source': (s) => { s.hosts.codex.catalogEntry.source = { source: 'url' }; },
  'catalog entry setting version': (s) => { s.hosts['claude-code'].catalogEntry.version = '1.0.0'; },
  'wrong $schema pointer': (s) => { s.$schema = 'https://example.com/schema.json'; },
  'future schema version': (s) => { s.schemaVersion = 2; },
};

for (const [name, fn] of Object.entries(rejections)) {
  test(`rejects ${name}`, async () => {
    const errors = check(await mutated(fn));
    assert.ok(errors.length > 0, `expected rejection for ${name}`);
  });
}

test('source ids are bounded kebab-case', () => {
  for (const id of ['knowledgebase', 'scribe', 'a1-b2']) assert.ok(isSourceId(id), id);
  for (const id of ['', 'Knowledgebase', 'kb/../x', 'kb.json', '-kb', 'kb-', 'k'.repeat(65), 'kb--x']) {
    assert.ok(!isSourceId(id), id);
  }
});

test('canonical origins', () => {
  assert.equal(canonicalOrigin('https://knowledge.chaselubitz.com'), 'https://knowledge.chaselubitz.com');
  for (const raw of ['https://knowledge.chaselubitz.com/', 'http://a.example', 'https://a.example:443', 'not a url']) {
    assert.equal(canonicalOrigin(raw), null, raw);
  }
});
