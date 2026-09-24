import { normalizeOneBotId, normalizeOneBotMessageId } from '../types/onebot.ts';
import type {
  OneBotCapabilities,
  OneBotGateway,
  OneBotProviderIdentity,
  ProviderConnectionState,
} from '../ports/runtime.ts';

export type OneBotProviderErrorCategory =
  | 'transport'
  | 'connection'
  | 'authentication'
  | 'timeout'
  | 'protocol'
  | 'logical'
  | 'unsupported'
  | 'invalid_parameters'
  | 'invalid_response'
  | 'capability_mismatch'
  | 'adapter_internal';

export const GUARDIAN_ONEBOT_ACTIONS = Object.freeze([
  'get_login_info',
  'get_group_list',
  'get_group_member_info',
  'get_group_system_msg',
  'send_group_msg',
  'send_private_msg',
  'delete_msg',
  'set_group_ban',
  'set_group_kick',
  'set_group_whole_ban',
  'set_group_add_request',
] as const);

export const GUARDIAN_ONEBOT_EVENTS = Object.freeze([
  'message.group',
  'message.private',
  'request.group.add',
  'notice.group_increase',
] as const);

export const GUARDIAN_ONEBOT_MESSAGES = Object.freeze([
  'segment.text',
  'segment.at',
  'segment.reply',
  'segment.json',
  'segment.miniapp',
] as const);

