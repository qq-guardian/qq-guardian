import { lookup as dnsLookup } from 'node:dns/promises';
import { closeSync, existsSync, openSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';

const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_USER_AGENT = 'qq-guardian';

interface ResponseDeadline {
  release(): void;
}

const responseDeadlines = new WeakMap<Response, ResponseDeadline>();

export interface RemoteFetchPolicy {
  /** Explicit hosts allowed for this outbound purpose. Omit only for an
   * operator-configured HTTPS feed. */
  allowedHosts?: ReadonlySet<string>;
  allowPrivateNetwork?: boolean;
  /** Only for an explicitly opted-in local integration. Public callers stay
   * HTTPS-only even when this capability exists. */
  allowHttp?: boolean;
  timeoutMs?: number;
  maxRedirects?: number;
}

export type HostResolver = (hostname: string) => Promise<string[]>;

function isPrivateIpv4(address: string): boolean {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value))) return true;
  const [a, b] = octets;
  return a === 0
    || a === 10
    || a === 127
    || a === 100 && b >= 64 && b <= 127
    || a === 169 && b === 254
    || a === 172 && b >= 16 && b <= 31
    || a === 192 && b === 0
    || a === 192 && b === 168
    || a === 198 && (b === 18 || b === 19)
    || a >= 224;
}

function isPrivateIpv6(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, '');
  const embeddedIpv4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(normalized)?.[1];
  if (embeddedIpv4) return isPrivateIpv4(embeddedIpv4);
  const firstHextet = Number.parseInt(normalized.split(':', 1)[0] ?? '', 16);
  return normalized === '::'
    || normalized === '::1'
    || Number.isNaN(firstHextet)
    || firstHextet >= 0xfe80 && firstHextet <= 0xfebf // IPv6 link-local fe80::/10
    || firstHextet >= 0xfc00 && firstHextet <= 0xfdff // Unique local fc00::/7
    || firstHextet >= 0xff00; // Multicast/reserved ff00::/8
}

/** Exported for unit tests and deployment-policy diagnostics. */
export function isPrivateNetworkAddress(address: string): boolean {
  const family = isIP(address.replace(/^\[|\]$/g, ''));
  if (family === 4) return isPrivateIpv4(address);
  if (family === 6) return isPrivateIpv6(address);
  return true;
}

async function resolveAll(hostname: string): Promise<string[]> {
  const records = await dnsLookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

function normalizedHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, '');
}

function assertResolvedAddresses(addresses: readonly string[], allowPrivateNetwork: boolean): void {
  if (addresses.length === 0 || (!allowPrivateNetwork && addresses.some(isPrivateNetworkAddress))) {
    throw new Error('Remote URL resolves to a private network address');
  }
}

interface RemoteTarget {
  url: URL;
  hostname: string;
}

async function validateRemoteTarget(
  rawUrl: string | URL,
  policy: RemoteFetchPolicy,
  resolveHostname: HostResolver,
): Promise<RemoteTarget> {
  let url: URL;
  try {
    url = rawUrl instanceof URL ? new URL(rawUrl.toString()) : new URL(rawUrl);
  } catch {
    throw new Error('Invalid remote URL');
  }

  if (url.protocol !== 'https:' && !(policy.allowHttp && url.protocol === 'http:')) {
    throw new Error('Remote URLs must use HTTPS');
  }
  if (url.username || url.password) throw new Error('Remote URLs must not contain credentials');
  const hostname = normalizedHostname(url.hostname);
  if (policy.allowedHosts && !policy.allowedHosts.has(hostname)) {
    throw new Error('Remote URL host is not allowed');
  }

  if (isIP(hostname)) {
    assertResolvedAddresses([hostname], Boolean(policy.allowPrivateNetwork));
    return { url, hostname };
  }

  try {
    assertResolvedAddresses(await resolveHostname(hostname), Boolean(policy.allowPrivateNetwork));
  } catch (error) {
    if (error instanceof Error && error.message === 'Remote URL resolves to a private network address') throw error;
    throw new Error('Remote URL could not be resolved');
  }
  return { url, hostname };
}

/**
 * Validates an outbound HTTPS URL before every request and redirect hop. The
 * native transport repeats the same resolution at connection time and pins
 * that validated address, preventing a resolver answer from changing between
 * policy validation and the TCP connection.
 */
export async function validateRemoteUrl(
  rawUrl: string | URL,
  policy: RemoteFetchPolicy = {},
  resolveHostname: HostResolver = resolveAll,
): Promise<URL> {
  return (await validateRemoteTarget(rawUrl, policy, resolveHostname)).url;
}

