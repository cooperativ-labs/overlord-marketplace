// Minimal JSON Schema (2020-12 subset) validator with no npm dependencies.
// It fails closed: a schema that uses a keyword outside SUPPORTED throws, so a
// checked-in schema can never silently skip a constraint.

const SUPPORTED = new Set([
  '$schema', '$id', '$defs', '$ref', '$comment', 'title', 'description',
  'type', 'const', 'enum',
  'properties', 'required', 'additionalProperties', 'propertyNames',
  'minProperties', 'maxProperties',
  'items', 'minItems', 'maxItems', 'uniqueItems',
  'minLength', 'maxLength', 'pattern',
  'minimum', 'maximum',
  'oneOf',
]);

export class SchemaError extends Error {}

export function compileSchema(schema) {
  checkKeywords(schema, '#');
  return (value) => {
    const errors = [];
    check(schema, value, '$', schema, errors);
    return errors;
  };
}

function checkKeywords(node, at) {
  if (typeof node === 'boolean') return;
  if (!isObject(node)) throw new SchemaError(`${at}: schema must be an object or boolean`);
  for (const key of Object.keys(node)) {
    if (!SUPPORTED.has(key)) throw new SchemaError(`${at}: unsupported schema keyword "${key}"`);
  }
  for (const key of ['$defs', 'properties']) {
    if (node[key]) for (const [k, v] of Object.entries(node[key])) checkKeywords(v, `${at}/${key}/${k}`);
  }
  for (const key of ['items', 'additionalProperties', 'propertyNames']) {
    if (node[key] !== undefined) checkKeywords(node[key], `${at}/${key}`);
  }
  if (node.oneOf) node.oneOf.forEach((s, i) => checkKeywords(s, `${at}/oneOf/${i}`));
}

function resolveRef(root, ref) {
  if (!ref.startsWith('#/$defs/')) throw new SchemaError(`unsupported $ref "${ref}"`);
  const target = root.$defs?.[ref.slice('#/$defs/'.length)];
  if (target === undefined) throw new SchemaError(`unresolved $ref "${ref}"`);
  return target;
}

function check(schema, value, path, root, errors) {
  if (schema === true) return;
  if (schema === false) {
    errors.push(`${path}: not allowed`);
    return;
  }
  if (schema.$ref) {
    check(resolveRef(root, schema.$ref), value, path, root, errors);
  }
  if (schema.type !== undefined && !matchesType(schema.type, value)) {
    errors.push(`${path}: expected ${[].concat(schema.type).join(' or ')}`);
    return;
  }
  if ('const' in schema && !deepEqual(schema.const, value)) {
    errors.push(`${path}: must equal ${JSON.stringify(schema.const)}`);
  }
  if (schema.enum && !schema.enum.some((v) => deepEqual(v, value))) {
    errors.push(`${path}: must be one of ${schema.enum.map((v) => JSON.stringify(v)).join(', ')}`);
  }
  if (typeof value === 'string') {
    const length = [...value].length;
    if (schema.minLength !== undefined && length < schema.minLength) errors.push(`${path}: shorter than ${schema.minLength}`);
    if (schema.maxLength !== undefined && length > schema.maxLength) errors.push(`${path}: longer than ${schema.maxLength}`);
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(value)) {
      errors.push(`${path}: does not match ${schema.pattern}`);
    }
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: below ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: above ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}: fewer than ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path}: more than ${schema.maxItems} items`);
    if (schema.uniqueItems && value.some((v, i) => value.findIndex((w) => deepEqual(v, w)) !== i)) {
      errors.push(`${path}: items must be unique`);
    }
    if (schema.items !== undefined) value.forEach((v, i) => check(schema.items, v, `${path}[${i}]`, root, errors));
  }
  if (isObject(value)) {
    const keys = Object.keys(value);
    if (schema.minProperties !== undefined && keys.length < schema.minProperties) errors.push(`${path}: fewer than ${schema.minProperties} properties`);
    if (schema.maxProperties !== undefined && keys.length > schema.maxProperties) errors.push(`${path}: more than ${schema.maxProperties} properties`);
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) errors.push(`${path}: missing required "${key}"`);
    }
    for (const key of keys) {
      const child = `${path}.${key}`;
      if (schema.propertyNames !== undefined) {
        const nameErrors = [];
        check(schema.propertyNames, key, `${path} property name "${key}"`, root, nameErrors);
        errors.push(...nameErrors);
      }
      if (schema.properties && Object.hasOwn(schema.properties, key)) {
        check(schema.properties[key], value[key], child, root, errors);
      } else if (schema.additionalProperties !== undefined) {
        if (schema.additionalProperties === false) errors.push(`${child}: unknown property`);
        else check(schema.additionalProperties, value[key], child, root, errors);
      }
    }
  }
  if (schema.oneOf) {
    const passing = schema.oneOf.filter((s) => {
      const sub = [];
      check(s, value, path, root, sub);
      return sub.length === 0;
    });
    if (passing.length !== 1) errors.push(`${path}: must match exactly one schema in oneOf (matched ${passing.length})`);
  }
}

function matchesType(type, value) {
  return [].concat(type).some((t) => {
    switch (t) {
      case 'object': return isObject(value);
      case 'array': return Array.isArray(value);
      case 'string': return typeof value === 'string';
      case 'integer': return Number.isInteger(value);
      case 'number': return typeof value === 'number' && Number.isFinite(value);
      case 'boolean': return typeof value === 'boolean';
      case 'null': return value === null;
      default: throw new SchemaError(`unsupported type "${t}"`);
    }
  });
}

export function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function deepEqual(a, b) {
  if (a === b) return true;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  if (isObject(a)) {
    if (!isObject(b)) return false;
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]));
  }
  return false;
}
