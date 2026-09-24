/**
 * Canonical provider-neutral OneBot identifier.
 *
 * Guardian stores identifiers as base-10 strings so JavaScript never rounds
 * a 64-bit provider value. Runtime boundaries must call normalizeOneBotId()
 * before a value reaches shared business logic.
 */
export type OneBotId = string;
export type OneBotIdInput = string | number | bigint;
/** Provider message handles may use signed integers even though account IDs do not. */
export type OneBotMessageId = string;
export type OneBotMessageIdInput = string | number | bigint;

const DECIMAL = /^\d+$/;
const SIGNED_DECIMAL = /^-?\d+$/;
const UINT64_MAX = '18446744073709551615';
const INT64_MIN_ABSOLUTE = '9223372036854775808';
const MAX_RAW_DIGITS = 128;

export interface NormalizeOneBotIdOptions {
  /** Reserved for explicit unset/system sentinels such as core.selfId = "0". */
  allowZero?: boolean;
}

function withinUnsigned64Bit(value: string): boolean {
  return value.length < UINT64_MAX.length
    || (value.length === UINT64_MAX.length && value <= UINT64_MAX);
}

/**
 * Converts safe numeric and decimal-string inputs to one exact canonical
 * representation. Unsafe numbers are rejected because their original digits
 * have already been lost by the JavaScript parser.
 */
export function normalizeOneBotId(
  value: unknown,
  options: NormalizeOneBotIdOptions = {},
): OneBotId | null {
  let digits: string;
  if (typeof value === 'string') {
    if (value.length === 0 || value.length > MAX_RAW_DIGITS || !DECIMAL.test(value)) return null;
    digits = value;
  } else if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) return null;
    digits = String(value);
  } else if (typeof value === 'bigint') {
    if (value < 0n) return null;
    digits = value.toString(10);
  } else {
    return null;
  }

  const canonical = digits.replace(/^0+(?=\d)/, '');
  if (canonical === '0' && !options.allowZero) return null;
  return withinUnsigned64Bit(canonical) ? canonical : null;
}

export function isOneBotId(value: unknown, options: NormalizeOneBotIdOptions = {}): value is OneBotId {
  return typeof value === 'string' && normalizeOneBotId(value, options) === value;
}

/** Convert only where a documented provider contract truly requires Number. */
export function oneBotIdToSafeNumber(value: OneBotId): number {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < 0 || String(numeric) !== value) {
    throw new RangeError('OneBot identifier cannot be represented as a safe JavaScript number');
  }
  return numeric;
}

/**
 * Message handles are a distinct OneBot domain: providers may emit a signed
 * integer (commonly a negative 32-bit handle). Preserve the exact decimal
 * form while continuing to reject rounded JavaScript numbers and non-decimal
 * strings. Positive handles retain the existing unsigned 64-bit range;
 * negative handles use the signed 64-bit lower bound.
 */
export function normalizeOneBotMessageId(value: unknown): OneBotMessageId | null {
  let raw: string;
  if (typeof value === 'string') {
    if (value.length === 0 || value.length > MAX_RAW_DIGITS || !SIGNED_DECIMAL.test(value)) return null;
    raw = value;
  } else if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) return null;
    raw = String(value);
  } else if (typeof value === 'bigint') {
    raw = value.toString(10);
  } else {
    return null;
  }

  const negative = raw.startsWith('-');
  const digits = (negative ? raw.slice(1) : raw).replace(/^0+(?=\d)/, '');
  if (digits === '0') return null;
  if (!negative) return withinUnsigned64Bit(digits) ? digits : null;
  if (
    digits.length > INT64_MIN_ABSOLUTE.length
    || (digits.length === INT64_MIN_ABSOLUTE.length && digits > INT64_MIN_ABSOLUTE)
  ) return null;
  return `-${digits}`;
}

/** The SnowLuma SDK declares safe integer message handles as Number. */
export function oneBotMessageIdToSafeNumber(value: OneBotMessageId): number | null {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && !Object.is(numeric, -0) && String(numeric) === value
    ? numeric
    : null;
}

/** File identifiers may be opaque strings; numeric values still require safe conversion. */
export function normalizeOneBotFileId(value: unknown): string | null {
  if (typeof value === 'string') return value.length > 0 ? value : null;
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0) ? String(value) : null;
  }
  if (typeof value === 'bigint') return value >= 0n ? value.toString(10) : null;
  return null;
}
