import { readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateJsonSchema } from './json-schema.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CONTRACTS = join(ROOT, 'contracts');
export const PROVIDERS = Object.freeze(['napcat', 'snowluma']);
const SCHEMA_NAMES = Object.freeze(['action-request', 'action-response', 'event']);
const MATRIX_AXES = Object.freeze(['transports', 'actions', 'events', 'messages']);
const EVENT_CAPABILITY_MATCHERS = Object.freeze({
  'message.group': (payload) => payload?.post_type === 'message' && payload?.message_type === 'group',
  'message.private': (payload) => payload?.post_type === 'message' && payload?.message_type === 'private',
  'request.group.add': (payload) => payload?.post_type === 'request' && payload?.request_type === 'group' && payload?.sub_type === 'add',
  'notice.group_increase': (payload) => payload?.post_type === 'notice'
    && payload?.notice_type === 'group_increase'
    && payload?.group_id !== undefined
    && payload?.user_id !== undefined,
  message_sent: (payload) => payload?.post_type === 'message_sent',
  meta_event: (payload) => payload?.post_type === 'meta_event',
  'request.friend': (payload) => payload?.post_type === 'request' && payload?.request_type === 'friend',
});

export function loadProviderContract(provider) {
  if (!PROVIDERS.includes(provider)) throw new Error(`Unknown provider ${JSON.stringify(provider)}; expected ${PROVIDERS.join(' or ')}`);
  return readJson(join(CONTRACTS, 'providers', `${provider}.json`));
}

export function loadContractSchemas() {
  return Object.fromEntries(SCHEMA_NAMES.map((name) => [
    name,
    readJson(join(CONTRACTS, 'schemas', `${name}.schema.json`)),
  ]));
}

export function validateProviderContract(provider, contract = loadProviderContract(provider), schemas = loadContractSchemas()) {
  const errors = [];
  const manifestResult = validateJsonSchema(
    readJson(join(CONTRACTS, 'schemas', 'provider-contract.schema.json')),
    contract,
  );
  errors.push(...manifestResult.errors.map((error) => `contract: ${error}`));
  if (contract.provider !== provider) errors.push(`provider: expected ${provider}, received ${String(contract.provider)}`);
  if (!Array.isArray(contract.cases) || contract.cases.length === 0) {
    return { valid: false, errors: [...errors, 'cases: expected a non-empty array'] };
  }

  const capabilities = validateCapabilityMatrix(provider, contract.matrix, contract.cases, errors);

  for (const [index, contractCase] of contract.cases.entries()) {
    const label = `${provider}.cases[${index}]${contractCase?.name ? ` (${contractCase.name})` : ''}`;
    if (!contractCase || typeof contractCase !== 'object') {
      errors.push(`${label}: expected an object`);
      continue;
    }
    const schema = schemas[contractCase.schema];
    if (!schema) {
      errors.push(`${label}: unknown schema ${JSON.stringify(contractCase.schema)}`);
      continue;
    }
    const result = validateJsonSchema(schema, contractCase.payload);
    errors.push(...result.errors.map((error) => `${label}: ${error}`));
    validateCaseCoverage(label, contractCase, capabilities, errors);
  }
  return { valid: errors.length === 0, errors };
}

function validateCapabilityMatrix(provider, matrix, cases, errors) {
  const capabilities = new Map();
  if (!matrix || typeof matrix !== 'object') return capabilities;

  for (const axis of MATRIX_AXES) {
    const entries = matrix[axis];
    if (!Array.isArray(entries)) continue;
    const ids = new Set();
    for (const [index, entry] of entries.entries()) {
      if (!entry || typeof entry !== 'object') continue;
      const key = `${axis}:${String(entry.id)}`;
      if (ids.has(entry.id)) errors.push(`matrix.${axis}[${index}]: duplicate capability ${String(entry.id)}`);
      ids.add(entry.id);
      capabilities.set(key, { ...entry, axis });

      if (entry.status === 'unsupported') {
        if (!entry.reason) errors.push(`${key}: unsupported capabilities require a reason`);
        if (entry.evidence) errors.push(`${key}: unsupported capabilities must not claim executable evidence`);
      } else {
        if (!entry.evidence) errors.push(`${key}: ${String(entry.status)} capabilities require executable evidence`);
        else validateEvidencePath(provider, key, entry.evidence, errors);
      }
    }
  }

  const covered = new Set(cases.flatMap((contractCase) => Array.isArray(contractCase?.covers) ? contractCase.covers : []));
  for (const [key, capability] of capabilities) {
    if (capability.status === 'unsupported') {
      if (covered.has(key)) errors.push(`${key}: unsupported capability must not have a positive payload fixture`);
    }
  }
  for (const axis of MATRIX_AXES.filter((value) => value !== 'transports')) {
    const hasSupportedCapability = [...capabilities.values()]
      .some((capability) => capability.axis === axis && capability.status === 'supported');
    const hasSupportedFixture = [...covered]
      .some((key) => capabilities.get(key)?.axis === axis && capabilities.get(key)?.status === 'supported');
    if (hasSupportedCapability && !hasSupportedFixture) {
      errors.push(`matrix.${axis}: at least one supported capability requires a reviewed payload fixture`);
    }
  }
  return capabilities;
}

