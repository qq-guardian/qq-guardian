import { buildDefaults } from './defaults.ts';
import { parseBoolean } from './boolean.ts';
import { normalizeIntelFeedUrls } from './intel.ts';
import type { GroupApprovalConfig, PluginConfig, RiskDetectorAction } from './types.ts';
import { hasAmbiguousQuantifiedAlternation, probePatternsInWorkers } from '../regex/index.ts';
import { normalizeOneBotId, type OneBotId } from '../../types/onebot.ts';

/** The only configuration format accepted by the normal runtime. */
export const CONFIG_SCHEMA_VERSION = 6;
export const CONFIG_FILENAME = 'config.json';

export type ExtensionJsonValue =
  | null
  | boolean
  | number
  | string
  | ExtensionJsonValue[]
  | { [key: string]: ExtensionJsonValue };

/**
 * Unknown legacy fields are retained outside the operational configuration.
 * Runtime consumers cannot observe this envelope unless a future adapter
 * explicitly claims and validates a namespace.
 */
export interface ConfigExtensionBag {
  legacy: Record<string, ExtensionJsonValue>;
}

export interface CanonicalConfigFile {
  schemaVersion: typeof CONFIG_SCHEMA_VERSION;
  config: PluginConfig;
  extensions?: ConfigExtensionBag;
}

export interface MigratedConfig {
  file: CanonicalConfigFile;
  /** Values intentionally retired from active configuration, never silently dropped. */
  retiredFields: string[];
  /** Safe unknown fields retained in the inert extension envelope. */
  preservedFields: string[];
}

export class ConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigValidationError';
  }
}

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const EXTENSION_MAX_BYTES = 64 * 1024;
const EXTENSION_MAX_DEPTH = 8;
const EXTENSION_MAX_ENTRIES = 256;
const EXTENSION_MAX_ARRAY_ITEMS = 128;
const EXTENSION_MAX_STRING_LENGTH = 4096;
const CONFIG_CLONE_MAX_DEPTH = 64;
const CONFIG_CLONE_MAX_ENTRIES = 100_000;
const SECRET_KEY_FRAGMENTS = [
  'apikey',
  'authorization',
  'bearer',
  'clientsecret',
  'credential',
  'password',
  'passwd',
  'privatekey',
  'secret',
  'token',
] as const;
const APPROVAL_ACTIONS = new Set<GroupApprovalConfig['action']>([
  'auto_approve',
  'auto_reject',
  'manual',
  'captcha',
]);
const RISK_ACTIONS = new Set<RiskDetectorAction>([
  'mute',
  'kick',
  'notify_admin',
  'log_only',
  'off',
]);
const CAPTCHA_TYPES = new Set(['math', 'text', 'question']);
const AI_PROVIDERS = new Set(['openai', 'anthropic', 'custom', 'disabled']);
const INTEL_ENFORCEMENT_MODES = new Set<PluginConfig['intel']['enforcementMode']>(['observe', 'enforce']);
const RETIRED_RISK_FIELDS = new Set([
  'threshold',
  'severeThreshold',
  'action',
  'severeAction',
  'weights',
  'detectors',
]);

type UnknownRecord = Record<string, unknown>;

function fail(path: string, message: string): never {
  throw new ConfigValidationError(`${path}: ${message}`);
}

function asRecord(value: unknown, path: string): UnknownRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(path, 'must be an object');
  }
  return value as UnknownRecord;
}

function assertKnownKeys(record: UnknownRecord, allowed: readonly string[], path: string): void {
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(record)) {
    if (UNSAFE_KEYS.has(key)) fail(path, `contains unsafe key ${JSON.stringify(key)}`);
    if (!allowedKeys.has(key)) fail(path, `contains unsupported key ${JSON.stringify(key)}`);
  }
}

function isSecretLikeKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return SECRET_KEY_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

function escapeJsonPointerSegment(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}

function appendJsonPointer(pointer: string, segment: string): string {
  return `${pointer}/${escapeJsonPointerSegment(segment)}`;
}

function decodeJsonPointer(path: string): string[] {
  if (!path.startsWith('/')) fail('$.extensions.legacy', 'field paths must be RFC 6901 JSON Pointers');
  return path.slice(1).split('/').map((segment) => {
    if (/~(?:[^01]|$)/.test(segment)) {
      fail(`$.extensions.legacy.${path}`, 'contains an invalid JSON Pointer escape');
    }
    return segment.replace(/~1/g, '/').replace(/~0/g, '~');
  });
}

interface ExtensionBudget {
  entries: number;
}

function cloneExtensionJsonValue(
  value: unknown,
  path: string,
  depth: number,
  budget: ExtensionBudget,
): ExtensionJsonValue {
  if (depth > EXTENSION_MAX_DEPTH) fail(path, `must not exceed ${EXTENSION_MAX_DEPTH} levels`);
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(path, 'must contain only finite JSON numbers');
    return value;
  }
  if (typeof value === 'string') {
    if (value.length > EXTENSION_MAX_STRING_LENGTH) {
      fail(path, `strings must not exceed ${EXTENSION_MAX_STRING_LENGTH} characters`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > EXTENSION_MAX_ARRAY_ITEMS) {
      fail(path, `arrays must not exceed ${EXTENSION_MAX_ARRAY_ITEMS} items`);
    }
    budget.entries += value.length;
    if (budget.entries > EXTENSION_MAX_ENTRIES) {
      fail(path, `must not exceed ${EXTENSION_MAX_ENTRIES} total entries`);
    }
    const result: ExtensionJsonValue[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !('value' in descriptor)) {
        fail(`${path}[${index}]`, 'arrays must contain only plain JSON data entries');
      }
      result.push(cloneExtensionJsonValue(descriptor.value, `${path}[${index}]`, depth + 1, budget));
    }
    return result;
  }
  if (typeof value !== 'object') fail(path, 'must contain only JSON values');

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(path, 'must contain only plain JSON objects');
  const source = value as UnknownRecord;
  const keys = Object.keys(source);
  budget.entries += keys.length;
  if (budget.entries > EXTENSION_MAX_ENTRIES) {
    fail(path, `must not exceed ${EXTENSION_MAX_ENTRIES} total entries`);
  }
  const result: Record<string, ExtensionJsonValue> = {};
  for (const key of keys) {
    if (UNSAFE_KEYS.has(key)) fail(path, `contains unsafe key ${JSON.stringify(key)}`);
    if (isSecretLikeKey(key)) fail(`${path}.${key}`, 'secret-like extension keys are not preserved');
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (!descriptor || !('value' in descriptor)) fail(`${path}.${key}`, 'must be a plain JSON data property');
    result[key] = cloneExtensionJsonValue(descriptor.value, `${path}.${key}`, depth + 1, budget);
  }
  return result;
}