interface PinnedLookupOptions {
  family?: number;
  all?: boolean;
}

interface PinnedLookupAddress {
  address: string;
  family: 4 | 6;
}

function pinnedLookup(policy: RemoteFetchPolicy, resolveHostname: HostResolver) {
  return (
    rawHostname: string,
    options: number | PinnedLookupOptions,
    callback: (
      error: Error | null,
      address?: string | PinnedLookupAddress[],
      family?: 4 | 6,
    ) => void,
  ): void => {
    void (async () => {
      try {
        const hostname = normalizedHostname(rawHostname);
        const addresses = isIP(hostname) ? [hostname] : await resolveHostname(hostname);
        assertResolvedAddresses(addresses, Boolean(policy.allowPrivateNetwork));
        const requestedFamily = typeof options === 'number' ? options : options.family ?? 0;
        const candidates = addresses
          .filter((candidate) => requestedFamily === 0 || isIP(candidate) === requestedFamily)
          .map((address) => ({ address, family: isIP(address) as 4 | 6 }));
        if (candidates.length === 0) throw new Error('Remote URL could not be resolved');
        if (typeof options !== 'number' && options.all) {
          callback(null, candidates);
          return;
        }
        callback(null, candidates[0].address, candidates[0].family);
      } catch (error) {
        callback(
          error instanceof Error && error.message === 'Remote URL resolves to a private network address'
            ? error
            : new Error('Remote URL could not be resolved'),
        );
      }
    })();
  };
}

function requestHeaders(headers: RequestInit['headers']): Record<string, string> {
  const normalized: Record<string, string> = {};
  new Headers(headers).forEach((value, name) => { normalized[name] = value; });
  // GitHub's API requires User-Agent and native http(s).request does not add
  // one like global fetch does. Keep caller-provided identities intact.
  if (!normalized['user-agent']) normalized['user-agent'] = DEFAULT_USER_AGENT;
  return normalized;
}

function responseHeaders(response: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(response.headers)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
  }
  return headers;
}

function endRequest(request: ClientRequest, body: RequestInit['body']): void {
  if (body === undefined || body === null) {
    request.end();
    return;
  }
  if (typeof body === 'string' || body instanceof URLSearchParams || Buffer.isBuffer(body) || ArrayBuffer.isView(body)) {
    request.end(body instanceof URLSearchParams ? body.toString() : body);
    return;
  }
  if (body instanceof ArrayBuffer) {
    request.end(Buffer.from(body));
    return;
  }
  throw new Error('Unsupported remote request body type');
}

function requestRemote(
  target: RemoteTarget,
  init: RequestInit,
  policy: RemoteFetchPolicy,
  resolveHostname: HostResolver,
  signal: AbortSignal,
): Promise<Response> {
  return new Promise<Response>((resolveResponse, rejectResponse) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      callback();
    };
    const onResponse = (incoming: IncomingMessage): void => {
      const status = incoming.statusCode ?? 500;
      const body = status === 204 || status === 304
        ? null
        : Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
      finish(() => resolveResponse(new Response(body, {
        status,
        statusText: incoming.statusMessage ?? '',
        headers: responseHeaders(incoming),
      })));
    };

    const options = {
      hostname: target.hostname,
      port: target.url.port ? Number(target.url.port) : undefined,
      path: `${target.url.pathname}${target.url.search}`,
      method: init.method ?? 'GET',
      headers: requestHeaders(init.headers),
      lookup: pinnedLookup(policy, resolveHostname) as never,
      signal,
    };
    const request = target.url.protocol === 'https:'
      ? httpsRequest({ ...options, servername: isIP(target.hostname) ? undefined : target.hostname }, onResponse)
      : httpRequest(options, onResponse);
    request.once('error', (error) => finish(() => rejectResponse(error)));
    try {
      endRequest(request, init.body);
    } catch (error) {
      request.destroy(error instanceof Error ? error : undefined);
      finish(() => rejectResponse(error));
    }
  });
}

function clearResponseDeadline(response: Response): void {
  const deadline = responseDeadlines.get(response);
  if (!deadline) return;
  responseDeadlines.delete(response);
  deadline.release();
}

function withoutCrossOriginCredentials(headers: RequestInit['headers']): Headers {
  const sanitized = new Headers(headers);
  // Match browser-fetch's safe redirect behavior for the credentials Guardian
  // can use with custom AI providers. A public redirect is still revalidated,
  // but it must never receive the configured provider secret.
  for (const name of [
    'authorization',
    'proxy-authorization',
    'cookie',
    'cookie2',
    'x-api-key',
    'x-auth-token',
    'x-amz-security-token',
  ]) sanitized.delete(name);
  return sanitized;
}