function validateEvidencePath(provider, key, rawPath, errors) {
  if (typeof rawPath !== 'string') return;
  const absolute = resolve(ROOT, normalize(rawPath));
  const local = relative(ROOT, absolute);
  let isFile = false;
  try {
    isFile = statSync(absolute).isFile();
  } catch {
    // Missing and inaccessible evidence both fail closed below.
  }
  if (local.startsWith('..') || local === '' || !isFile) {
    errors.push(`${key}: evidence path does not resolve to a repository file for ${provider}`);
  }
}

function validateCaseCoverage(label, contractCase, capabilities, errors) {
  if (!Array.isArray(contractCase?.covers)) return;
  const unique = new Set();
  for (const key of contractCase.covers) {
    if (unique.has(key)) errors.push(`${label}: duplicate coverage reference ${String(key)}`);
    unique.add(key);
    const capability = capabilities.get(key);
    if (!capability) {
      errors.push(`${label}: unknown coverage reference ${String(key)}`);
      continue;
    }
    if (capability.status === 'unsupported') {
      errors.push(`${label}: cannot cover unsupported capability ${String(key)}`);
    }
    if (capability.axis === 'actions') {
      if (contractCase.schema !== 'action-request') {
        errors.push(`${label}: action capability ${key} requires an action-request fixture`);
      } else if (contractCase.payload?.action !== capability.id) {
        errors.push(`${label}: action fixture must call ${capability.id}`);
      }
    } else if (capability.axis === 'events') {
      validateEventCoverage(label, key, capability.id, contractCase, errors);
    } else if (capability.axis === 'messages') {
      validateMessageCoverage(label, key, capability.id, contractCase, errors);
    }
  }
}

function validateEventCoverage(label, key, eventId, contractCase, errors) {
  const matcher = EVENT_CAPABILITY_MATCHERS[eventId];
  if (contractCase.schema !== 'event') {
    errors.push(`${label}: event capability ${key} requires a matching event fixture`);
    return;
  }
  if (!matcher) {
    errors.push(`${label}: event capability ${key} has no reviewed payload matcher`);
    return;
  }
  if (!matcher(contractCase.payload)) {
    errors.push(`${label}: event payload does not match ${key}`);
  }
  if (eventId.startsWith('message.') && !isObject(contractCase.payload?.sender)) {
    errors.push(`${label}: message event fixture for ${key} requires sender data`);
  }
}

function validateMessageCoverage(label, key, messageId, contractCase, errors) {
  const isMessageEvent = contractCase.schema === 'event'
    && ['message', 'message_sent'].includes(contractCase.payload?.post_type);
  if (!isMessageEvent) {
    errors.push(`${label}: message capability ${key} requires a message event fixture`);
    return;
  }
  const segmentType = messageId.startsWith('segment.') ? messageId.slice('segment.'.length) : null;
  if (!segmentType) {
    errors.push(`${label}: message capability ${key} has no reviewed segment mapping`);
    return;
  }
  const segments = Array.isArray(contractCase.payload?.message) ? contractCase.payload.message : [];
  if (!segments.some((segment) => segment?.type === segmentType)) {
    errors.push(`${label}: message fixture does not contain a ${segmentType} segment for ${key}`);
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}