export function validateConfigExtensions(value: unknown): ConfigExtensionBag {
  const envelope = asRecord(value, '$.extensions');
  assertKnownKeys(envelope, ['legacy'], '$.extensions');
  const legacy = asRecord(envelope.legacy, '$.extensions.legacy');
  const validated: Record<string, ExtensionJsonValue> = {};
  const budget: ExtensionBudget = { entries: Object.keys(legacy).length };
  if (budget.entries > EXTENSION_MAX_ENTRIES) {
    fail('$.extensions.legacy', `must not exceed ${EXTENSION_MAX_ENTRIES} total entries`);
  }
  for (const path of Object.keys(legacy).sort()) {
    if (path.length === 0 || path.length > 512) fail('$.extensions.legacy', 'field paths must be 1-512 characters long');
    const segments = decodeJsonPointer(path);
    if (segments.some((segment) => UNSAFE_KEYS.has(segment))) {
      fail(`$.extensions.legacy.${path}`, 'contains an unsafe path segment');
    }
    if (segments.some(isSecretLikeKey)) {
      fail(`$.extensions.legacy.${path}`, 'secret-like extension paths are not preserved');
    }
    validated[path] = cloneExtensionJsonValue(legacy[path], `$.extensions.legacy.${path}`, 1, budget);
  }
  const normalized = { legacy: validated };
  if (Buffer.byteLength(JSON.stringify(normalized), 'utf8') > EXTENSION_MAX_BYTES) {
    fail('$.extensions', `must not exceed ${EXTENSION_MAX_BYTES} serialized bytes`);
  }
  return normalized;
}

function asString(value: unknown, path: string, min = 0, max = 4096): string {
  if (typeof value !== 'string') fail(path, 'must be a string');
  if (value.length < min || value.length > max) fail(path, `must be ${min}-${max} characters long`);
  return value;
}

function asBoolean(value: unknown, path: string, allowLegacyScalars: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (allowLegacyScalars) {
    const parsed = parseBoolean(value);
    if (parsed !== undefined) return parsed;
  }
  fail(path, 'must be a boolean');
}

function asNumber(
  value: unknown,
  path: string,
  allowLegacyScalars: boolean,
  min: number,
  max: number,
  integer = true
): number {
  let normalized = value;
  if (allowLegacyScalars && typeof normalized === 'string' && /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(normalized)) {
    normalized = Number(normalized);
  }
  if (typeof normalized !== 'number' || !Number.isFinite(normalized)) {
    fail(path, 'must be a finite number');
  }
  if (integer && !Number.isSafeInteger(normalized)) fail(path, 'must be a safe integer');
  if (normalized < min || normalized > max) fail(path, `must be between ${min} and ${max}`);
  return normalized;
}

function asOneBotId(
  value: unknown,
  path: string,
  allowLegacyScalars: boolean,
  allowZero = false,
): OneBotId {
  if (!allowLegacyScalars && typeof value !== 'string') fail(path, 'must be a canonical decimal string');
  const normalized = normalizeOneBotId(value, { allowZero });
  if (normalized === null) fail(path, 'must be an unsigned 64-bit decimal identifier');
  if (!allowLegacyScalars && normalized !== value) fail(path, 'must use canonical decimal form without leading zeros');
  return normalized;
}

function asStringArray(value: unknown, path: string, maxItems = 100, maxItemLength = 1024): string[] {
  if (!Array.isArray(value)) fail(path, 'must be an array');
  if (value.length > maxItems) fail(path, `must contain at most ${maxItems} entries`);
  return value.map((entry, index) => asString(entry, `${path}[${index}]`, 0, maxItemLength));
}

function assertUrl(value: string, path: string, allowedProtocols: readonly string[]): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    fail(path, 'must be an absolute URL');
  }
  if (!allowedProtocols.includes(parsed.protocol)) {
    fail(path, `must use one of: ${allowedProtocols.join(', ')}`);
  }
  if (parsed.username || parsed.password) fail(path, 'must not contain credentials');
}

/**
 * This intentionally conservative check rejects invalid syntax and the common
 * nested/repeated-quantifier shapes that make moderator supplied patterns
 * pathological. Runtime matching still applies its own bounded execution.
 */
export function assertSafeRegularExpression(pattern: string, path = 'pattern'): void {
  if (pattern.length === 0 || pattern.length > 512) {
    fail(path, 'must be 1-512 characters long');
  }
  try {
    new RegExp(pattern);
  } catch (error) {
    fail(path, `is not a valid regular expression (${String(error)})`);
  }
  if (/\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)[+*{]/.test(pattern)) {
    fail(path, 'contains a nested quantifier');
  }
  if (/(?:\.\*|\.\+).{0,16}(?:\.\*|\.\+)/.test(pattern)) {
    fail(path, 'contains repeated broad quantifiers');
  }
  if (hasAmbiguousQuantifiedAlternation(pattern)) {
    fail(path, 'contains an ambiguous quantified alternation');
  }
}

function assertTimezone(timezone: string, path: string): void {
  try {
    Intl.DateTimeFormat('en-US', { timeZone: timezone });
  } catch {
    fail(path, 'must be a valid IANA timezone');
  }
}

