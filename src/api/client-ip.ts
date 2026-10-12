import type { GuardianHttpRequest } from '../ports/http.ts';
import { ipFamilyOf, ipMatchesCidr } from '../core/net/ip-cidr.ts';

const FALLBACK_CLIENT_IP = '127.0.0.1';

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function socketAddress(value: unknown): string | null {
  const request = record(value);
  if (!request) return null;
  for (const candidate of [request['socket'], request['connection']]) {
    const address = record(candidate)?.['remoteAddress'];
    if (typeof address === 'string' && ipFamilyOf(address)) return address;
  }
  return null;
}

function actualPeerAddress(raw: unknown): string | null {
  const direct = socketAddress(raw);
  if (direct) return direct;
  return socketAddress(record(raw)?.['raw']);
}

function headerValue(req: GuardianHttpRequest, name: string): string | null {
  const entry = Object.entries(req.headers).find(([header]) => header.toLowerCase() === name.toLowerCase());
  const value = entry?.[1];
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.join(',');
  return null;
}

/**
 * Resolve the client IP only when the actual TCP peer is available and trusted.
 * Plugin hosts that do not expose a socket peer use one shared fallback bucket;
 * forwarded headers alone are never evidence that a request came through a proxy.
 */
export function resolveClientIp(
  req: GuardianHttpRequest,
  trustedProxyCidrs: readonly string[],
): string {
  const peer = actualPeerAddress(req.raw);
  if (!peer || !trustedProxyCidrs.some((cidr) => ipMatchesCidr(peer, cidr))) {
    return FALLBACK_CLIENT_IP;
  }

  const forwarded = headerValue(req, 'x-forwarded-for');
  if (!forwarded) return FALLBACK_CLIENT_IP;
  const hops = forwarded.split(',').map((part) => part.trim());
  if (hops.length === 0 || hops.some((hop) => !ipFamilyOf(hop))) return FALLBACK_CLIENT_IP;

  // Walk from the actual peer toward the client. Trusted intermediate proxies
  // are skipped; the first untrusted hop is the only address suitable for a
  // security-sensitive rate-limit key. Client-prepended values to the left are
  // therefore not accepted as the client identity.
  for (let index = hops.length - 1; index >= 0; index -= 1) {
    const hop = hops[index]!;
    if (trustedProxyCidrs.some((cidr) => ipMatchesCidr(hop, cidr))) continue;
    return hop;
  }
  return FALLBACK_CLIENT_IP;
}
