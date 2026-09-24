import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configManager } from '../../src/core/config/index.ts';
import { hashPassword } from '../../src/core/crypto/index.ts';
import { closeDatabase, getDatabase, openDatabase } from '../../src/database/index.ts';
import { auditRepo } from '../../src/database/repositories/audit.ts';
import { LoginRateLimitRepository } from '../../src/database/repositories/rate-limit.ts';
import { login } from '../../src/modules/auth/index.ts';
import { insertUserFixture } from '../helpers/user-fixtures.ts';

const roots: string[] = [];

afterEach(() => {
  closeDatabase();
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function prepareStorage(): void {
  const root = mkdtempSync(join(tmpdir(), 'guardian-security-controls-'));
  roots.push(root);
  configManager.init(join(root, 'config'));
  openDatabase(join(root, 'data'));
}

describe('durable authentication controls', () => {
  it('keeps an active login rate-limit bucket across repository instances', () => {
    prepareStorage();
    const firstProcess = new LoginRateLimitRepository();
    const secondProcess = new LoginRateLimitRepository();
    const now = 1_800_000_000_000;

    assert.equal(firstProcess.consume('ip', '203.0.113.8', 2, 60_000, now).allowed, true);
    assert.equal(firstProcess.consume('ip', '203.0.113.8', 2, 60_000, now + 1).allowed, true);
    assert.equal(secondProcess.consume('ip', '203.0.113.8', 2, 60_000, now + 2).allowed, false);

    const afterWindow = secondProcess.consume('ip', '203.0.113.8', 2, 60_000, now + 60_001);
    assert.equal(afterWindow.allowed, true);
    assert.equal(afterWindow.attempts, 1);
  });

  it('writes exactly one account_locked audit event for a lockout cycle', async () => {
    prepareStorage();
    const cfg = configManager.get().auth;
    const user = insertUserFixture({
      username: 'lockout-target',
      passwordHash: await hashPassword('Correct-Password-123!'),
      role: 'viewer',
    });

    for (let attempt = 0; attempt < cfg.maxLoginAttempts; attempt += 1) {
      await login('lockout-target', 'wrong-password', '198.51.100.4', 'integration-test');
    }

    const locked = getDatabase()
      .prepare("SELECT action, target_type, target_id, details FROM audit_logs WHERE action = 'account_locked'")
      .all() as Array<{ action: string; target_type: string; target_id: string; details: string }>;
    assert.equal(locked.length, 1);
    assert.equal(locked[0]?.target_type, 'user');
    assert.equal(locked[0]?.target_id, String(user.id));
    assert.equal(locked[0]?.details, '{}');

    const blocked = await login('lockout-target', 'still-wrong', '198.51.100.4', 'integration-test');
    assert.equal(blocked.ok, false);
    assert.match(blocked.error ?? '', /locked/i);
    const count = getDatabase()
      .prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'account_locked'")
      .get() as { count: number };
    assert.equal(count.count, 1);
  });
});

describe('history retention', () => {
  it('prunes historical audit/login rows while preserving recent rows', async () => {
    prepareStorage();
    const user = insertUserFixture({
      username: 'retention-user',
      passwordHash: await hashPassword('Correct-Password-123!'),
      role: 'viewer',
    });
    const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1_000;
    const old = cutoff - 1_000;
    const recent = cutoff + 1_000;
    const db = getDatabase();

    db.prepare(
      `INSERT INTO audit_logs (action, actor_id, target_type, target_id, details, created_at)
       VALUES (?, NULL, 'user', ?, '{}', ?), (?, NULL, 'user', ?, '{}', ?)`
    ).run('old-audit', String(user.id), old, 'recent-audit', String(user.id), recent);
    db.prepare(
      `INSERT INTO login_logs (user_id, ip, user_agent, success, created_at)
       VALUES (?, '127.0.0.1', NULL, 0, ?), (?, '127.0.0.1', NULL, 1, ?)`
    ).run(user.id, old, user.id, recent);

    const result = auditRepo.pruneHistory(cutoff);
    assert.equal(result.auditLogs, 1);
    assert.equal(result.loginLogs, 1);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'recent-audit'").get() as { count: number }).count, 1);
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM login_logs WHERE created_at = ?').get(recent) as { count: number }).count, 1);
  });
});