function assertDuration(value: string, path: string): void {
  if (!/^\d+(?:s|m|h|d)$/.test(value)) fail(path, 'must use a positive <number>s|m|h|d duration');
  const amount = Number(value.slice(0, -1));
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 3650) {
    fail(path, 'is outside the supported duration range');
  }
}

function assertClock(value: string, path: string): void {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) fail(path, 'must use HH:MM 24-hour time');
}

function assertApprovalAction(value: string, path: string): asserts value is GroupApprovalConfig['action'] {
  if (!APPROVAL_ACTIONS.has(value as GroupApprovalConfig['action'])) {
    fail(path, `must be one of: ${[...APPROVAL_ACTIONS].join(', ')}`);
  }
}

function assertRiskAction(value: string, path: string): asserts value is RiskDetectorAction {
  if (!RISK_ACTIONS.has(value as RiskDetectorAction)) {
    fail(path, `must be one of: ${[...RISK_ACTIONS].join(', ')}`);
  }
}

interface CloneBudget {
  active: WeakSet<object>;
  entries: number;
}

function cloneJsonValue(
  value: unknown,
  path = '$',
  depth = 0,
  budget: CloneBudget = { active: new WeakSet<object>(), entries: 0 },
): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (depth > CONFIG_CLONE_MAX_DEPTH) fail(path, `must not exceed ${CONFIG_CLONE_MAX_DEPTH} levels`);
  if (budget.active.has(value)) fail(path, 'must not contain circular references');
  budget.active.add(value);
  if (Array.isArray(value)) {
    budget.entries += value.length;
    if (budget.entries > CONFIG_CLONE_MAX_ENTRIES) {
      fail(path, `must not exceed ${CONFIG_CLONE_MAX_ENTRIES} aggregate entries`);
    }
    const result = value.map((entry, index) => cloneJsonValue(entry, `${path}[${index}]`, depth + 1, budget));
    budget.active.delete(value);
    return result;
  }
  const result: UnknownRecord = {};
  const source = value as UnknownRecord;
  const keys = Object.keys(source);
  budget.entries += keys.length;
  if (budget.entries > CONFIG_CLONE_MAX_ENTRIES) {
    fail(path, `must not exceed ${CONFIG_CLONE_MAX_ENTRIES} aggregate entries`);
  }
  for (const key of keys) {
    if (UNSAFE_KEYS.has(key)) fail('$', `contains unsafe key ${JSON.stringify(key)}`);
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (!descriptor || !('value' in descriptor)) fail(`${path}.${key}`, 'must be a plain data property');
    result[key] = cloneJsonValue(descriptor.value, `${path}.${key}`, depth + 1, budget);
  }
  budget.active.delete(value);
  return result;
}

/** A safe immutable merge used only to build a candidate, never to silently skip keys. */
export function mergeConfigValues(target: unknown, source: unknown): unknown {
  if (source === undefined) return cloneJsonValue(target);
  if (source === null) return null;
  if (typeof source !== 'object' || Array.isArray(source)) return cloneJsonValue(source);
  if (typeof target !== 'object' || target === null || Array.isArray(target)) return cloneJsonValue(source);

  const result = cloneJsonValue(target) as UnknownRecord;
  for (const [key, value] of Object.entries(source as UnknownRecord)) {
    if (UNSAFE_KEYS.has(key)) fail('$', `contains unsafe key ${JSON.stringify(key)}`);
    result[key] = mergeConfigValues(result[key], value);
  }
  return result;
}

function captureUnknownFields(
  record: UnknownRecord,
  allowed: readonly string[],
  displayPath: string,
  pointer: string,
  preserved: UnknownRecord,
): void {
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(record)) {
    if (UNSAFE_KEYS.has(key)) fail(displayPath, `contains unsafe key ${JSON.stringify(key)}`);
    if (allowedKeys.has(key)) continue;
    const path = appendJsonPointer(pointer, key);
    preserved[path] = record[key];
    delete record[key];
  }
}

