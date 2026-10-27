import assert from 'node:assert/strict';
import { test } from 'node:test';
import { atLeast, checkPrerequisites, parseVersion } from '../scripts/prereqs.mjs';

test('version parsing and comparison', () => {
  assert.deepEqual(parseVersion('v22.4.1'), [22, 4, 1]);
  assert.deepEqual(parseVersion('Python 3.12'), [3, 12, 0]);
  assert.equal(parseVersion('none'), null);
  assert.ok(atLeast([22, 0, 0], [22, 0, 0]));
  assert.ok(atLeast([23, 0, 0], [22, 9, 9]));
  assert.ok(!atLeast([21, 9, 9], [22, 0, 0]));
  assert.ok(!atLeast([3, 8, 18], [3, 9, 0]));
});

test('the base toolchain is available where tests run', () => {
  const result = checkPrerequisites();
  assert.ok(result.ok, JSON.stringify(result.checks));
  assert.deepEqual(result.checks.map((c) => c.tool), ['node', 'python3', 'git']);
});