const SENSITIVE_VALUE = /((?:access[_-]?token|authorization|password|secret|api[_-]?key)\s*[=:]\s*)([^\s,;]+)/gi;
const BEARER_TOKEN = /(bearer\s+)[a-z0-9._~+\/-]+/gi;
const URL_CREDENTIALS = /(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi;
const QUERY_SECRET = /([?&](?:access_token|token|key|secret)=)[^&#\s]+/gi;
const MAX_DIAGNOSTIC_LENGTH = 256;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Provider diagnostics are bounded and scrubbed before entering shared errors/logs. */
export function sanitizeProviderDiagnostic(value: unknown): string | undefined {
  const raw = value instanceof Error ? `${value.name}: ${value.message}` : String(value ?? '').trim();
  if (!raw) return undefined;
  const sanitized = raw
    .replace(BEARER_TOKEN, '$1[REDACTED]')
    .replace(URL_CREDENTIALS, '$1[REDACTED]@')
    .replace(QUERY_SECRET, '$1[REDACTED]')
    .replace(SENSITIVE_VALUE, '$1[REDACTED]');
  return sanitized.slice(0, MAX_DIAGNOSTIC_LENGTH);
}

export class OneBotProviderError extends Error {
  readonly category: OneBotProviderErrorCategory;
  readonly provider: OneBotProviderIdentity;
  readonly action: string;
  readonly providerCode?: string | number;
  readonly retryable: boolean;
  readonly diagnostic?: string;

  constructor(options: {
    category: OneBotProviderErrorCategory;
    provider: OneBotProviderIdentity;
    action: string;
    providerCode?: string | number;
    retryable?: boolean;
    diagnostic?: unknown;
    cause?: unknown;
  }) {
    super(`OneBot action ${options.action} failed (${options.category})`, { cause: options.cause });
    this.name = 'OneBotProviderError';
    this.category = options.category;
    this.provider = options.provider;
    this.action = options.action;
    this.providerCode = options.providerCode;
    this.retryable = options.retryable ?? false;
    this.diagnostic = sanitizeProviderDiagnostic(options.diagnostic);
  }
}

/** Identify known products when metadata exists without rejecting compatible unknown implementations. */
export function identifyOneBotProvider(metadata: {
  implementation?: string | null;
  protocol?: string | null;
}): OneBotProviderIdentity {
  const implementation = metadata.implementation?.trim().toLowerCase() ?? '';
  if (implementation.includes('snowluma')) return 'snowluma';
  if (implementation.includes('napcat')) return 'napcat';
  const protocol = metadata.protocol?.trim().toLowerCase() ?? '';
  if (/^onebot(?:[-_ ]?v?11)?$/.test(protocol) || protocol === 'ob11') return 'generic-onebot-v11';
  return 'unknown';
}

export function createOneBotCapabilities(options: {
  actions?: readonly string[];
  events?: readonly string[];
  messages?: readonly string[];
  transports?: readonly string[];
} = {}): OneBotCapabilities {
  return Object.freeze({
    actions: Object.freeze([...new Set(options.actions ?? [])]),
    events: Object.freeze([...new Set(options.events ?? [])]),
    messages: Object.freeze([...new Set(options.messages ?? [])]),
    transports: Object.freeze([...new Set(options.transports ?? [])]),
  });
}

export function createGuardianOneBotCapabilities(transports: readonly string[]): OneBotCapabilities {
  return createOneBotCapabilities({
    actions: GUARDIAN_ONEBOT_ACTIONS,
    events: GUARDIAN_ONEBOT_EVENTS,
    messages: GUARDIAN_ONEBOT_MESSAGES,
    transports,
  });
}

function requireOneBotId(params: Record<string, unknown>, key: string): void {
  if (normalizeOneBotId(params[key]) === null) throw new TypeError(`${key} must be a canonical OneBot identifier`);
}

function requireBoolean(params: Record<string, unknown>, key: string): void {
  if (typeof params[key] !== 'boolean') throw new TypeError(`${key} must be boolean`);
}

function requireNonEmptyString(params: Record<string, unknown>, key: string): void {
  if (typeof params[key] !== 'string' || !params[key].trim()) throw new TypeError(`${key} must be a non-empty string`);
}

function requireMessage(params: Record<string, unknown>): void {
  const message = params['message'];
  if (typeof message === 'string') return;
  if (Array.isArray(message)) return;
  throw new TypeError('message must be a string or OneBot segment array');
}

/** Validate every OneBot action shape Guardian currently emits. */
export function validateOneBotActionParameters(action: string, params: Record<string, unknown>): void {
  if (!isPlainRecord(params)) throw new TypeError('OneBot action parameters must be an object');
  switch (action) {
    case 'get_login_info':
    case 'get_group_list':
    case 'get_group_system_msg':
      return;
    case 'get_group_member_info':
      requireOneBotId(params, 'group_id');
      requireOneBotId(params, 'user_id');
      if (params['no_cache'] !== undefined) requireBoolean(params, 'no_cache');
      return;
    case 'send_group_msg':
      requireOneBotId(params, 'group_id');
      requireMessage(params);
      return;
    case 'send_private_msg':
      requireOneBotId(params, 'user_id');
      requireMessage(params);
      return;
    case 'delete_msg':
      if (normalizeOneBotMessageId(params['message_id']) === null) {
        throw new TypeError('message_id must be a canonical OneBot message handle');
      }
      return;
    case 'set_group_ban':
      requireOneBotId(params, 'group_id');
      requireOneBotId(params, 'user_id');
      if (!Number.isSafeInteger(params['duration']) || Number(params['duration']) < 0) {
        throw new TypeError('duration must be a non-negative safe integer');
      }
      return;
    case 'set_group_kick':
      requireOneBotId(params, 'group_id');
      requireOneBotId(params, 'user_id');
      if (params['reject_add_request'] !== undefined) requireBoolean(params, 'reject_add_request');
      return;
    case 'set_group_whole_ban':
      requireOneBotId(params, 'group_id');
      requireBoolean(params, 'enable');
      return;
    case 'set_group_add_request':
      requireNonEmptyString(params, 'flag');
      requireBoolean(params, 'approve');
      if (params['sub_type'] !== undefined) requireNonEmptyString(params, 'sub_type');
      if (params['reason'] !== undefined && typeof params['reason'] !== 'string') {
        throw new TypeError('reason must be a string');
      }
      return;
    default:
      // Extensions may declare additional capabilities. Guardian-specific
      // validation applies only to application actions known by this version.
      return;
  }
}

function unwrapOneBotEnvelope(
  provider: OneBotProviderIdentity,
  action: string,
  value: unknown,
): unknown {
  if (!isPlainRecord(value)) return value;
  const hasEnvelopeKey = 'status' in value || 'retcode' in value;
  if (!hasEnvelopeKey) return value;

  const status = value['status'];
  const retcode = value['retcode'];
  if (status !== undefined && status !== 'ok' && status !== 'failed') {
    throw new OneBotProviderError({
      category: 'invalid_response', provider, action, diagnostic: 'invalid OneBot status field',
    });
  }
  if (retcode !== undefined && !Number.isSafeInteger(retcode)) {
    throw new OneBotProviderError({
      category: 'invalid_response', provider, action, diagnostic: 'invalid OneBot retcode field',
    });
  }
  if (status === 'failed' || (typeof retcode === 'number' && retcode !== 0)) {
    throw new OneBotProviderError({
      category: 'logical',
      provider,
      action,
      providerCode: typeof retcode === 'number' ? retcode : undefined,
      diagnostic: typeof value['wording'] === 'string'
        ? value['wording']
        : typeof value['message'] === 'string'
          ? value['message']
          : 'provider returned a failed OneBot envelope',
    });
  }
  return 'data' in value ? value['data'] : null;
}

function normalizedIdField(
  provider: OneBotProviderIdentity,
  action: string,
  value: Record<string, unknown>,
  key: string,
): string {
  const normalized = normalizeOneBotId(value[key]);
  if (normalized === null) {
    throw new OneBotProviderError({ category: 'invalid_response', provider, action, diagnostic: `invalid ${key}` });
  }
  return normalized;
}

/** Validate and normalize the response shapes consumed by Guardian. */
export function normalizeOneBotActionResponse(
  provider: OneBotProviderIdentity,
  action: string,
  value: unknown,
): unknown {
  switch (action) {
    case 'get_login_info': {
      if (!isPlainRecord(value) || typeof value['nickname'] !== 'string') {
        throw new OneBotProviderError({ category: 'invalid_response', provider, action, diagnostic: 'invalid get_login_info response' });
      }
      return { ...value, user_id: normalizedIdField(provider, action, value, 'user_id') };
    }
    case 'get_group_list': {
      if (!Array.isArray(value)) {
        throw new OneBotProviderError({ category: 'invalid_response', provider, action, diagnostic: 'invalid get_group_list response' });
      }
      return value.map((item) => {
        if (
          !isPlainRecord(item)
          || typeof item['group_name'] !== 'string'
          || !Number.isSafeInteger(item['member_count'])
          || Number(item['member_count']) < 0
          || !Number.isSafeInteger(item['max_member_count'])
          || Number(item['max_member_count']) < 0
        ) {
          throw new OneBotProviderError({ category: 'invalid_response', provider, action, diagnostic: 'invalid group-list entry' });
        }
        return { ...item, group_id: normalizedIdField(provider, action, item, 'group_id') };
      });
    }
    case 'get_group_member_info': {
      if (!isPlainRecord(value)) {
        throw new OneBotProviderError({ category: 'invalid_response', provider, action, diagnostic: 'invalid member-info response' });
      }
      const role = value['role'];
      if (role !== 'member' && role !== 'admin' && role !== 'owner') {
        throw new OneBotProviderError({ category: 'invalid_response', provider, action, diagnostic: 'invalid member-info role' });
      }
      return {
        ...value,
        group_id: normalizedIdField(provider, action, value, 'group_id'),
        user_id: normalizedIdField(provider, action, value, 'user_id'),
      };
    }
    case 'get_group_system_msg':
      if (!isPlainRecord(value)) {
        throw new OneBotProviderError({ category: 'invalid_response', provider, action, diagnostic: 'invalid group-system-message response' });
      }
      return value;
    case 'send_group_msg':
    case 'send_private_msg': {
      if (!isPlainRecord(value)) {
        throw new OneBotProviderError({ category: 'invalid_response', provider, action, diagnostic: 'invalid send-message response' });
      }
      const messageId = normalizeOneBotMessageId(value['message_id']);
      if (messageId === null) {
        throw new OneBotProviderError({ category: 'invalid_response', provider, action, diagnostic: 'invalid message_id in send response' });
      }
      return { ...value, message_id: messageId };
    }
    case 'delete_msg':
    case 'set_group_ban':
    case 'set_group_kick':
    case 'set_group_whole_ban':
    case 'set_group_add_request':
      if (value === null || value === undefined) return null;
      if (isPlainRecord(value)) return value;
      throw new OneBotProviderError({ category: 'invalid_response', provider, action, diagnostic: 'invalid mutation response' });
    default:
      return value;
  }
}

function classifyUnknownProviderError(error: unknown): OneBotProviderErrorCategory {
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : String(error);
  const text = `${name} ${message}`.toLowerCase();
  if (/unauthori[sz]ed|forbidden|authentication|authorization|invalid[^\n]*token|\b(?:401|403)\b/.test(text)) return 'authentication';
  if (name === 'AbortError' || /timed?\s*out|timeout/.test(text)) return 'timeout';
  if (/not connected|disconnect|connection[^\n]*(?:closed|failed|refused|reset)|econn(?:refused|reset)|\bepipe\b/.test(text)) return 'connection';
  if (/network|fetch failed|socket|websocket/.test(text)) return 'transport';
  if (/unsupported[^\n]*action|unknown[^\n]*action|action[^\n]*not supported/.test(text)) return 'unsupported';
  if (/malformed|protocol|frame|invalid[^\n]*(?:packet|response|json)/.test(text)) return 'protocol';
  if (/retcode|onebot[^\n]*failed|action[^\n]*failed|provider[^\n]*failed/.test(text)) return 'logical';
  return 'adapter_internal';
}

export function normalizeOneBotProviderError(options: {
  provider: OneBotProviderIdentity;
  action: string;
  error: unknown;
}): OneBotProviderError {
  if (options.error instanceof OneBotProviderError) return options.error;
  const category = classifyUnknownProviderError(options.error);
  const providerCode = options.error && typeof options.error === 'object' && 'code' in options.error
    && (typeof (options.error as { code?: unknown }).code === 'string' || typeof (options.error as { code?: unknown }).code === 'number')
      ? (options.error as { code: string | number }).code
      : undefined;
  return new OneBotProviderError({
    category,
    provider: options.provider,
    action: options.action,
    providerCode,
    retryable: category === 'transport' || category === 'connection' || category === 'timeout',
    diagnostic: options.error,
    cause: options.error,
  });
}

export interface CreateOneBotGatewayOptions {
  identity: OneBotProviderIdentity;
  capabilities: OneBotCapabilities;
  connectionState: () => ProviderConnectionState;
  invoke: (action: string, params: Record<string, unknown>) => Promise<unknown>;
}

export function createOneBotGateway(options: CreateOneBotGatewayOptions): OneBotGateway {
  const actions = new Set(options.capabilities.actions);
  const events = new Set(options.capabilities.events);
  const messages = new Set(options.capabilities.messages);
  const transports = new Set(options.capabilities.transports);
  return Object.freeze({
    identity: options.identity,
    capabilities: options.capabilities,
    supportsAction: (action: string) => actions.has(action),
    supportsEvent: (event: string) => events.has(event),
    supportsMessage: (segment: string) => messages.has(segment),
    supportsTransport: (transport: string) => transports.has(transport),
    connectionState: options.connectionState,
    async call(action: string, params: Record<string, unknown> = {}): Promise<unknown> {
      if (!actions.has(action)) {
        throw new OneBotProviderError({
          category: 'capability_mismatch',
          provider: options.identity,
          action,
          diagnostic: 'action is not declared by provider capabilities',
        });
      }
      try {
        validateOneBotActionParameters(action, params);
      } catch (error) {
        throw new OneBotProviderError({
          category: 'invalid_parameters',
          provider: options.identity,
          action,
          diagnostic: error,
          cause: error,
        });
      }

      let raw: unknown;
      try {
        raw = await options.invoke(action, params);
      } catch (error) {
        throw normalizeOneBotProviderError({ provider: options.identity, action, error });
      }
      const unwrapped = unwrapOneBotEnvelope(options.identity, action, raw);
      return normalizeOneBotActionResponse(options.identity, action, unwrapped);
    },
  });
}
