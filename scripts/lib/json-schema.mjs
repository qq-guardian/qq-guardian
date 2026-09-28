/**
 * Small dependency-free JSON Schema draft-07 validator for repository contract
 * fixtures. It intentionally supports only the reviewed keywords used under
 * contracts/schemas; unsupported schema keywords fail closed.
 */

const SUPPORTED_KEYWORDS = new Set([
  '$schema', '$id', '$ref', 'title', 'description', 'definitions',
  'type', 'required', 'properties', 'additionalProperties', 'items',
  'minItems', 'minLength', 'maxLength', 'pattern', 'format', 'minimum', 'maximum', 'enum', 'const',
  'allOf', 'anyOf', 'oneOf',
]);

const UINT64_MAX = 18_446_744_073_709_551_615n;
const INT64_MIN = -9_223_372_036_854_775_808n;
const CANONICAL_UNSIGNED_DECIMAL = /^(?:0|[1-9][0-9]*)$/;
const CANONICAL_SIGNED_DECIMAL = /^(?:-[1-9][0-9]*|[1-9][0-9]*)$/;
const FORMAT_VALIDATORS = Object.freeze({
  'onebot-uint64': (value) => value.length <= 20
    && CANONICAL_UNSIGNED_DECIMAL.test(value)
    && BigInt(value) > 0n
    && BigInt(value) <= UINT64_MAX,
  'onebot-message-id': (value) => value.length <= 20
    && CANONICAL_SIGNED_DECIMAL.test(value)
    && BigInt(value) >= INT64_MIN
    && BigInt(value) <= UINT64_MAX,
});

export function validateJsonSchema(schema, instance) {
  assertSupportedSchema(schema);
  const errors = [];
  visit(schema, instance, '$', schema, errors);
  return { valid: errors.length === 0, errors };
}

export function assertSupportedSchema(schema, path = '$') {
  if (!isObject(schema)) throw new Error(`${path}: schema must be an object`);
  for (const key of Object.keys(schema)) {
    if (!SUPPORTED_KEYWORDS.has(key)) throw new Error(`${path}: unsupported JSON Schema keyword ${key}`);
  }
  if (schema.format !== undefined && !Object.hasOwn(FORMAT_VALIDATORS, schema.format)) {
    throw new Error(`${path}.format: unsupported format ${JSON.stringify(schema.format)}`);
  }
  for (const keyword of ['allOf', 'anyOf', 'oneOf']) {
    const children = schema[keyword];
    if (children !== undefined) {
      if (!Array.isArray(children) || children.length === 0) throw new Error(`${path}.${keyword}: must be a non-empty array`);
      children.forEach((child, index) => assertSupportedSchema(child, `${path}.${keyword}[${index}]`));
    }
  }
  for (const [name, child] of Object.entries(schema.definitions ?? {})) {
    assertSupportedSchema(child, `${path}.definitions.${name}`);
  }
  for (const [name, child] of Object.entries(schema.properties ?? {})) {
    assertSupportedSchema(child, `${path}.properties.${name}`);
  }
  if (schema.additionalProperties !== undefined
      && typeof schema.additionalProperties !== 'boolean'
      && !isObject(schema.additionalProperties)) {
    throw new Error(`${path}.additionalProperties: must be a boolean or schema object`);
  }
  if (isObject(schema.additionalProperties)) assertSupportedSchema(schema.additionalProperties, `${path}.additionalProperties`);
  if (Array.isArray(schema.items)) throw new Error(`${path}.items: tuple schemas are not supported`);
  if (schema.items !== undefined && !isObject(schema.items)) {
    throw new Error(`${path}.items: must be a schema object`);
  }
  if (isObject(schema.items)) assertSupportedSchema(schema.items, `${path}.items`);
}