function captureLegacyConfigExtensions(candidate: UnknownRecord): ConfigExtensionBag | undefined {
  const preserved: UnknownRecord = Object.create(null) as UnknownRecord;
  const defaults = buildDefaults();
  captureUnknownFields(candidate, Object.keys(defaults), 'config', '/config', preserved);

  const sections: Array<[keyof PluginConfig, readonly string[]]> = [
    ['core', ['selfId', 'superAdmins', 'timezone']],
    ['webui', ['jwtSecret', 'jwtExpiresIn', 'refreshExpiresIn']],
    ['approval', [
      'defaultAction', 'groups', 'pendingTtlSeconds', 'defaultGroupEnabled',
      'useBuiltinRejectKeywords', 'useBuiltinApproveKeywords', 'realtimeSyncEnabled', 'syncIntervalSeconds',
    ]],
    ['captcha', ['ttlSeconds', 'maxAttempts', 'types', 'questions']],
    ['risk', [
      'enabled', 'detectorActions', 'muteDurationSeconds', 'aiMinScore', 'recallMessage',
      ...RETIRED_RISK_FIELDS,
    ]],
    ['punishment', ['defaultMuteDurationSeconds', 'escalateToKickAfter', 'escalateToBlacklistAfter']],
    ['blacklist', ['autoKickOnJoin']],
    ['auth', ['maxLoginAttempts', 'lockoutSeconds', 'rateLimitRequests', 'rateLimitWindowMs']],
    ['monitor', ['intervalMs', 'diskAlertMb', 'memoryAlertPercent']],
    ['update', ['githubRepo', 'autoCheckOnStartup']],
    ['ai', ['provider', 'baseUrl', 'apiKey', 'model', 'timeoutMs', 'riskPrompt']],
    ['commands', ['enabled', 'prefix']],
    ['intel', ['enabled', 'enforcementMode', 'feedUrls', 'feedPins', 'refreshIntervalSeconds']],
  ];
  for (const [section, allowed] of sections) {
    if (candidate[section] === undefined) continue;
    const record = asRecord(candidate[section], `config.${section}`);
    captureUnknownFields(record, allowed, `config.${section}`, `/config/${section}`, preserved);
  }

  const approval = candidate.approval as UnknownRecord | undefined;
  if (approval?.groups !== undefined) {
    const groups = asRecord(approval.groups, 'config.approval.groups');
    const groupDefaults: readonly string[] = [
      'enabled', 'action', 'approveKeywords', 'rejectKeywords', 'approvePatterns', 'rejectPatterns',
      'rejectReason', 'riskEnabled', 'autoKickBlacklisted', 'notifyOnRisk', 'notifyOnJoin', 'groupName',
      'welcomeEnabled', 'welcomeTemplate', 'curfewEnabled', 'curfewStart', 'curfewEnd',
    ];
    for (const [groupId, value] of Object.entries(groups)) {
      const group = asRecord(value, `config.approval.groups.${groupId}`);
      captureUnknownFields(
        group,
        groupDefaults,
        `config.approval.groups.${groupId}`,
        `/config/approval/groups/${escapeJsonPointerSegment(groupId)}`,
        preserved,
      );
    }
  }

  const captcha = candidate.captcha as UnknownRecord | undefined;
  if (captcha?.questions !== undefined && Array.isArray(captcha.questions)) {
    captcha.questions.forEach((value, index) => {
      const question = asRecord(value, `config.captcha.questions[${index}]`);
      captureUnknownFields(
        question,
        ['q', 'a'],
        `config.captcha.questions[${index}]`,
        `/config/captcha/questions/${index}`,
        preserved,
      );
    });
  }

  const risk = candidate.risk as UnknownRecord | undefined;
  if (risk?.detectorActions !== undefined) {
    const detectorActions = asRecord(risk.detectorActions, 'config.risk.detectorActions');
    captureUnknownFields(
      detectorActions,
      Object.keys(defaults.risk.detectorActions),
      'config.risk.detectorActions',
      '/config/risk/detectorActions',
      preserved,
    );
  }
  if (risk?.detectors !== undefined) {
    const detectors = asRecord(risk.detectors, 'config.risk.detectors');
    captureUnknownFields(
      detectors,
      Object.keys(defaults.risk.detectorActions),
      'config.risk.detectors',
      '/config/risk/detectors',
      preserved,
    );
  }

  if (Object.keys(preserved).length === 0) return undefined;
  return validateConfigExtensions({ legacy: preserved });
}

function normalizeGroupConfig(
  value: unknown,
  groupId: string,
  config: PluginConfig,
  allowLegacyScalars: boolean
): GroupApprovalConfig {
  if (normalizeOneBotId(groupId) !== groupId) {
    fail(`config.approval.groups.${JSON.stringify(groupId)}`, 'must be keyed by a positive QQ group ID');
  }
  const group = asRecord(value, `config.approval.groups.${groupId}`);
  const defaultGroup: GroupApprovalConfig = {
    enabled: config.approval.defaultGroupEnabled,
    action: config.approval.defaultAction,
    approveKeywords: [],
    rejectKeywords: [],
    approvePatterns: [],
    rejectPatterns: [],
    rejectReason: '不符合入群要求',
    riskEnabled: config.risk.enabled,
    autoKickBlacklisted: config.blacklist.autoKickOnJoin,
    notifyOnRisk: false,
    notifyOnJoin: false,
    groupName: '',
    welcomeEnabled: false,
    welcomeTemplate: '',
    curfewEnabled: false,
    curfewStart: '23:00',
    curfewEnd: '07:00',
  };
  const candidate = mergeConfigValues(defaultGroup, group) as UnknownRecord;
  assertKnownKeys(candidate, Object.keys(defaultGroup), `config.approval.groups.${groupId}`);

  const action = asString(candidate.action, `config.approval.groups.${groupId}.action`, 1, 32);
  assertApprovalAction(action, `config.approval.groups.${groupId}.action`);
  const approvePatterns = asStringArray(candidate.approvePatterns, `config.approval.groups.${groupId}.approvePatterns`, 100, 512);
  const rejectPatterns = asStringArray(candidate.rejectPatterns, `config.approval.groups.${groupId}.rejectPatterns`, 100, 512);
  approvePatterns.forEach((pattern, index) => assertSafeRegularExpression(pattern, `config.approval.groups.${groupId}.approvePatterns[${index}]`));
  rejectPatterns.forEach((pattern, index) => assertSafeRegularExpression(pattern, `config.approval.groups.${groupId}.rejectPatterns[${index}]`));

  const curfewStart = asString(candidate.curfewStart, `config.approval.groups.${groupId}.curfewStart`, 5, 5);
  const curfewEnd = asString(candidate.curfewEnd, `config.approval.groups.${groupId}.curfewEnd`, 5, 5);
  assertClock(curfewStart, `config.approval.groups.${groupId}.curfewStart`);
  assertClock(curfewEnd, `config.approval.groups.${groupId}.curfewEnd`);

  return {
    enabled: asBoolean(candidate.enabled, `config.approval.groups.${groupId}.enabled`, allowLegacyScalars),
    action,
    approveKeywords: asStringArray(candidate.approveKeywords, `config.approval.groups.${groupId}.approveKeywords`),
    rejectKeywords: asStringArray(candidate.rejectKeywords, `config.approval.groups.${groupId}.rejectKeywords`),
    approvePatterns,
    rejectPatterns,
    rejectReason: asString(candidate.rejectReason, `config.approval.groups.${groupId}.rejectReason`, 0, 512),
    riskEnabled: asBoolean(candidate.riskEnabled, `config.approval.groups.${groupId}.riskEnabled`, allowLegacyScalars),
    autoKickBlacklisted: asBoolean(candidate.autoKickBlacklisted, `config.approval.groups.${groupId}.autoKickBlacklisted`, allowLegacyScalars),
    notifyOnRisk: asBoolean(candidate.notifyOnRisk, `config.approval.groups.${groupId}.notifyOnRisk`, allowLegacyScalars),
    notifyOnJoin: asBoolean(candidate.notifyOnJoin, `config.approval.groups.${groupId}.notifyOnJoin`, allowLegacyScalars),
    groupName: asString(candidate.groupName, `config.approval.groups.${groupId}.groupName`, 0, 256),
    welcomeEnabled: asBoolean(candidate.welcomeEnabled, `config.approval.groups.${groupId}.welcomeEnabled`, allowLegacyScalars),
    welcomeTemplate: asString(candidate.welcomeTemplate, `config.approval.groups.${groupId}.welcomeTemplate`, 0, 4096),
    curfewEnabled: asBoolean(candidate.curfewEnabled, `config.approval.groups.${groupId}.curfewEnabled`, allowLegacyScalars),
    curfewStart,
    curfewEnd,
  };
}