/** Fetch data with explicit redirect validation and connection-time DNS pinning. */
export async function fetchRemote(
  rawUrl: string | URL,
  init: RequestInit = {},
  policy: RemoteFetchPolicy = {},
  resolveHostname: HostResolver = resolveAll,
): Promise<Response> {
  const maxRedirects = policy.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  let current = await validateRemoteTarget(rawUrl, policy, resolveHostname);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), policy.timeoutMs ?? 10_000);
  const upstreamSignal = init.signal;
  const forwardAbort = () => controller.abort();
  if (upstreamSignal) {
    if (upstreamSignal.aborted) controller.abort();
    else upstreamSignal.addEventListener('abort', forwardAbort, { once: true });
  }
  const releaseDeadline = () => {
    clearTimeout(timeout);
    upstreamSignal?.removeEventListener('abort', forwardAbort);
  };
  let { signal: _upstreamSignal, ...requestInit } = init;

  try {
    for (let redirects = 0; ; redirects += 1) {
      const response = await requestRemote(current, requestInit, policy, resolveHostname, controller.signal);
      // Keep the deadline active while the body is consumed. Callers use the
      // bounded read/write helpers below, which release it in `finally`.
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (location) {
          await response.body?.cancel();
          if (redirects >= maxRedirects) throw new Error('Remote request exceeded redirect limit');
          const next = await validateRemoteTarget(new URL(location, current.url), policy, resolveHostname);
          if (next.url.origin !== current.url.origin) {
            requestInit = { ...requestInit, headers: withoutCrossOriginCredentials(requestInit.headers) };
          }
          current = next;
          continue;
        }
      }
      responseDeadlines.set(response, { release: releaseDeadline });
      return response;
    }
  } catch (error) {
    releaseDeadline();
    throw error;
  }
}

/** Release a response that a caller deliberately does not consume (for
 * example a non-2xx status). This cancels its body and prevents a stale
 * request deadline from accumulating under repeated remote failures. */
export async function releaseRemoteResponse(response: Response): Promise<void> {
  clearResponseDeadline(response);
  await response.body?.cancel().catch(() => undefined);
}

export async function readResponseBytes(response: Response, maxBytes: number): Promise<Buffer> {
  const declaredLength = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await releaseRemoteResponse(response);
    throw new Error(`Remote response exceeds the ${maxBytes} byte limit`);
  }
  const reader = response.body?.getReader();
  if (!reader) {
    await releaseRemoteResponse(response);
    return Buffer.alloc(0);
  }
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error(`Remote response exceeds the ${maxBytes} byte limit`);
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    clearResponseDeadline(response);
  }
  return Buffer.concat(chunks, total);
}

export async function readResponseJson(response: Response, maxBytes: number): Promise<unknown> {
  const bytes = await readResponseBytes(response, maxBytes);
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('Remote response is not valid JSON');
  }
}

/** Stream a fetch response to a private temporary file, then atomically
 * replace the destination after size/completeness validation. */
export async function writeResponseToFile(
  response: Response,
  destination: string,
  maxBytes: number,
): Promise<number> {
  const declaredLength = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await releaseRemoteResponse(response);
    throw new Error(`Remote response exceeds the ${maxBytes} byte limit`);
  }
  const reader = response.body?.getReader();
  if (!reader) {
    await releaseRemoteResponse(response);
    throw new Error('Remote response has no body');
  }
  const temporary = `${destination}.part-${process.pid}-${Date.now()}`;
  let descriptor: number | null = null;
  let total = 0;

  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error(`Remote response exceeds the ${maxBytes} byte limit`);
      writeSync(descriptor, value);
    }
    closeSync(descriptor);
    descriptor = null;
    if (declaredLength > 0 && total !== declaredLength) {
      throw new Error(`Remote response is incomplete: expected ${declaredLength} bytes, received ${total}`);
    }
    // On Windows a prior update artifact can be open. Preserve it rather than
    // falling back to a partial write; the operator can remove it explicitly.
    if (existsSync(destination)) throw new Error('Update artifact already exists; choose another version or remove it explicitly');
    renameSync(temporary, destination);
    return total;
  } catch (error) {
    if (descriptor !== null) {
      try { closeSync(descriptor); } catch { /* best effort */ }
    }
    try { unlinkSync(temporary); } catch { /* best effort */ }
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    clearResponseDeadline(response);
  }
}