function visit(schema, value, path, root, errors) {
  if (schema.$ref !== undefined) {
    const target = resolveLocalReference(root, schema.$ref);
    visit(target, value, path, root, errors);
  }

  if (schema.allOf) {
    for (const child of schema.allOf) visit(child, value, path, root, errors);
  }
  if (schema.anyOf) {
    const candidates = schema.anyOf.map((child) => validateBranch(child, value, path, root));
    if (!candidates.some((candidate) => candidate.length === 0)) {
      errors.push(`${path}: must match at least one anyOf branch`);
    }
  }
  if (schema.oneOf) {
    const matches = schema.oneOf.filter((child) => validateBranch(child, value, path, root).length === 0).length;
    if (matches !== 1) errors.push(`${path}: must match exactly one oneOf branch (matched ${matches})`);
  }

  if (schema.type !== undefined && !matchesType(value, schema.type)) {
    errors.push(`${path}: expected ${Array.isArray(schema.type) ? schema.type.join(' or ') : schema.type}`);
    return;
  }
  if (schema.enum && !schema.enum.some((candidate) => deepEqual(candidate, value))) {
    errors.push(`${path}: value is not in enum`);
  }
  if (Object.hasOwn(schema, 'const') && !deepEqual(schema.const, value)) {
    errors.push(`${path}: value must equal ${JSON.stringify(schema.const)}`);
  }
  if (typeof value === 'number' && schema.minimum !== undefined && value < schema.minimum) {
    errors.push(`${path}: must be at least ${schema.minimum}`);
  }
  if (typeof value === 'number' && schema.maximum !== undefined && value > schema.maximum) {
    errors.push(`${path}: must be at most ${schema.maximum}`);
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path}: is shorter than ${schema.minLength}`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${path}: is longer than ${schema.maxLength}`);
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(value)) errors.push(`${path}: does not match ${schema.pattern}`);
    if (schema.format !== undefined && !FORMAT_VALIDATORS[schema.format](value)) {
      errors.push(`${path}: does not match format ${schema.format}`);
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}: has fewer than ${schema.minItems} items`);
    if (schema.items) value.forEach((item, index) => visit(schema.items, item, `${path}[${index}]`, root, errors));
  }
  if (isObject(value)) validateObject(schema, value, path, root, errors);
}

function validateObject(schema, value, path, root, errors) {
  for (const required of schema.required ?? []) {
    if (!Object.hasOwn(value, required)) errors.push(`${path}: missing required property ${required}`);
  }
  const properties = schema.properties ?? {};
  for (const [key, child] of Object.entries(properties)) {
    if (Object.hasOwn(value, key)) visit(child, value[key], `${path}.${key}`, root, errors);
  }
  for (const key of Object.keys(value)) {
    if (Object.hasOwn(properties, key)) continue;
    if (schema.additionalProperties === false) errors.push(`${path}: unexpected property ${key}`);
    else if (isObject(schema.additionalProperties)) visit(schema.additionalProperties, value[key], `${path}.${key}`, root, errors);
  }
}

function validateBranch(schema, value, path, root) {
  const errors = [];
  visit(schema, value, path, root, errors);
  return errors;
}

function resolveLocalReference(root, reference) {
  if (!reference.startsWith('#/')) throw new Error(`Only local JSON pointers are supported: ${reference}`);
  return reference.slice(2).split('/').reduce((value, rawSegment) => {
    const segment = rawSegment.replaceAll('~1', '/').replaceAll('~0', '~');
    if (!isObject(value) || !Object.hasOwn(value, segment)) throw new Error(`Unresolved JSON Schema reference: ${reference}`);
    return value[segment];
  }, root);
}

function matchesType(value, expected) {
  const types = Array.isArray(expected) ? expected : [expected];
  return types.some((type) => {
    if (type === 'null') return value === null;
    if (type === 'array') return Array.isArray(value);
    if (type === 'object') return isObject(value);
    if (type === 'integer') return typeof value === 'number' && Number.isInteger(value);
    if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
    return typeof value === type;
  });
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function deepEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}