function normalizeConfig(value: unknown, allowLegacyScalars: boolean): PluginConfig {
  const config = asRecord(value, 'config');
  const defaults = buildDefaults();
  assertKnownKeys(config, Object.keys(defaults), 'config');
  for (const key of Object.keys(defaults)) {
    if (!(key in config)) fail('config', `is missing required section ${JSON.stringify(key)}`);
  }

  const core = asRecord(config.core, 'config.core');
  assertKnownKeys(core, ['selfId', 'superAdmins', 'timezone'], 'config.core');
  const selfId = asOneBotId(core.selfId, 'config.core.selfId', allowLegacyScalars, true);
  if (!Array.isArray(core.superAdmins)) fail('config.core.superAdmins', 'must be an array');
  if (core.superAdmins.length > 100) fail('config.core.superAdmins', 'must contain at most 100 entries');
  const superAdmins = core.superAdmins.map((id, index) =>
    asOneBotId(id, `config.core.superAdmins[${index}]`, allowLegacyScalars)
  );
  if (new Set(superAdmins).size !== superAdmins.length) fail('config.core.superAdmins', 'must not contain duplicates');
  const timezone = asString(core.timezone, 'config.core.timezone', 1, 128);
  assertTimezone(timezone, 'config.core.timezone');

  const webui = asRecord(config.webui, 'config.webui');
  assertKnownKeys(webui, ['jwtSecret', 'jwtExpiresIn', 'refreshExpiresIn'], 'config.webui');
  const jwtSecret = asString(webui.jwtSecret, 'config.webui.jwtSecret', 16, 512);
  const jwtExpiresIn = asString(webui.jwtExpiresIn, 'config.webui.jwtExpiresIn', 2, 16);
  const refreshExpiresIn = asString(webui.refreshExpiresIn, 'config.webui.refreshExpiresIn', 2, 16);
  assertDuration(jwtExpiresIn, 'config.webui.jwtExpiresIn');
  assertDuration(refreshExpiresIn, 'config.webui.refreshExpiresIn');

  const approval = asRecord(config.approval, 'config.approval');
  assertKnownKeys(approval, [
    'defaultAction', 'groups', 'pendingTtlSeconds', 'defaultGroupEnabled',
    'useBuiltinRejectKeywords', 'useBuiltinApproveKeywords', 'realtimeSyncEnabled', 'syncIntervalSeconds',
  ], 'config.approval');
  const defaultAction = asString(approval.defaultAction, 'config.approval.defaultAction', 1, 32);
  assertApprovalAction(defaultAction, 'config.approval.defaultAction');
  const approvalBase = {
    defaultAction,
    groups: {},
    pendingTtlSeconds: asNumber(approval.pendingTtlSeconds, 'config.approval.pendingTtlSeconds', allowLegacyScalars, 60, 7 * 24 * 60 * 60),
    defaultGroupEnabled: asBoolean(approval.defaultGroupEnabled, 'config.approval.defaultGroupEnabled', allowLegacyScalars),
    useBuiltinRejectKeywords: asBoolean(approval.useBuiltinRejectKeywords, 'config.approval.useBuiltinRejectKeywords', allowLegacyScalars),
    useBuiltinApproveKeywords: asBoolean(approval.useBuiltinApproveKeywords, 'config.approval.useBuiltinApproveKeywords', allowLegacyScalars),
    realtimeSyncEnabled: asBoolean(approval.realtimeSyncEnabled, 'config.approval.realtimeSyncEnabled', allowLegacyScalars),
    syncIntervalSeconds: asNumber(approval.syncIntervalSeconds, 'config.approval.syncIntervalSeconds', allowLegacyScalars, 10, 24 * 60 * 60),
  };

  const captcha = asRecord(config.captcha, 'config.captcha');
  assertKnownKeys(captcha, ['ttlSeconds', 'maxAttempts', 'types', 'questions'], 'config.captcha');
  if (!Array.isArray(captcha.types) || captcha.types.length === 0 || captcha.types.length > CAPTCHA_TYPES.size) {
    fail('config.captcha.types', 'must contain one or more supported types');
  }
  const captchaTypes = captcha.types.map((type, index) => {
    const normalized = asString(type, `config.captcha.types[${index}]`, 1, 16);
    if (!CAPTCHA_TYPES.has(normalized)) fail(`config.captcha.types[${index}]`, 'is not supported');
    return normalized as 'math' | 'text' | 'question';
  });
  if (new Set(captchaTypes).size !== captchaTypes.length) fail('config.captcha.types', 'must not contain duplicates');
  if (!Array.isArray(captcha.questions) || captcha.questions.length > 100) fail('config.captcha.questions', 'must contain at most 100 entries');
  const questions = captcha.questions.map((question, index) => {
    const entry = asRecord(question, `config.captcha.questions[${index}]`);
    assertKnownKeys(entry, ['q', 'a'], `config.captcha.questions[${index}]`);
    return {
      q: asString(entry.q, `config.captcha.questions[${index}].q`, 1, 512),
      a: asString(entry.a, `config.captcha.questions[${index}].a`, 1, 512),
    };
  });

  const risk = asRecord(config.risk, 'config.risk');
  const detectorKeys = Object.keys(defaults.risk.detectorActions);
  assertKnownKeys(risk, ['enabled', 'detectorActions', 'muteDurationSeconds', 'aiMinScore', 'recallMessage'], 'config.risk');
  const detectorActionsRaw = asRecord(risk.detectorActions, 'config.risk.detectorActions');
  assertKnownKeys(detectorActionsRaw, detectorKeys, 'config.risk.detectorActions');
  for (const key of detectorKeys) {
    if (!(key in detectorActionsRaw)) fail('config.risk.detectorActions', `is missing ${JSON.stringify(key)}`);
  }
  const detectorActions = Object.fromEntries(detectorKeys.map((key) => {
    const action = asString(detectorActionsRaw[key], `config.risk.detectorActions.${key}`, 1, 32);
    assertRiskAction(action, `config.risk.detectorActions.${key}`);
    return [key, action];
  })) as PluginConfig['risk']['detectorActions'];

  const punishment = asRecord(config.punishment, 'config.punishment');
  assertKnownKeys(punishment, ['defaultMuteDurationSeconds', 'escalateToKickAfter', 'escalateToBlacklistAfter'], 'config.punishment');
  const blacklist = asRecord(config.blacklist, 'config.blacklist');
  assertKnownKeys(blacklist, ['autoKickOnJoin'], 'config.blacklist');
  const auth = asRecord(config.auth, 'config.auth');
  assertKnownKeys(auth, ['maxLoginAttempts', 'lockoutSeconds', 'rateLimitRequests', 'rateLimitWindowMs'], 'config.auth');
  const monitor = asRecord(config.monitor, 'config.monitor');
  assertKnownKeys(monitor, ['intervalMs', 'diskAlertMb', 'memoryAlertPercent'], 'config.monitor');
  const update = asRecord(config.update, 'config.update');
  assertKnownKeys(update, ['githubRepo', 'autoCheckOnStartup'], 'config.update');
  const githubRepo = asString(update.githubRepo, 'config.update.githubRepo', 3, 256);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(githubRepo)) fail('config.update.githubRepo', 'must use owner/repository format');
  const ai = asRecord(config.ai, 'config.ai');
  assertKnownKeys(ai, ['provider', 'baseUrl', 'apiKey', 'model', 'timeoutMs', 'riskPrompt'], 'config.ai');
  const provider = asString(ai.provider, 'config.ai.provider', 1, 32);
  if (!AI_PROVIDERS.has(provider)) fail('config.ai.provider', 'is not supported');
  const baseUrl = asString(ai.baseUrl, 'config.ai.baseUrl', 1, 2048);
  assertUrl(baseUrl, 'config.ai.baseUrl', ['https:', 'http:']);
  const commands = asRecord(config.commands, 'config.commands');
  assertKnownKeys(commands, ['enabled', 'prefix'], 'config.commands');
  const intel = asRecord(config.intel, 'config.intel');
  assertKnownKeys(intel, ['enabled', 'enforcementMode', 'feedUrls', 'feedPins', 'refreshIntervalSeconds'], 'config.intel');
  const rawFeedUrls = asStringArray(intel.feedUrls, 'config.intel.feedUrls', 20, 2048);
  rawFeedUrls.forEach((url, index) => assertUrl(url, `config.intel.feedUrls[${index}]`, ['https:']));
  const feedUrls = normalizeIntelFeedUrls(rawFeedUrls);
  const enforcementMode = asString(
    intel.enforcementMode,
    'config.intel.enforcementMode',
    1,
    16,
  ) as PluginConfig['intel']['enforcementMode'];
  if (!INTEL_ENFORCEMENT_MODES.has(enforcementMode)) {
    fail('config.intel.enforcementMode', 'must be observe or enforce');
  }
  const rawFeedPins = asRecord(intel.feedPins, 'config.intel.feedPins');
  if (Object.keys(rawFeedPins).length > 20) fail('config.intel.feedPins', 'must contain at most 20 entries');
  const feedPins: Record<string, string> = {};
  const configuredFeeds = new Set(feedUrls);
  for (const [rawUrl, rawDigest] of Object.entries(rawFeedPins)) {
    if (UNSAFE_KEYS.has(rawUrl)) fail('config.intel.feedPins', `contains unsafe key ${JSON.stringify(rawUrl)}`);
    assertUrl(rawUrl, `config.intel.feedPins.${rawUrl}`, ['https:']);
    const [url] = normalizeIntelFeedUrls([rawUrl]);
    if (!url || !configuredFeeds.has(url)) {
      fail(`config.intel.feedPins.${rawUrl}`, 'must identify a configured feed URL');
    }
    if (feedPins[url] !== undefined) {
      fail(`config.intel.feedPins.${rawUrl}`, 'duplicates a canonical feed URL');
    }
    const digest = asString(rawDigest, `config.intel.feedPins.${rawUrl}`, 64, 64).toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(digest)) {
      fail(`config.intel.feedPins.${rawUrl}`, 'must be a SHA-256 hex digest');
    }
    feedPins[url] = digest;
  }
  if (enforcementMode === 'enforce') {
    for (const url of feedUrls) {
      if (!feedPins[url]) fail('config.intel.feedPins', `must pin ${JSON.stringify(url)} before enforcement`);
    }
  }

  const normalized: PluginConfig = {
    core: { selfId, superAdmins, timezone },
    webui: { jwtSecret, jwtExpiresIn, refreshExpiresIn },
    approval: approvalBase,
    captcha: {
      ttlSeconds: asNumber(captcha.ttlSeconds, 'config.captcha.ttlSeconds', allowLegacyScalars, 30, 24 * 60 * 60),
      maxAttempts: asNumber(captcha.maxAttempts, 'config.captcha.maxAttempts', allowLegacyScalars, 1, 20),
      types: captchaTypes,
      questions,
    },
    risk: {
      enabled: asBoolean(risk.enabled, 'config.risk.enabled', allowLegacyScalars),
      detectorActions,
      muteDurationSeconds: asNumber(risk.muteDurationSeconds, 'config.risk.muteDurationSeconds', allowLegacyScalars, 1, 30 * 24 * 60 * 60),
      aiMinScore: asNumber(risk.aiMinScore, 'config.risk.aiMinScore', allowLegacyScalars, 0, 100),
      recallMessage: asBoolean(risk.recallMessage, 'config.risk.recallMessage', allowLegacyScalars),
    },
    punishment: {
      defaultMuteDurationSeconds: asNumber(punishment.defaultMuteDurationSeconds, 'config.punishment.defaultMuteDurationSeconds', allowLegacyScalars, 1, 30 * 24 * 60 * 60),
      escalateToKickAfter: asNumber(punishment.escalateToKickAfter, 'config.punishment.escalateToKickAfter', allowLegacyScalars, 0, 1000),
      escalateToBlacklistAfter: asNumber(punishment.escalateToBlacklistAfter, 'config.punishment.escalateToBlacklistAfter', allowLegacyScalars, 0, 1000),
    },
    blacklist: { autoKickOnJoin: asBoolean(blacklist.autoKickOnJoin, 'config.blacklist.autoKickOnJoin', allowLegacyScalars) },
    auth: {
      maxLoginAttempts: asNumber(auth.maxLoginAttempts, 'config.auth.maxLoginAttempts', allowLegacyScalars, 1, 100),
      lockoutSeconds: asNumber(auth.lockoutSeconds, 'config.auth.lockoutSeconds', allowLegacyScalars, 1, 30 * 24 * 60 * 60),
      rateLimitRequests: asNumber(auth.rateLimitRequests, 'config.auth.rateLimitRequests', allowLegacyScalars, 1, 100_000),
      rateLimitWindowMs: asNumber(auth.rateLimitWindowMs, 'config.auth.rateLimitWindowMs', allowLegacyScalars, 1000, 24 * 60 * 60 * 1000),
    },
    monitor: {
      intervalMs: asNumber(monitor.intervalMs, 'config.monitor.intervalMs', allowLegacyScalars, 1000, 24 * 60 * 60 * 1000),
      diskAlertMb: asNumber(monitor.diskAlertMb, 'config.monitor.diskAlertMb', allowLegacyScalars, 0, 10_000_000),
      memoryAlertPercent: asNumber(monitor.memoryAlertPercent, 'config.monitor.memoryAlertPercent', allowLegacyScalars, 1, 100),
    },
    update: { githubRepo, autoCheckOnStartup: asBoolean(update.autoCheckOnStartup, 'config.update.autoCheckOnStartup', allowLegacyScalars) },
    ai: {
      provider: provider as PluginConfig['ai']['provider'],
      baseUrl,
      apiKey: asString(ai.apiKey, 'config.ai.apiKey', 0, 4096),
      model: asString(ai.model, 'config.ai.model', 1, 256),
      timeoutMs: asNumber(ai.timeoutMs, 'config.ai.timeoutMs', allowLegacyScalars, 1000, 120_000),
      riskPrompt: asString(ai.riskPrompt, 'config.ai.riskPrompt', 1, 16_384),
    },
    commands: {
      enabled: asBoolean(commands.enabled, 'config.commands.enabled', allowLegacyScalars),
      prefix: asString(commands.prefix, 'config.commands.prefix', 1, 64),
    },
    intel: {
      enabled: asBoolean(intel.enabled, 'config.intel.enabled', allowLegacyScalars),
      enforcementMode,
      feedUrls,
      feedPins,
      refreshIntervalSeconds: asNumber(intel.refreshIntervalSeconds, 'config.intel.refreshIntervalSeconds', allowLegacyScalars, 60, 24 * 60 * 60),
    },
  };

  const rawGroups = asRecord(approval.groups, 'config.approval.groups');
  const normalizedGroups: Record<string, GroupApprovalConfig> = {};
  for (const [rawGroupId, group] of Object.entries(rawGroups)) {
    const groupId = asOneBotId(rawGroupId, `config.approval.groups.${JSON.stringify(rawGroupId)}`, allowLegacyScalars);
    if (normalizedGroups[groupId] !== undefined) {
      fail('config.approval.groups', `contains duplicate canonical group ID ${groupId}`);
    }
    normalizedGroups[groupId] = normalizeGroupConfig(group, groupId, normalized, allowLegacyScalars);
  }
  normalized.approval.groups = normalizedGroups;
  return normalized;
}

