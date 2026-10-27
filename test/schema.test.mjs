import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compileSchema, deepEqual, SchemaError } from '../scripts/lib/schema.mjs';

test('unsupported keywords fail closed', () => {
  assert.throws(() => compileSchema({ type: 'string', format: 'uri' }), SchemaError);
  assert.throws(() => compileSchema({ properties: { a: { if: {} } } }), SchemaError);
});

test('unresolved and external refs fail closed', () => {
  assert.throws(() => compileSchema({ $ref: '#/$defs/missing' })(1), SchemaError);
  assert.throws(() => compileSchema({ $ref: 'other.json' })(1), SchemaError);
});

test('object, string, number and array constraints', () => {
  const validate = compileSchema({
    type: 'object',
    additionalProperties: false,
    required: ['id', 'n', 'tags'],
    properties: {
      id: { $ref: '#/$defs/id' },
      n: { type: 'integer', minimum: 1, maximum: 3 },
      tags: { type: 'array', uniqueItems: true, maxItems: 2, items: { enum: ['a', 'b', 'c'] } },
    },
    $defs: { id: { type: 'string', pattern: '^[a-z]+$', maxLength: 5 } },
  });
  assert.deepEqual(validate({ id: 'abc', n: 2, tags: ['a', 'b'] }), []);
  const errors = validate({ id: 'ABCDEFG', n: 4.5, tags: ['a', 'a', 'z'], extra: true });
  assert.ok(errors.some((e) => e.includes('$.id') && e.includes('does not match')));
  assert.ok(errors.some((e) => e.includes('$.id') && e.includes('longer than')));
  assert.ok(errors.some((e) => e.includes('$.n') && e.includes('expected integer')));
  assert.ok(errors.some((e) => e.includes('unique')));
  assert.ok(errors.some((e) => e.includes('more than 2 items')));
  assert.ok(errors.some((e) => e.includes('$.extra: unknown property')));
  assert.ok(validate({}).some((e) => e.includes('missing required "id"')));
});

test('const, oneOf and deepEqual', () => {
  const validate = compileSchema({ oneOf: [{ const: { a: [1] } }, { type: 'string' }] });
  assert.deepEqual(validate({ a: [1] }), []);
  assert.deepEqual(validate('x'), []);
  assert.equal(validate({ a: [2] }).length, 1);
  assert.ok(deepEqual({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 }));
  assert.ok(!deepEqual({ a: 1 }, { a: 1, b: undefined }));
});
