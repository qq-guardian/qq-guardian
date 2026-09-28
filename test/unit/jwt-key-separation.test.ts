import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configManager } from '../../src/core/config/index.ts';
import {
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyToken,
} from '../../src/core/crypto/index.ts';

let root = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'guardian-jwt-separation-'));
  configManager.init(join(root, 'config'));
});

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

function legacyMasterSecretToken(type: 'access' | 'refresh'): string {
  const now = Math.floor(Date.now() / 1_000);
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({
    sub: 1,
    jti: '0123456789abcdef0123456789abcdef',
    type,
    ...(type === 'access' ? { role: 'viewer' } : {}),
    iat: now,
    exp: now + 3600,
  })).toString('base64url');
  const signature = createHmac('sha256', configManager.get().webui.jwtSecret)
    .update(`${header}.${body}`)
    .digest('base64url');
  return `${header}.${body}.${signature}`;
}

describe('JWT signing-key separation', () => {
  it('accepts access and refresh tokens only under their domain-separated signing key', () => {
    const access = signAccessToken({ sub: 1, role: 'viewer', jti: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
    const refresh = signRefreshToken({ sub: 1, jti: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' });

    assert.equal(verifyAccessToken(access)?.type, 'access');
    assert.equal(verifyToken(refresh)?.type, 'refresh');
    assert.equal(verifyAccessToken(refresh), null);
  });

  it('rejects tokens signed directly with the persisted master secret', () => {
    assert.equal(verifyToken(legacyMasterSecretToken('access')), null);
    assert.equal(verifyToken(legacyMasterSecretToken('refresh')), null);
  });

  it('rejects type-confusion tampering before accepting the sibling key domain', () => {
    const access = signAccessToken({ sub: 1, role: 'viewer', jti: 'cccccccccccccccccccccccccccccccc' });
    const [header, body, signature] = access.split('.');
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<string, unknown>;
    payload['type'] = 'refresh';
    const tamperedBody = Buffer.from(JSON.stringify(payload)).toString('base64url');

    assert.equal(verifyToken(`${header}.${tamperedBody}.${signature}`), null);
  });
});
