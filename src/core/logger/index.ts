/**
 * Logger that delegates to ctx.logger (NapCat's built-in logger).
 * Falls back to console before context is initialized.
 * Fully replaces pino — no worker threads, no extra dependencies.
 */
import { tryGetRuntimeHost } from '../../runtime/host.ts';
import { redactLogText, redactLogValue } from './redaction.ts';

export interface SimpleLogger {
  info(objOrMsg: unknown, msg?: string): void;
  warn(objOrMsg: unknown, msg?: string): void;
  error(objOrMsg: unknown, msg?: string): void;
  debug(objOrMsg: unknown, msg?: string): void;
  child(bindings: Record<string, unknown>): SimpleLogger;
}

function describe(o: unknown): string {
  // JSON.stringify(new Error(...)) is '{}' — Error props are non-enumerable —
  // which turned every logged exception into a useless "Error handling message {}".
  if (o instanceof Error) return `${redactLogText(o.name)}: ${redactLogText(o.message)}`;
  if (typeof o === 'string') return redactLogText(o);
  try {
    return JSON.stringify(redactLogValue(o));
  } catch {
    return '"[UNSERIALIZABLE]"';
  }
}

function fmt(prefix: string, objOrMsg: unknown, msg?: string): string {
  if (msg) {
    const extra = objOrMsg === undefined || objOrMsg === null ? '' : ' ' + describe(objOrMsg);
    return `[${prefix}] ${redactLogText(msg)}${extra}`;
  }
  return `[${prefix}] ${describe(objOrMsg)}`;
}

function makeLogger(prefix: string): SimpleLogger {
  const write = (level: 'info' | 'warn' | 'error' | 'debug', obj: unknown, msg?: string) => {
    const text = fmt(prefix, obj, msg);
    const host = tryGetRuntimeHost();
    if (host) { host.logger[level](text); }
    else      { console[level](text); }
  };
  return {
    info:  (o, m) => write('info',  o, m),
    warn:  (o, m) => write('warn',  o, m),
    error: (o, m) => write('error', o, m),
    debug: (o, m) => write('debug', o, m),
    child: (b) => makeLogger(b['module'] ? `${prefix}:${String(b['module'])}` : prefix),
  };
}

const _root: SimpleLogger = makeLogger('guardian');

export function getLogger(): SimpleLogger { return _root; }
