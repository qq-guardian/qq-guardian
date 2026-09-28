const REDACTED = '[REDACTED]';
const OMITTED = '[OMITTED]';
const MAX_DEPTH = 8;

const SECRET_KEY = /^(?:access_?token|refresh_?token|token|authorization|proxy-authorization|auth|secret|password|passwd|credentials?|api[_-]?key|cookie|set-cookie|jwt)$/i;
const PAYLOAD_KEY = /^(?:params?|payload|body|raw|raw_message|private_message|message|content|comment|request|response|event|data)$/i;
const SECRET_NAME = '(?:access_?token|refresh_?token|token|authorization|proxy-authorization|auth|secret|password|passwd|credentials?|api[_-]?key|cookie|jwt)';

/** Redacts common credential representations without retaining raw payloads. */
export function redactLogText(value: string): string {
  return value
    .replace(/(\b(?:bearer|basic)\s+)[a-z0-9._~+/=-]+/gi, '$1[REDACTED]')
    .replace(new RegExp(`([?&]${SECRET_NAME}=)[^&#\\s]*`, 'gi'), '$1[REDACTED]')
    .replace(new RegExp(`((?:${SECRET_NAME})["']?\\s*[:=]\\s*)["'][^"']*["']`, 'gi'), '$1"[REDACTED]"')
    .replace(new RegExp(`((?:${SECRET_NAME})\\s*[:=]\\s*)[^\\s,;&]+`, 'gi'), '$1[REDACTED]')
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/\beyJ[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+\b/gi, REDACTED);
}

/**
 * Produces a JSON-safe log value while removing secret fields and raw
 * request/event/message bodies. Object graphs are depth-bounded and circular
 * references never escape through error logging.
 */
export function redactLogValue(value: unknown): unknown {
  return redactValue(value, new WeakSet<object>(), 0);
}

function redactValue(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (typeof value === 'string') return redactLogText(value);
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) {
    return value;
  }
  if (typeof value === 'symbol' || typeof value === 'function') return String(value);
  if (value instanceof Error) {
    return {
      name: redactLogText(value.name),
      message: redactLogText(value.message),
    };
  }
  if (depth >= MAX_DEPTH) return OMITTED;
  if (typeof value !== 'object') return redactLogText(String(value));
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry) => redactValue(entry, seen, depth + 1));
    }
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (SECRET_KEY.test(key)) output[key] = REDACTED;
      else if (PAYLOAD_KEY.test(key)) output[key] = OMITTED;
      else output[key] = redactValue(entry, seen, depth + 1);
    }
    return output;
  } finally {
    seen.delete(value);
  }
}