export function validateCanonicalConfig(config: unknown): PluginConfig {
  return normalizeConfig(config, false);
}

export function validateCanonicalConfigFile(value: unknown): CanonicalConfigFile {
  const file = asRecord(value, '$');
  assertKnownKeys(file, ['schemaVersion', 'config', 'extensions'], '$');
  if (file.schemaVersion !== CONFIG_SCHEMA_VERSION) {
    fail('$.schemaVersion', `must equal ${CONFIG_SCHEMA_VERSION}; run the staged migration first`);
  }
  const config = validateCanonicalConfig(file.config);
  const extensions = file.extensions === undefined ? undefined : validateConfigExtensions(file.extensions);
  return extensions === undefined
    ? { schemaVersion: CONFIG_SCHEMA_VERSION, config }
    : { schemaVersion: CONFIG_SCHEMA_VERSION, config, extensions };
}

/**
 * Runs the expensive ReDoS check outside the main thread for every persisted
 * group-approval pattern. Structural validation remains synchronous so normal
 * config edits can fail immediately; boot and shadow migration call this
 * before accepting a persisted generation.
 */
export async function validatePersistedApprovalPatterns(config: PluginConfig): Promise<void> {
  const entries = Object.entries(config.approval.groups).flatMap(([groupId, group]) => [
    ...group.approvePatterns.map((pattern, index) => ({
      pattern,
      path: `config.approval.groups.${groupId}.approvePatterns[${index}]`,
    })),
    ...group.rejectPatterns.map((pattern, index) => ({
      pattern,
      path: `config.approval.groups.${groupId}.rejectPatterns[${index}]`,
    })),
  ]);

  for (const { pattern, path } of entries) assertSafeRegularExpression(pattern, path);
  const verdicts = await probePatternsInWorkers(entries.map(({ pattern }) => pattern));
  for (const { pattern, path } of entries) {
    if (!verdicts.get(pattern)) fail(path, 'failed performance test (possible ReDoS)');
  }
}

