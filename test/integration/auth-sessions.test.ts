import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configManager } from '../../src/core/config/index.ts';
import { hashPassword } from '../../src/core/crypto/index.ts';
import { closeDatabase, getDatabase, openDatabase } from '../../src/database/index.ts';
import { authSessionRepo } from '../../src/database/repositories/session.ts';
import { userRepo } from '../../src/database/repositories/user.ts';
import { clearRuntimeHost, setRuntimeHost } from '../../src/runtime/host.ts';
import { insertUserFixture, updateUserFixture } from '../helpers/user-fixtures.ts';
import {
  authenticateAccessToken,
  ensureBootstrapAdmin,
  login,
  refreshTokens,
  revokeUserSessions,
} from '../../src/modules/auth/index.ts';

const roots: string[] = [];

afterEach(() => {
  closeDatabase();
  clearRuntimeHost();
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function prepareStorage(): { configDir: string; dataDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'guardian-auth-session-'));
  roots.push(root);
  const configDir = join(root, 'config');
  const dataDir = join(root, 'data');
  configManager.init(configDir);
  openDatabase(dataDir);
  return { configDir, dataDir };
}

describe('durable auth sessions', () => {
  it('rotates refresh tokens once and revokes both token kinds on an account change', async () => {
    prepareStorage();
    const user = insertUserFixture({
      username: 'operator',
      passwordHash: await hashPassword('correct-horse-battery-staple'),
      role: 'viewer',
    });

    const signedIn = await login('operator', 'correct-horse-battery-staple', '127.0.0.1');
    assert.equal(signedIn.ok, true);
    assert.ok(signedIn.accessToken);
    assert.ok(signedIn.refreshToken);
    assert.equal(authenticateAccessToken(signedIn.accessToken!)?.user.id, user.id);

    const rotated = refreshTokens(signedIn.refreshToken!);
    assert.ok(rotated);
    assert.equal(refreshTokens(signedIn.refreshToken!), null, 'a consumed refresh token cannot be replayed');
    assert.equal(authenticateAccessToken(rotated.accessToken)?.user.id, user.id);

    revokeUserSessions(user.id);
    assert.equal(authenticateAccessToken(rotated.accessToken), null);
    assert.equal(refreshTokens(rotated.refreshToken), null);
  });

  it('rejects otherwise valid sessions while the account is locked or its role changes', async () => {
    prepareStorage();
    const user = insertUserFixture({
      username: 'reviewer',
      passwordHash: await hashPassword('correct-horse-battery-staple'),
      role: 'viewer',
    });
    const signedIn = await login('reviewer', 'correct-horse-battery-staple', '127.0.0.1');
    assert.ok(signedIn.accessToken);
    assert.ok(signedIn.refreshToken);

    updateUserFixture(user.id, { locked_until: Date.now() + 60_000 });
    assert.equal(authenticateAccessToken(signedIn.accessToken!), null);
    assert.equal(refreshTokens(signedIn.refreshToken!), null);

    updateUserFixture(user.id, { locked_until: null, role: 'member' });
    assert.equal(authenticateAccessToken(signedIn.accessToken!), null, 'a role claim cannot outlive a role change');
  });

  it('treats empty Compose bootstrap variables as unset and consumes the generated one-time credential', async () => {
    const { dataDir } = prepareStorage();
    const originalUsername = process.env['QQ_GUARDIAN_BOOTSTRAP_USERNAME'];
    const originalPassword = process.env['QQ_GUARDIAN_BOOTSTRAP_PASSWORD'];
    process.env['QQ_GUARDIAN_BOOTSTRAP_USERNAME'] = '';
    process.env['QQ_GUARDIAN_BOOTSTRAP_PASSWORD'] = '';
    setRuntimeHost({
      kind: 'snowluma',
      pluginId: 'test',
      paths: { pluginPath: dataDir, dataPath: dataDir, configDir: dataDir },
      logger: console,
      onebot: { call: async () => null },
      router: {} as never,
    });

    try {
      await ensureBootstrapAdmin();
      const bootstrapPath = join(dataDir, 'bootstrap-credentials.json');
      assert.equal(existsSync(bootstrapPath), true);
      const bootstrap = JSON.parse(readFileSync(bootstrapPath, 'utf8')) as { username: string; password: string };
      assert.equal(bootstrap.username, 'admin');
      assert.notEqual(bootstrap.password, 'admin');
      assert.ok(bootstrap.password.length >= 12);

      const signedIn = await login(bootstrap.username, bootstrap.password, '127.0.0.1');
      assert.equal(signedIn.ok, true);
      assert.equal(existsSync(bootstrapPath), false);
    } finally {
      if (originalUsername === undefined) delete process.env['QQ_GUARDIAN_BOOTSTRAP_USERNAME'];
      else process.env['QQ_GUARDIAN_BOOTSTRAP_USERNAME'] = originalUsername;
      if (originalPassword === undefined) delete process.env['QQ_GUARDIAN_BOOTSTRAP_PASSWORD'];
      else process.env['QQ_GUARDIAN_BOOTSTRAP_PASSWORD'] = originalPassword;
    }
  });

  it('keeps the generated one-time credential across a restart before first login', async () => {
    const { dataDir } = prepareStorage();
    const originalUsername = process.env['QQ_GUARDIAN_BOOTSTRAP_USERNAME'];
    const originalPassword = process.env['QQ_GUARDIAN_BOOTSTRAP_PASSWORD'];
    process.env['QQ_GUARDIAN_BOOTSTRAP_USERNAME'] = '';
    process.env['QQ_GUARDIAN_BOOTSTRAP_PASSWORD'] = '';
    setRuntimeHost({
      kind: 'snowluma',
      pluginId: 'test',
      paths: { pluginPath: dataDir, dataPath: dataDir, configDir: dataDir },
      logger: console,
      onebot: { call: async () => null },
      router: {} as never,
    });

    try {
      await ensureBootstrapAdmin();
      const bootstrapPath = join(dataDir, 'bootstrap-credentials.json');
      const first = readFileSync(bootstrapPath, 'utf8');

      // Simulate a process restart after the account was created but before
      // anyone could read/sign in with the one-time credential.
      await ensureBootstrapAdmin();
      assert.equal(existsSync(bootstrapPath), true);
      assert.equal(readFileSync(bootstrapPath, 'utf8'), first);

      const bootstrap = JSON.parse(first) as { username: string; password: string };
      assert.equal((await login(bootstrap.username, bootstrap.password, '127.0.0.1')).ok, true);
      assert.equal(existsSync(bootstrapPath), false);
    } finally {
      if (originalUsername === undefined) delete process.env['QQ_GUARDIAN_BOOTSTRAP_USERNAME'];
      else process.env['QQ_GUARDIAN_BOOTSTRAP_USERNAME'] = originalUsername;
      if (originalPassword === undefined) delete process.env['QQ_GUARDIAN_BOOTSTRAP_PASSWORD'];
      else process.env['QQ_GUARDIAN_BOOTSTRAP_PASSWORD'] = originalPassword;
    }
  });

  it('does not create an administrator in a nonempty installation without recovery opt-in', async () => {
    const { dataDir } = prepareStorage();
    const environment = [
      'QQ_GUARDIAN_BOOTSTRAP_USERNAME',
      'QQ_GUARDIAN_BOOTSTRAP_PASSWORD',
      'QQ_GUARDIAN_FORCE_BOOTSTRAP_RECOVERY',
    ] as const;
    const original = new Map(environment.map((name) => [name, process.env[name]]));
    const viewer = insertUserFixture({
      username: 'existing-viewer',
      passwordHash: await hashPassword('Existing-Viewer-Password-123!'),
      role: 'viewer',
    });
    setRuntimeHost({
      kind: 'snowluma',
      pluginId: 'test',
      paths: { pluginPath: dataDir, dataPath: dataDir, configDir: dataDir },
      logger: console,
      onebot: { call: async () => null },
      router: {} as never,
    });
    process.env['QQ_GUARDIAN_BOOTSTRAP_USERNAME'] = '';
    process.env['QQ_GUARDIAN_BOOTSTRAP_PASSWORD'] = '';
    process.env['QQ_GUARDIAN_FORCE_BOOTSTRAP_RECOVERY'] = '0';

    try {
      await ensureBootstrapAdmin();

      const users = userRepo.findAll();
      assert.equal(users.length, 1);
      assert.equal(users[0]?.id, viewer.id);
      assert.equal(users[0]?.role, 'viewer');
      assert.equal(existsSync(join(dataDir, 'bootstrap-credentials.json')), false);
      const adminAudits = getDatabase()
        .prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action LIKE 'auth.%admin%'")
        .get() as { count: number };
      assert.equal(adminAudits.count, 0);
    } finally {
      for (const name of environment) {
        const value = original.get(name);
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it('leaves an unusable administrator unchanged when recovery is disabled', async () => {
    const { dataDir } = prepareStorage();
    const originalRecovery = process.env['QQ_GUARDIAN_FORCE_BOOTSTRAP_RECOVERY'];
    const lockedUntil = Date.now() + 60_000;
    const locked = insertUserFixture({
      username: 'locked-admin',
      passwordHash: await hashPassword('Locked-Admin-Password-123!'),
      role: 'super_admin',
      lockedUntil,
    });
    setRuntimeHost({
      kind: 'snowluma',
      pluginId: 'test',
      paths: { pluginPath: dataDir, dataPath: dataDir, configDir: dataDir },
      logger: console,
      onebot: { call: async () => null },
      router: {} as never,
    });
    process.env['QQ_GUARDIAN_FORCE_BOOTSTRAP_RECOVERY'] = '0';

    try {
      await ensureBootstrapAdmin();

      const unchanged = userRepo.findById(locked.id);
      assert.equal(unchanged?.role, 'super_admin');
      assert.equal(unchanged?.locked_until, lockedUntil);
      assert.equal(existsSync(join(dataDir, 'bootstrap-credentials.json')), false);
      const recoveryAudits = getDatabase()
        .prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'auth.super_admin_recovered'")
        .get() as { count: number };
      assert.equal(recoveryAudits.count, 0);
    } finally {
      if (originalRecovery === undefined) delete process.env['QQ_GUARDIAN_FORCE_BOOTSTRAP_RECOVERY'];
      else process.env['QQ_GUARDIAN_FORCE_BOOTSTRAP_RECOVERY'] = originalRecovery;
    }
  });

  it('rejects incomplete or invalid forced-recovery credentials before side effects', async () => {
    const environment = [
      'QQ_GUARDIAN_BOOTSTRAP_USERNAME',
      'QQ_GUARDIAN_BOOTSTRAP_PASSWORD',
      'QQ_GUARDIAN_FORCE_BOOTSTRAP_RECOVERY',
    ] as const;
    const original = new Map(environment.map((name) => [name, process.env[name]]));
    const cases = [
      { name: 'missing pair', username: '', password: '', staleFile: false },
      { name: 'missing pair with stale file', username: '', password: '', staleFile: true },
      { name: 'missing password', username: 'recover-admin', password: '', staleFile: false },
      { name: 'missing username', username: '', password: 'Recovery-Password-123!', staleFile: false },
      { name: 'invalid username', username: 'x'.repeat(65), password: 'Recovery-Password-123!', staleFile: false },
      { name: 'invalid password', username: 'recover-admin', password: 'short', staleFile: false },
    ];

    try {
      for (const testCase of cases) {
        closeDatabase();
        clearRuntimeHost();
        const { dataDir } = prepareStorage();
        const passwordHash = await hashPassword('Old-Recovery-Password-123!');
        const lockedUntil = Date.now() + 60_000;
        const locked = insertUserFixture({
          username: 'recover-admin',
          passwordHash,
          role: 'super_admin',
          lockedUntil,
        });
        const oneTimePath = join(dataDir, 'bootstrap-credentials.json');
        const staleContents = `${JSON.stringify({
          schemaVersion: 1,
          username: 'recover-admin',
          password: 'Stale-Recovery-Password-123!',
        })}\n`;
        if (testCase.staleFile) writeFileSync(oneTimePath, staleContents, 'utf8');
        setRuntimeHost({
          kind: 'snowluma',
          pluginId: 'test',
          paths: { pluginPath: dataDir, dataPath: dataDir, configDir: dataDir },
          logger: console,
          onebot: { call: async () => null },
          router: {} as never,
        });
        process.env['QQ_GUARDIAN_BOOTSTRAP_USERNAME'] = testCase.username;
        process.env['QQ_GUARDIAN_BOOTSTRAP_PASSWORD'] = testCase.password;
        process.env['QQ_GUARDIAN_FORCE_BOOTSTRAP_RECOVERY'] = '1';

        await assert.rejects(
          ensureBootstrapAdmin(),
          /Both valid QQ_GUARDIAN_BOOTSTRAP_USERNAME and QQ_GUARDIAN_BOOTSTRAP_PASSWORD are required/,
          testCase.name,
        );

        const unchanged = userRepo.findById(locked.id);
        assert.equal(unchanged?.password_hash, passwordHash, testCase.name);
        assert.equal(unchanged?.locked_until, lockedUntil, testCase.name);
        assert.equal(unchanged?.role, 'super_admin', testCase.name);
        assert.equal(existsSync(oneTimePath), testCase.staleFile, testCase.name);
        if (testCase.staleFile) assert.equal(readFileSync(oneTimePath, 'utf8'), staleContents, testCase.name);
        const recoveryAudits = getDatabase()
          .prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'auth.super_admin_recovered'")
          .get() as { count: number };
        assert.equal(recoveryAudits.count, 0, testCase.name);
      }
    } finally {
      for (const name of environment) {
        const value = original.get(name);
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it('performs explicit break-glass recovery atomically, revokes sessions, and audits the event', async () => {
    const { dataDir } = prepareStorage();
    const environment = [
      'QQ_GUARDIAN_BOOTSTRAP_USERNAME',
      'QQ_GUARDIAN_BOOTSTRAP_PASSWORD',
      'QQ_GUARDIAN_FORCE_BOOTSTRAP_RECOVERY',
    ] as const;
    const original = new Map(environment.map((name) => [name, process.env[name]]));
    const locked = insertUserFixture({
      username: 'recover-admin',
      passwordHash: await hashPassword('Old-Password-123!'),
      role: 'super_admin',
      lockedUntil: Date.now() + 60_000,
    });
    const now = Date.now();
    authSessionRepo.create({
      tokenId: 'pre-recovery-session',
      userId: locked.id,
      kind: 'access',
      issuedAt: now,
      expiresAt: now + 60_000,
    });
    setRuntimeHost({
      kind: 'snowluma',
      pluginId: 'test',
      paths: { pluginPath: dataDir, dataPath: dataDir, configDir: dataDir },
      logger: console,
      onebot: { call: async () => null },
      router: {} as never,
    });
    process.env['QQ_GUARDIAN_BOOTSTRAP_USERNAME'] = 'recover-admin';
    process.env['QQ_GUARDIAN_BOOTSTRAP_PASSWORD'] = 'New-Recovery-Password-456!';
    process.env['QQ_GUARDIAN_FORCE_BOOTSTRAP_RECOVERY'] = '1';

    try {
      await ensureBootstrapAdmin();

      const recovered = userRepo.findById(locked.id);
      assert.equal(recovered?.role, 'super_admin');
      assert.equal(recovered?.locked_until, null);
      assert.equal(recovered?.login_attempts, 0);
      const priorSession = getDatabase()
        .prepare('SELECT revoked_at FROM auth_sessions WHERE token_id = ?')
        .get('pre-recovery-session') as { revoked_at: number | null };
      assert.ok(priorSession.revoked_at);

      const audit = getDatabase().prepare(
        `SELECT target_id, details FROM audit_logs
         WHERE action = 'auth.super_admin_recovered' ORDER BY id DESC LIMIT 1`
      ).get() as { target_id: string; details: string };
      assert.equal(audit.target_id, String(locked.id));
      assert.deepEqual(JSON.parse(audit.details), {
        username: 'recover-admin',
        mode: 'reset',
        previousRole: 'super_admin',
        sessionsRevoked: 1,
        source: 'startup_break_glass',
      });
      assert.equal(
        (await login('recover-admin', 'New-Recovery-Password-456!', '127.0.0.1')).ok,
        true,
      );
    } finally {
      for (const name of environment) {
        const value = original.get(name);
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});
