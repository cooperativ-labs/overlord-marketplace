import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkCatalog, expectedEntry, localPathProblem, mergeEntry } from '../scripts/lib/catalog.mjs';
import { repoSource } from './helpers.mjs';

test('expected entries match the documented catalog contract exactly', async () => {
  const source = await repoSource();
  assert.deepEqual(expectedEntry('codex', source), {
    name: 'knowledgebase',
    source: { source: 'local', path: './plugins/codex/knowledgebase' },
    policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
    category: 'Productivity',
  });
  assert.deepEqual(expectedEntry('claude-code', source), {
    name: 'knowledgebase',
    source: './plugins/claude-code/knowledgebase',
    description: 'Search, read, and write your Knowledgebase knowledge graph.',
    category: 'productivity',
  });
});

test('merge replaces only the selected entry, in place', () => {
  const catalog = { name: 'Overlord', extra: { keep: true }, plugins: [{ name: 'a', x: 1 }, { name: 'kb', old: true }, { name: 'z' }] };
  const merged = mergeEntry(catalog, { name: 'kb', fresh: true });
  assert.deepEqual(merged, { name: 'Overlord', extra: { keep: true }, plugins: [{ name: 'a', x: 1 }, { name: 'kb', fresh: true }, { name: 'z' }] });
  assert.deepEqual(catalog.plugins[1], { name: 'kb', old: true }, 'input is not mutated');
  assert.deepEqual(mergeEntry({ name: 'Overlord', plugins: [] }, { name: 'kb' }).plugins, [{ name: 'kb' }]);
});

test('catalog structure', () => {
  assert.deepEqual(checkCatalog('codex', { name: 'Overlord', plugins: [] }), []);
  assert.deepEqual(checkCatalog('claude-code', { name: 'Overlord', owner: { name: 'Cooperativ' }, plugins: [] }), []);
  assert.ok(checkCatalog('codex', { name: 'overlord', plugins: [] }).length, 'name is case-sensitive');
  assert.ok(checkCatalog('claude-code', { name: 'Overlord', plugins: [] }).length, 'owner required');
  assert.ok(checkCatalog('codex', { name: 'Overlord' }).length, 'plugins required');
  const dupes = checkCatalog('claude-code', { name: 'Overlord', owner: { name: 'o' }, plugins: [{ name: 'a', source: './x' }, { name: 'a', source: './y' }] });
  assert.ok(dupes.some((e) => e.includes('duplicate')));
  const codexEntry = { name: 'a', source: { source: 'local', path: './x' } };
  assert.ok(checkCatalog('codex', { name: 'Overlord', plugins: [codexEntry] }).some((e) => e.includes('policy')));
  assert.ok(checkCatalog('codex', { name: 'Overlord', plugins: [{ ...codexEntry, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'C', version: '1.0.0' }] })
    .some((e) => e.includes('version')));
});

test('local source paths stay inside the repository', () => {
  assert.equal(localPathProblem('./plugins/codex/knowledgebase'), null);
  for (const path of ['plugins/x', '/abs', './../x', './a/../b', './a//b', './a\\b', './a/', '../x']) {
    assert.ok(localPathProblem(path), path);
  }
});
