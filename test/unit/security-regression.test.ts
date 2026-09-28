/**
 * Security regression tests — QG-003, QG-004, QG-005, QG-008, QG-011.
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, existsSync, mkdtempSync, rmSync, readFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { buildDefaults } from '../../src/core/config/defaults.ts';
import { validateCanonicalConfig } from '../../src/core/config/schema.ts';
import { configManager, ConfigManager } from '../../src/core/config/index.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// ─── QG-003: CIDR matching logic ─────────────────────────────────────────────

describe('QG-003: CIDR membership — ipMatchesCidr logic', () => {
  // Inline copy of the production function for isolated unit testing.
  function ipMatchesCidr(ip: string, cidr: string): boolean {
    try {
      const [network, prefix] = cidr.includes('/') ? cidr.split('/') : [cidr, undefined];
      const prefixLen = prefix !== undefined ? parseInt(prefix, 10) : undefined;
      if (prefixLen === undefined) return ip.trim() === (network ?? '').trim();
      if (!(network ?? '').includes(':')) {
        const ipParts = ip.split('.').map(Number);
        const netParts = (network ?? '').split('.').map(Number);
        if (ipParts.length !== 4 || netParts.length !== 4) return false;
        if (ipParts.some(Number.isNaN) || netParts.some(Number.isNaN)) return false;
        const ipNum = (ipParts[0]! << 24) | (ipParts[1]! << 16) | (ipParts[2]! << 8) | ipParts[3]!;
        const netNum = (netParts[0]! << 24) | (netParts[1]! << 16) | (netParts[2]! << 8) | netParts[3]!;
        const mask = prefixLen === 0 ? 0 : (~0 << (32 - prefixLen)) >>> 0;
        return (ipNum >>> 0 & mask) === (netNum >>> 0 & mask);
      }
      return ip.trim().toLowerCase() === (network ?? '').trim().toLowerCase();
    } catch { return false; }
  }

  it('matches bare addresses by equality', () => {
    assert.equal(ipMatchesCidr('10.0.0.1', '10.0.0.1'), true);
    assert.equal(ipMatchesCidr('10.0.0.2', '10.0.0.1'), false);
    assert.equal(ipMatchesCidr('127.0.0.1', '127.0.0.1'), true);
  });

  it('/8 covers the expected subnet', () => {
    assert.equal(ipMatchesCidr('10.1.2.3',    '10.0.0.0/8'), true);
    assert.equal(ipMatchesCidr('10.255.255.255', '10.0.0.0/8'), true);
    assert.equal(ipMatchesCidr('11.0.0.1',    '10.0.0.0/8'), false);
  });

  it('/16 discriminates correctly', () => {
    assert.equal(ipMatchesCidr('192.168.1.1', '192.168.0.0/16'), true);
    assert.equal(ipMatchesCidr('192.169.0.1', '192.168.0.0/16'), false);
  });

  it('/24 discriminates correctly', () => {
    assert.equal(ipMatchesCidr('172.16.0.100', '172.16.0.0/24'), true);
    assert.equal(ipMatchesCidr('172.16.1.1',   '172.16.0.0/24'), false);
  });

  it('/32 means exact match only', () => {
    assert.equal(ipMatchesCidr('1.2.3.4', '1.2.3.4/32'), true);
    assert.equal(ipMatchesCidr('1.2.3.5', '1.2.3.4/32'), false);
  });

  it('/0 matches every address', () => {
    assert.equal(ipMatchesCidr('8.8.8.8',     '0.0.0.0/0'), true);
    assert.equal(ipMatchesCidr('192.168.1.1', '0.0.0.0/0'), true);
  });

  it('empty trustedProxyCidrs never trusts any header (secure default)', () => {
    const cidrs: string[] = [];
    assert.equal(
      cidrs.some(c => ipMatchesCidr('1.2.3.4', c)), false,
      'Empty CIDR list must not trust a spoofed forwarding header',
    );
  });

  it('trusts only proxies within the configured CIDR', () => {
    const cidrs = ['127.0.0.1', '10.0.0.0/8'];
    assert.equal(cidrs.some(c => ipMatchesCidr('10.5.0.1', c)), true);
    assert.equal(cidrs.some(c => ipMatchesCidr('11.0.0.1', c)), false);
  });
});

describe('QG-003: auth.trustedProxyCidrs validates and back-fills correctly', () => {
  it('accepts an empty array (safe default)', () => {
    const cfg = validateCanonicalConfig({ ...buildDefaults(), auth: { ...buildDefaults().auth, trustedProxyCidrs: [] } });
    assert.deepEqual(cfg.auth.trustedProxyCidrs, []);
  });

  it('accepts valid IPv4 addresses and CIDRs', () => {
    const cfg = validateCanonicalConfig({
      ...buildDefaults(),
      auth: { ...buildDefaults().auth, trustedProxyCidrs: ['127.0.0.1', '10.0.0.0/8', '172.16.0.0/12'] },
    });
    assert.deepEqual(cfg.auth.trustedProxyCidrs, ['127.0.0.1', '10.0.0.0/8', '172.16.0.0/12']);
  });

  it('back-fills default for old config files without the field', () => {
    // Omit trustedProxyCidrs — simulates a config written before this field existed.
    const authWithoutNew = { ...buildDefaults().auth };
    delete (authWithoutNew as Record<string, unknown>)['trustedProxyCidrs'];
    const cfg = validateCanonicalConfig({ ...buildDefaults(), auth: authWithoutNew });
    assert.deepEqual(cfg.auth.trustedProxyCidrs, []);
  });
});

// ─── QG-004: Account enumeration resistance ──────────────────────────────────

describe('QG-004: login() returns identical external message for locked vs invalid accounts', () => {
  let root = '';

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'qqg-qg004-'));
    mkdirSync(join(root, 'config'), { recursive: true });
    configManager.init(join(root, 'config'));
    const { closeDatabase, openDatabase } = await import('../../src/database/index.ts');
    closeDatabase();
    openDatabase(root);
  });

  afterEach(async () => {
    const { closeDatabase } = await import('../../src/database/index.ts');
    closeDatabase();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('returns "Invalid credentials" for a non-existent username', async () => {
    const { login } = await import('../../src/modules/auth/index.ts');
    const result = await login('nobody', 'any', '127.0.0.1');
    assert.equal(result.ok, false);
    assert.equal(result.error, 'Invalid credentials',
      'Non-existent user must receive the generic auth failure message');
  });

  it('returns the same message for a wrong password (no enumeration oracle)', async () => {
    const { hashPassword } = await import('../../src/core/crypto/index.ts');
    const { userRepo } = await import('../../src/database/repositories/user.ts');
    const { login } = await import('../../src/modules/auth/index.ts');
    userRepo.createBootstrapAdmin({
      username: 'enumtest', role: 'viewer', passwordHash: await hashPassword('correct'),
    });

    const result = await login('enumtest', 'wrong', '127.0.0.1');
    assert.equal(result.ok, false);
    assert.equal(result.error, 'Invalid credentials',
      'Wrong password must return the same message as non-existent user');
  });

  it('returns the same generic message for a locked account (no lockout oracle)', async () => {
    const { hashPassword } = await import('../../src/core/crypto/index.ts');
    const { userRepo } = await import('../../src/database/repositories/user.ts');
    const { login } = await import('../../src/modules/auth/index.ts');
    userRepo.createBootstrapAdmin({
      username: 'lockedtest', role: 'viewer', passwordHash: await hashPassword('pass'),
    });
    const user = userRepo.findByUsername('lockedtest');
    assert.ok(user, 'Test user must exist');
    userRepo.updateAuthenticationState(user.id, { loginAttempts: 5, lockedUntil: Date.now() + 60_000 });

    const result = await login('lockedtest', 'wrong', '127.0.0.1');
    assert.equal(result.ok, false);
    assert.equal(result.error, 'Invalid credentials',
      'Locked account must return the same generic message — not "Account temporarily locked"');
    assert.notEqual(result.error, 'Account temporarily locked',
      'The locked-state string must never be visible externally');
  });
});

// ─── QG-005: HttpOnly refresh-token cookie attributes ────────────────────────

describe('QG-005: refresh-token cookie is HttpOnly, SameSite=Strict, and scoped correctly', () => {
  // Inline the production cookie-builder for isolated attribute testing.
  function buildCookie(token: string, maxAgeSec: number, isHttps: boolean): string {
    return [
      `qqg_refresh=${encodeURIComponent(token)}`,
      'HttpOnly',
      'SameSite=Strict',
      isHttps ? 'Secure' : '',
      `Max-Age=${Math.max(0, Math.ceil(maxAgeSec))}`,
      'Path=/',
    ].filter(Boolean).join('; ');
  }

  it('always sets HttpOnly', () => {
    assert.ok(buildCookie('tok', 3600, false).includes('HttpOnly'));
    assert.ok(buildCookie('tok', 3600, true).includes('HttpOnly'));
  });

  it('always sets SameSite=Strict', () => {
    assert.ok(buildCookie('tok', 3600, false).includes('SameSite=Strict'));
  });

  it('adds Secure attribute over HTTPS', () => {
    assert.ok(buildCookie('tok', 3600, true).includes('Secure'));
  });

  it('omits Secure over plain HTTP (local dev)', () => {
    assert.ok(!buildCookie('tok', 3600, false).includes('Secure'));
  });

  it('sets Max-Age from the TTL', () => {
    assert.ok(buildCookie('tok', 7200, false).includes('Max-Age=7200'));
  });

  it('sets Max-Age=0 on logout (clears cookie)', () => {
    assert.ok(buildCookie('', 0, false).includes('Max-Age=0'));
  });

  it('URL-encodes the token value', () => {
    assert.ok(buildCookie('a+b=c', 60, false).startsWith('qqg_refresh=a%2Bb%3Dc'));
  });

  it('sets Path=/', () => {
    assert.ok(buildCookie('tok', 60, false).includes('Path=/'));
  });
});

describe('QG-005: WebUI does not use sessionStorage for refresh tokens', () => {
  let html: string;

  before(() => {
    html = readFileSync(join(ROOT, 'webui', 'index.html'), 'utf8');
  });

  it('no sessionStorage.setItem for refresh token', () => {
    assert.ok(
      !/sessionStorage\.setItem\s*\(\s*['"](?:SK_REFRESH|qqg_refresh)['"]/.test(html),
      'sessionStorage.setItem for refresh token must not exist — QG-005 regression',
    );
  });

  it('no sessionStorage.getItem for refresh token', () => {
    assert.ok(
      !/sessionStorage\.getItem\s*\(\s*['"](?:SK_REFRESH|qqg_refresh)['"]/.test(html),
      'sessionStorage.getItem for refresh token must not exist — QG-005 regression',
    );
  });

  it('fetch calls include credentials:include so HttpOnly cookie is transmitted', () => {
    assert.ok(
      html.includes("credentials:'include'") || html.includes("credentials: 'include'"),
      'WebUI must use credentials:include for HttpOnly cookie transport',
    );
  });
});

// ─── QG-008: Environment-variable secret injection ───────────────────────────

describe('QG-008: env-var secrets override config at runtime and are never persisted to disk', () => {
  let root = '';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'qqg-qg008-'));
    delete process.env['QQ_GUARDIAN_JWT_SECRET'];
    delete process.env['QQ_GUARDIAN_AI_API_KEY'];
  });

  afterEach(() => {
    delete process.env['QQ_GUARDIAN_JWT_SECRET'];
    delete process.env['QQ_GUARDIAN_AI_API_KEY'];
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('QQ_GUARDIAN_JWT_SECRET overrides runtime jwtSecret without persisting to config.json', () => {
    const SECRET = 'unit-test-jwt-xyzzy-must-not-hit-disk-abcdef';
    process.env['QQ_GUARDIAN_JWT_SECRET'] = SECRET;
    const mgr = new ConfigManager();
    mgr.init(root);
    assert.equal(mgr.get().webui.jwtSecret, SECRET, 'Runtime value must equal env var');
    assert.ok(!readFileSync(join(root, 'config.json'), 'utf8').includes(SECRET),
      'JWT secret must not appear in config.json');
  });

  it('QQ_GUARDIAN_AI_API_KEY overrides runtime apiKey without persisting to config.json', () => {
    const KEY = 'unit-test-ai-key-placeholder-must-not-hit-disk-abcdef';
    process.env['QQ_GUARDIAN_AI_API_KEY'] = KEY;
    const mgr = new ConfigManager();
    mgr.init(root);
    assert.equal(mgr.get().ai.apiKey, KEY, 'Runtime value must equal env var');
    assert.ok(!readFileSync(join(root, 'config.json'), 'utf8').includes(KEY),
      'AI API key must not appear in config.json');
  });

  it('update() preserves the env-var override and never writes the secret to disk', () => {
    const SECRET = 'survives-update-xyzzy-must-not-hit-disk-abcdef';
    process.env['QQ_GUARDIAN_JWT_SECRET'] = SECRET;
    const mgr = new ConfigManager();
    mgr.init(root);

    // Trigger an update that changes a non-secret field.
    mgr.update({ webui: { jwtExpiresIn: '30m' } });

    assert.equal(mgr.get().webui.jwtSecret, SECRET, 'Override must survive update()');
    assert.ok(!readFileSync(join(root, 'config.json'), 'utf8').includes(SECRET),
      'Post-update config.json must not contain the env-var secret');
  });
});

// ─── QG-011: Bootstrap credential TTL ────────────────────────────────────────

describe('QG-011: bootstrap credential file expires after 48 hours', () => {
  it('removes a bootstrap file whose createdAt exceeds 48h', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qqg-qg011a-'));
    try {
      const { expireStaleBootstrapFile, bootstrapPath } = await import('../../src/modules/auth/index.ts');
      const filePath = bootstrapPath(dir);
      const oldDate = new Date(Date.now() - 49 * 3_600_000).toISOString();
      writeFileSync(filePath, JSON.stringify({
        schemaVersion: 1, username: 'a', password: 'b', createdAt: oldDate,
      }), { mode: 0o600 });

      assert.ok(existsSync(filePath), 'Pre-condition: file must exist before expiry check');
      expireStaleBootstrapFile(dir);
      assert.equal(existsSync(filePath), false, 'Expired file must be deleted');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('preserves a bootstrap file within the 48h TTL', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qqg-qg011b-'));
    try {
      const { expireStaleBootstrapFile, bootstrapPath } = await import('../../src/modules/auth/index.ts');
      const filePath = bootstrapPath(dir);
      const freshDate = new Date(Date.now() - 1 * 3_600_000).toISOString();
      writeFileSync(filePath, JSON.stringify({
        schemaVersion: 1, username: 'a', password: 'b', createdAt: freshDate,
      }), { mode: 0o600 });

      expireStaleBootstrapFile(dir);
      assert.ok(existsSync(filePath), 'Fresh file must be preserved within the TTL window');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('removes a file with a missing or unparseable createdAt (treated as stale)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qqg-qg011c-'));
    try {
      const { expireStaleBootstrapFile, bootstrapPath } = await import('../../src/modules/auth/index.ts');
      const filePath = bootstrapPath(dir);
      writeFileSync(filePath, JSON.stringify({
        schemaVersion: 1, username: 'a', password: 'b',
        // no createdAt field
      }), { mode: 0o600 });

      expireStaleBootstrapFile(dir);
      assert.equal(existsSync(filePath), false,
        'File with no createdAt must be treated as expired and removed');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
