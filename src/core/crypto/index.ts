/** Password and JWT primitives implemented only with Node.js crypto. */
import { createHmac, randomBytes, scrypt, timingSafeEqual, type BinaryLike } from 'node:crypto';
import { promisify } from 'node:util';
import { configManager } from '../config/index.ts';

const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_DKLEN = 32;
const SCRYPT_MAX_MEMORY_BYTES = 64 * 1024 * 1024;
const SCRYPT_MAX_COST_MEMORY_BYTES = 32 * 1024 * 1024;
const SCRYPT_MAX_WORK = 524_288;
const JWT_KEY_DERIVATION_CONTEXT = 'qq-guardian:jwt-signing:v1';

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: string,
  length: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const derived = await deriveScrypt(plain, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P);
  return `scrypt:v2:${SCRYPT_N}:${SCRYPT_R}:${SCRYPT_P}:${salt}:${derived.toString('hex')}`;
}

interface ParsedScryptHash {
  N: number;
  r: number;
  p: number;
  salt: string;
  storedHex: string;
}

function parseCanonicalInteger(value: string): number | null {
  if (!/^[1-9]\d*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function hasSafeScryptCost(N: number, r: number, p: number): boolean {
  if (N < 1_024 || N > 65_536 || (N & (N - 1)) !== 0) return false;
  if (r < 1 || r > 16 || p < 1 || p > 4) return false;
  return 128 * N * r <= SCRYPT_MAX_COST_MEMORY_BYTES && N * r * p <= SCRYPT_MAX_WORK;
}

function parseScryptHash(hash: string): ParsedScryptHash | null {
  const parts = hash.split(':');
  if (parts.length === 4 && parts[0] === 'scrypt' && parts[1] === 'v1') {
    const [, , salt, storedHex] = parts;
    if (!/^[0-9a-f]{32}$/.test(salt) || !/^[0-9a-f]{64}$/.test(storedHex)) return null;
    return { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, salt, storedHex };
  }

  if (parts.length !== 7 || parts[0] !== 'scrypt' || (parts[1] !== 'v1' && parts[1] !== 'v2')) return null;
  const [, , nText, rText, pText, salt, storedHex] = parts;
  const N = parseCanonicalInteger(nText);
  const r = parseCanonicalInteger(rText);
  const p = parseCanonicalInteger(pText);
  if (N === null || r === null || p === null || !hasSafeScryptCost(N, r, p)) return null;
  if (!/^[0-9a-f]{32}$/.test(salt) || !/^[0-9a-f]{64}$/.test(storedHex)) return null;
  return { N, r, p, salt, storedHex };
}

function deriveScrypt(plain: string, salt: string, N: number, r: number, p: number): Promise<Buffer> {
  return scryptAsync(plain, salt, SCRYPT_DKLEN, { N, r, p, maxmem: SCRYPT_MAX_MEMORY_BYTES });
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  const parsed = parseScryptHash(hash);
  if (!parsed) return false;
  try {
    const derived = await deriveScrypt(plain, parsed.salt, parsed.N, parsed.r, parsed.p);
    const stored = Buffer.from(parsed.storedHex, 'hex');
    return derived.length === stored.length && timingSafeEqual(derived, stored);
  } catch {
    return false;
  }
}

export interface JWTPayload {
  sub: number;
  jti: string;
  type: 'access' | 'refresh';
  role?: string;
  iat?: number;
  exp?: number;
}

function parseExpirySeconds(value: string): number {
  const match = String(value).match(/^(\d+)(s|m|h|d)?$/);
  if (!match) return 7_200;
  return Number.parseInt(match[1], 10) * ({ s: 1, m: 60, h: 3_600, d: 86_400 }[match[2] ?? 's'] ?? 1);
}

/**
 * `webui.jwtSecret` is treated as a master secret, never as a token signing
 * key directly. Domain-separated HMAC derivation gives access and refresh
 * tokens independent signing keys without adding another persisted secret or
 * a config migration. Compromise/forgery of one derived key does not disclose
 * the sibling key.
 */
function jwtSigningKey(type: JWTPayload['type']): Buffer {
  return createHmac('sha256', configManager.get().webui.jwtSecret)
    .update(`${JWT_KEY_DERIVATION_CONTEXT}:${type}`)
    .digest();
}

function jwtSign(payload: JWTPayload, secret: BinaryLike, expiresIn: string): string {
  const issuedAt = Math.floor(Date.now() / 1_000);
  const expiresAt = issuedAt + parseExpirySeconds(expiresIn);
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({ ...payload, iat: issuedAt, exp: expiresAt })).toString('base64url');
  const signature = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${signature}`;
}

function jwtVerify(token: string, secret: BinaryLike): JWTPayload {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Malformed token');
  const [header, body, signature] = parts;
  const headerPayload = JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as { alg?: unknown; typ?: unknown };
  if (headerPayload.alg !== 'HS256' || headerPayload.typ !== 'JWT') throw new Error('Unsupported token header');
  const expected = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  const actualBuffer = Buffer.from(signature, 'base64url');
  const expectedBuffer = Buffer.from(expected, 'base64url');
  if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) {
    throw new Error('Invalid signature');
  }
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as JWTPayload;
  if (!Number.isInteger(payload.sub) || typeof payload.jti !== 'string' || payload.jti.length < 16) {
    throw new Error('Malformed payload');
  }
  if (payload.type !== 'access' && payload.type !== 'refresh') throw new Error('Malformed token type');
  const expiration = payload.exp;
  if (typeof expiration !== 'number' || !Number.isInteger(expiration) || Math.floor(Date.now() / 1_000) >= expiration) {
    throw new Error('Token expired');
  }
  return payload;
}

function untrustedTokenType(token: string): JWTPayload['type'] | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as { type?: unknown };
    return payload.type === 'access' || payload.type === 'refresh' ? payload.type : null;
  } catch {
    return null;
  }
}

export function signAccessToken(payload: { sub: number; role: string; jti: string }): string {
  return jwtSign({ ...payload, type: 'access' }, jwtSigningKey('access'), configManager.get().webui.jwtExpiresIn);
}

export function signRefreshToken(payload: { sub: number; jti: string }): string {
  return jwtSign({ ...payload, type: 'refresh' }, jwtSigningKey('refresh'), configManager.get().webui.refreshExpiresIn);
}

export function verifyToken(token: string): JWTPayload | null {
  const type = untrustedTokenType(token);
  if (!type) return null;
  try {
    const payload = jwtVerify(token, jwtSigningKey(type));
    return payload.type === type ? payload : null;
  } catch {
    return null;
  }
}

export function verifyAccessToken(token: string): JWTPayload | null {
  const payload = verifyToken(token);
  if (!payload || payload.type !== 'access' || typeof payload.role !== 'string') return null;
  return payload;
}
