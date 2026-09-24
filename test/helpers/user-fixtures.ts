import { getDatabase } from '../../src/database/index.ts';
import type { DbUser } from '../../src/database/models/index.ts';

/**
 * Database-level fixture setup. Production management paths must never bypass
 * UserRepository's transactional administrator methods.
 */
export function insertUserFixture(data: {
  username: string;
  passwordHash: string;
  role: DbUser['role'];
  lockedUntil?: number | null;
}): DbUser {
  const now = Date.now();
  const result = getDatabase().prepare(
    `INSERT INTO users (
       username, password_hash, role, login_attempts, locked_until, created_at, updated_at
     ) VALUES (?, ?, ?, 0, ?, ?, ?)`
  ).run(
    data.username,
    data.passwordHash,
    data.role,
    data.lockedUntil ?? null,
    now,
    now,
  );
  return getDatabase()
    .prepare('SELECT * FROM users WHERE id = ?')
    .get(Number(result.lastInsertRowid)) as unknown as DbUser;
}

export function updateUserFixture(
  id: number,
  data: Partial<Pick<DbUser, 'role' | 'locked_until'>>,
): void {
  if (data.role !== undefined) {
    getDatabase().prepare('UPDATE users SET role = ?, updated_at = ? WHERE id = ?')
      .run(data.role, Date.now(), id);
  }
  if (data.locked_until !== undefined) {
    getDatabase().prepare('UPDATE users SET locked_until = ?, updated_at = ? WHERE id = ?')
      .run(data.locked_until, Date.now(), id);
  }
}
