import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { configManager } from '../../src/core/config/index.ts';
import { closeDatabase, getDatabase, openDatabase } from '../../src/database/index.ts';
import { authSessionRepo } from '../../src/database/repositories/session.ts';
import {
  UserAdminMutationError,
  userRepo,
} from '../../src/database/repositories/user.ts';
import { insertUserFixture } from '../helpers/user-fixtures.ts';

const roots: string[] = [];

afterEach(() => {
  closeDatabase();
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function prepareStorage(): string {
  const root = mkdtempSync(join(tmpdir(), 'guardian-admin-invariant-'));
  roots.push(root);
  configManager.init(join(root, 'config'));
  const dataDir = join(root, 'data');
  openDatabase(dataDir);
  return dataDir;
}

function admin(username: string, lockedUntil: number | null = null) {
  return insertUserFixture({
    username,
    passwordHash: `hash-for-${username}`,
    role: 'super_admin',
    lockedUntil,
  });
}

function session(userId: number, tokenId: string): void {
  const now = Date.now();
  authSessionRepo.create({
    tokenId,
    userId,
    kind: 'access',
    issuedAt: now,
    expiresAt: now + 60_000,
  });
}

function sessionRow(tokenId: string): { revoked_at: number | null } | undefined {
  return getDatabase()
    .prepare('SELECT revoked_at FROM auth_sessions WHERE token_id = ?')
    .get(tokenId) as { revoked_at: number | null } | undefined;
}

function audits(action: string): Array<{ details: string; actor_id: number | null; target_id: string }> {
  return getDatabase()
    .prepare('SELECT details, actor_id, target_id FROM audit_logs WHERE action = ? ORDER BY id')
    .all(action) as Array<{ details: string; actor_id: number | null; target_id: string }>;
}

function expectMutationError(
  operation: () => unknown,
  code: UserAdminMutationError['code'],
): void {
  assert.throws(operation, (error: unknown) =>
    error instanceof UserAdminMutationError && error.code === code);
}

describe('bootstrap administrator boundary', () => {
  it('rejects first-install bootstrap when any user already exists', () => {
    prepareStorage();
    const existing = insertUserFixture({
      username: 'existing-viewer',
      passwordHash: 'hash-for-existing-viewer',
      role: 'viewer',
    });

    const bootstrapped = userRepo.createBootstrapAdmin({
      username: 'unexpected-admin',
      passwordHash: 'hash-for-unexpected-admin',
      role: 'super_admin',
    });

    assert.equal(bootstrapped, null);
    assert.deepEqual(userRepo.findAll().map((user) => user.id), [existing.id]);
    assert.equal(audits('auth.bootstrap_admin_created').length, 0);
  });
});

describe('last usable super-administrator invariant', () => {
  it('rejects single-admin demotion, self-delete, and deletion by another actor without changing sessions', () => {
    prepareStorage();
    const onlyAdmin = admin('only-admin');
    const viewer = insertUserFixture({
      username: 'viewer',
      passwordHash: 'hash-for-viewer',
      role: 'viewer',
    });
    session(onlyAdmin.id, 'only-admin-session');

    expectMutationError(
      () => userRepo.updateByAdministrator(onlyAdmin.id, { role: 'viewer' }, onlyAdmin.id),
      'last_usable_super_admin',
    );
    expectMutationError(
      () => userRepo.deleteByAdministrator(onlyAdmin.id, onlyAdmin.id),
      'self_delete',
    );
    expectMutationError(
      () => userRepo.deleteByAdministrator(onlyAdmin.id, viewer.id),
      'last_usable_super_admin',
    );

    assert.equal(userRepo.findById(onlyAdmin.id)?.role, 'super_admin');
    assert.equal(sessionRow('only-admin-session')?.revoked_at, null);
    assert.equal(userRepo.countUsableSuperAdmins(), 1);
    assert.deepEqual(
      audits('auth.user_mutation_rejected').map((entry) =>
        (JSON.parse(entry.details) as { reason: string }).reason),
      ['last_usable_super_admin', 'self_delete', 'last_usable_super_admin'],
    );
  });

  it('allows self-demotion and another-admin deletion while a usable fallback remains', () => {
    prepareStorage();
    const first = admin('first-admin');
    const second = admin('second-admin');
    const fallback = admin('fallback-admin');
    session(first.id, 'first-session');
    session(second.id, 'second-session');

    userRepo.updateByAdministrator(first.id, { role: 'viewer' }, first.id);
    userRepo.deleteByAdministrator(second.id, fallback.id);

    assert.equal(userRepo.findById(first.id)?.role, 'viewer');
    assert.ok(sessionRow('first-session')?.revoked_at);
    assert.equal(userRepo.findById(second.id), null);
    assert.equal(sessionRow('second-session'), undefined, 'delete cascades durable sessions');
    assert.equal(userRepo.countUsableSuperAdmins(), 1);
    assert.equal(audits('auth.user_updated').length, 1);
    assert.equal(audits('auth.user_deleted').length, 1);
  });

  it('does not count locked or passwordless fallbacks, then permits mutation after unlock', () => {
    prepareStorage();
    const active = admin('active-admin');
    const locked = admin('locked-admin', Date.now() + 60_000);
    insertUserFixture({
      username: 'passwordless-admin',
      passwordHash: '',
      role: 'super_admin',
    });
    session(locked.id, 'locked-session');

    expectMutationError(
      () => userRepo.updateByAdministrator(active.id, { role: 'auditor' }, active.id),
      'last_usable_super_admin',
    );
    assert.equal(userRepo.countUsableSuperAdmins(), 1);

    userRepo.updateByAdministrator(
      locked.id,
      { loginAttempts: 0, lockedUntil: null },
      active.id,
    );
    assert.ok(sessionRow('locked-session')?.revoked_at);
    userRepo.updateByAdministrator(active.id, { role: 'auditor' }, active.id);

    assert.equal(userRepo.findById(active.id)?.role, 'auditor');
    assert.equal(userRepo.countUsableSuperAdmins(), 1);
  });

  it('serializes competing demotions across SQLite connections so exactly one administrator survives', async () => {
    const dataDir = prepareStorage();
    const first = admin('concurrent-first');
    const second = admin('concurrent-second');
    const workerUrl = new URL('../helpers/admin-mutation-worker.ts', import.meta.url);
    const workers = [
      new Worker(workerUrl, {
        execArgv: ['--experimental-strip-types'],
        workerData: { dataDir, userId: first.id, actorId: first.id },
      }),
      new Worker(workerUrl, {
        execArgv: ['--experimental-strip-types'],
        workerData: { dataDir, userId: second.id, actorId: second.id },
      }),
    ];
    await Promise.all(workers.map(async (worker) => {
      const [message] = await once(worker, 'message');
      assert.deepEqual(message, { type: 'ready' });
    }));
    const resultPromises = workers.map(async (worker) => (await once(worker, 'message'))[0] as {
      ok: boolean;
      code?: string;
    });
    const exitPromises = workers.map((worker) => once(worker, 'exit'));
    workers.forEach((worker) => worker.postMessage({ type: 'start' }));
    const results = await Promise.all(resultPromises);
    await Promise.all(exitPromises);

    assert.equal(results.filter((result) => result.ok).length, 1);
    assert.equal(results.find((result) => !result.ok)?.code, 'last_usable_super_admin');
    assert.equal(userRepo.countUsableSuperAdmins(), 1);
    assert.equal(audits('auth.user_mutation_rejected').length, 1);
  });

  it('rolls back the user and session changes when the success audit cannot be written', () => {
    prepareStorage();
    const target = admin('rollback-target');
    const fallback = admin('rollback-fallback');
    session(target.id, 'rollback-session');
    getDatabase().exec(`
      CREATE TRIGGER reject_success_audit
      BEFORE INSERT ON audit_logs
      WHEN NEW.action = 'auth.user_updated'
      BEGIN
        SELECT RAISE(ABORT, 'simulated audit failure');
      END
    `);

    assert.throws(
      () => userRepo.updateByAdministrator(target.id, { role: 'viewer' }, fallback.id),
      /simulated audit failure/,
    );
    assert.equal(userRepo.findById(target.id)?.role, 'super_admin');
    assert.equal(sessionRow('rollback-session')?.revoked_at, null);
    assert.equal(audits('auth.user_updated').length, 0);
    assert.equal(userRepo.countUsableSuperAdmins(), 2);
  });
});
