/**
 * Strict boolean coercion for values that may cross an HTTP/config/runtime
 * boundary. JavaScript's Boolean("false") is true, which is dangerous for
 * security-sensitive toggles when a form, environment variable, or adapter
 * serializes booleans as strings.
 */
export function parseBoolean(value: unknown): boolean | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (value === true || value === 1 || value === '1' || value === 'true') return true;
  if (value === false || value === 0 || value === '0' || value === 'false') return false;
  return undefined;
}

/** Keep an existing value when the incoming representation is absent/invalid. */
export function parseBooleanOr(value: unknown, fallback: boolean): boolean {
  return parseBoolean(value) ?? fallback;
}