/**
 * Converts legacy input only while constructing a shadow candidate. It is not
 * used by normal configuration loading, so legacy compatibility cannot linger
 * in the runtime path after a successful cutover.
 */
export function migrateLegacyConfig(value: unknown): MigratedConfig {
  const source = asRecord(value, '$');
  const wrapped = 'config' in source;
  const versionValue = wrapped ? source.schemaVersion : 0;
  const sourceVersion = versionValue === undefined ? 0 : asNumber(versionValue, '$.schemaVersion', true, 0, CONFIG_SCHEMA_VERSION, true);
  if (sourceVersion > CONFIG_SCHEMA_VERSION) {
    fail('$.schemaVersion', `cannot migrate newer schema ${sourceVersion}`);
  }
  if (wrapped && sourceVersion === CONFIG_SCHEMA_VERSION) {
    const file = validateCanonicalConfigFile(value);
    return {
      file,
      retiredFields: [],
      preservedFields: Object.keys(file.extensions?.legacy ?? {}).sort(),
    };
  }

  const sourceEnvelope = cloneJsonValue(source) as UnknownRecord;
  const wrapperExtensions: UnknownRecord = Object.create(null) as UnknownRecord;
  if (wrapped) captureUnknownFields(sourceEnvelope, ['schemaVersion', 'config'], '$', '', wrapperExtensions);
  const sourceConfig = asRecord(wrapped ? sourceEnvelope.config : sourceEnvelope, wrapped ? '$.config' : '$');
  const rawRisk = sourceConfig.risk === undefined ? undefined : asRecord(sourceConfig.risk, 'config.risk');
  const retiredFields: string[] = [];
  let candidateSource = cloneJsonValue(sourceConfig) as UnknownRecord;
  const configExtensions = captureLegacyConfigExtensions(candidateSource);
  const legacyExtensions = {
    ...wrapperExtensions,
    ...(configExtensions?.legacy ?? {}),
  };
  const extensions = Object.keys(legacyExtensions).length === 0
    ? undefined
    : validateConfigExtensions({ legacy: legacyExtensions });

  if (rawRisk) {
    const candidateRisk = asRecord(candidateSource.risk, 'config.risk');
    const detectors = candidateRisk.detectors;
    if (candidateRisk.detectorActions === undefined && detectors !== undefined) {
      const legacyDetectors = asRecord(detectors, 'config.risk.detectors');
      const knownDetectors = Object.keys(buildDefaults().risk.detectorActions);
      assertKnownKeys(legacyDetectors, knownDetectors, 'config.risk.detectors');
      const legacyAction = candidateRisk.action === undefined ? 'mute' : asString(candidateRisk.action, 'config.risk.action', 1, 32);
      assertRiskAction(legacyAction, 'config.risk.action');
      candidateRisk.detectorActions = Object.fromEntries(knownDetectors.map((detector) => [
        detector,
        asBoolean(legacyDetectors[detector] ?? false, `config.risk.detectors.${detector}`, true) ? legacyAction : 'off',
      ]));
    }
    for (const field of RETIRED_RISK_FIELDS) {
      if (field in candidateRisk) {
        delete candidateRisk[field];
        retiredFields.push(`config.risk.${field}`);
      }
    }
  }

  const defaults = buildDefaults();
  const merged = mergeConfigValues(defaults, candidateSource) as UnknownRecord;
  // Dynamic group records need an explicit complete base before strict validation.
  const rawGroups = asRecord((merged.approval as UnknownRecord).groups, 'config.approval.groups');
  const sourceGroups = asRecord((candidateSource.approval as UnknownRecord | undefined)?.groups ?? {}, 'config.approval.groups');
  const globalCandidate = merged as unknown as PluginConfig;
  const normalizedGroups: UnknownRecord = {};
  for (const [groupId, group] of Object.entries(sourceGroups)) {
    const groupRecord = asRecord(group, `config.approval.groups.${groupId}`);
    const base: GroupApprovalConfig = {
      enabled: globalCandidate.approval.defaultGroupEnabled,
      action: globalCandidate.approval.defaultAction,
      approveKeywords: [],
      rejectKeywords: [],
      approvePatterns: [],
      rejectPatterns: [],
      rejectReason: '不符合入群要求',
      riskEnabled: globalCandidate.risk.enabled,
      autoKickBlacklisted: globalCandidate.blacklist.autoKickOnJoin,
      notifyOnRisk: false,
      notifyOnJoin: false,
      groupName: '',
      welcomeEnabled: false,
      welcomeTemplate: '',
      curfewEnabled: false,
      curfewStart: '23:00',
      curfewEnd: '07:00',
    };
    normalizedGroups[groupId] = mergeConfigValues(base, groupRecord);
  }
  // `merged` includes only source groups because defaults has an empty record;
  // assigning explicitly makes that invariant clear and avoids stale aliases.
  (merged.approval as UnknownRecord).groups = Object.keys(sourceGroups).length === 0 ? rawGroups : normalizedGroups;
  const config = normalizeConfig(merged, true);
  const file: CanonicalConfigFile = extensions === undefined
    ? { schemaVersion: CONFIG_SCHEMA_VERSION, config }
    : { schemaVersion: CONFIG_SCHEMA_VERSION, config, extensions };
  return { file, retiredFields, preservedFields: Object.keys(extensions?.legacy ?? {}).sort() };
}

export function createCanonicalConfigFile(
  config: PluginConfig,
  extensions?: ConfigExtensionBag,
): CanonicalConfigFile {
  const validatedConfig = validateCanonicalConfig(config);
  const validatedExtensions = extensions === undefined ? undefined : validateConfigExtensions(extensions);
  return validatedExtensions === undefined
    ? { schemaVersion: CONFIG_SCHEMA_VERSION, config: validatedConfig }
    : { schemaVersion: CONFIG_SCHEMA_VERSION, config: validatedConfig, extensions: validatedExtensions };
}
