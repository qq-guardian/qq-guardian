import { getDatabase } from '../index.ts';
import type { DbUser } from '../models/index.ts';
import type { OneBotId } from '../../types/onebot.ts';
import type { SQLInputValue } from 'node:sqlite';

export const LAST_USABLE_SUPER_ADMIN_MESSAGE =
  'At least one unlocked, password-enabled super administrator must remain';

export type UserAdminMutationErrorCode =
  | 'user_not_found'
  | 'self_delete'
  | 'last_usable_super_admin';

export class UserAdminMutationError extends Error {
  readonly code: UserAdminMutationErrorCode;

  constructor(code: UserAdminMutationErrorCode, message: string) {
    super(message);
    this.name = 'UserAdminMutationError';
    this.code = code;
  }
}

export interface UserCreateInput {
  qqId?: OneBotId;
  username?: string;
  passwordHash?: string;
  role: DbUser['role'];
}

export type UserAdministrativeUpdate = Partial<{
  passwordHash: string;
  role: DbUser['role'];
  loginAttempts: number;
  lockedUntil: number | null;
}>;

type UserAuthenticationUpdate = Partial<{
  lastLogin: number;
  loginAttempts: number;
  lockedUntil: number | null;
}>;

type MutationOutcome<T> = { value: T } | { error: UserAdminMutationError };

export function isUsableSuperAdmin(user: DbUser, now = Date.now()): boolean {
  return user.role === 'super_admin'
    && Boolean(user.username?.trim())
    && Boolean(user.password_hash)
    && (user.locked_until === null || user.locked_until <= now);
}

/**
 * User persistence plus the security boundary for administrator-driven
 * mutations. Management-plane changes must use the transactional methods
 * below so the last-usable-super-admin check, session revocation, and audit
 * entry commit atomically on the same SQLite connection.
 */
export class UserRepository {
  findById(id: number): DbUser | null {
    return (getDatabase().prepare('SELECT * FROM users WHERE id = ?').get(id) as unknown as DbUser) ?? null;
  }

  findByUsername(username: string): DbUser | null {
    return (
      (getDatabase()
        .prepare('SELECT * FROM users WHERE username = ?')
        .get(username) as unknown as DbUser) ?? null
    );
  }

  findAll(): DbUser[] {
    return getDatabase().prepare('SELECT * FROM users ORDER BY created_at DESC').all() as unknown as DbUser[];
  }

  countUsableSuperAdmins(now = Date.now()): number {
    return this.countOtherUsableSuperAdmins(null, now);
  }

  createByAdministrator(data: UserCreateInput, actorId: number): DbUser {
    return this.immediateTransaction(() => {
      const user = this.insert(data);
      this.writeAudit({
        action: 'auth.user_created',
        actorId,
        targetId: user.id,
        details: {
          username: user.username,
          qqId: user.qq_id,
          role: user.role,
        },
      });
      return user;
    });
  }

  /**
   * First-install bootstrap. The users-table emptiness check is repeated under
   * the write lock so bootstrap cannot add privilege to a nonempty installation
   * and two startup paths cannot both create an initial administrator.
   */
  createBootstrapAdmin(data: UserCreateInput): DbUser | null {
    return this.immediateTransaction(() => {
      const existing = getDatabase()
        .prepare('SELECT id FROM users LIMIT 1')
        .get();
      if (existing) return null;

      const user = this.insert(data);
      this.writeAudit({
        action: 'auth.bootstrap_admin_created',
        targetId: user.id,
        details: { username: user.username },
      });
      return user;
    });
  }

  /**
   * Explicit, startup-only break-glass recovery. A newly usable administrator
   * wins the race: recovery becomes a no-op after BEGIN IMMEDIATE rechecks the
   * invariant.
   */
  recoverSuperAdmin(data: {
    username: string;
    passwordHash: string;
  }): { user: DbUser; mode: 'created' | 'reset'; sessionsRevoked: number } | null {
    return this.immediateTransaction(() => {
      const now = Date.now();
      if (this.countOtherUsableSuperAdmins(null, now) > 0) return null;

      const existing = this.findByUsername(data.username);
      let user: DbUser;
      let mode: 'created' | 'reset';
      let sessionsRevoked = 0;

      if (existing) {
        getDatabase().prepare(
          `UPDATE users
           SET password_hash = ?, role = 'super_admin', login_attempts = 0,
               locked_until = NULL, updated_at = ?
           WHERE id = ?`
        ).run(data.passwordHash, now, existing.id);
        sessionsRevoked = this.revokeSessions(existing.id, now);
        user = this.findById(existing.id)!;
        mode = 'reset';
      } else {
        user = this.insert({
          username: data.username,
          passwordHash: data.passwordHash,
          role: 'super_admin',
        }, now);
        mode = 'created';
      }

      this.writeAudit({
        action: 'auth.super_admin_recovered',
        targetId: user.id,
        details: {
          username: user.username,
          mode,
          previousRole: existing?.role ?? null,
          sessionsRevoked,
          source: 'startup_break_glass',
        },
        now,
      });
      return { user, mode, sessionsRevoked };
    });
  }

  updateByAdministrator(
    id: number,
    data: UserAdministrativeUpdate,
    actorId: number,
  ): DbUser {
    const outcome = this.immediateTransaction<MutationOutcome<DbUser>>(() => {
      const now = Date.now();
      const current = this.findById(id);
      if (!current) {
        const error = new UserAdminMutationError('user_not_found', 'User not found');
        this.writeRejectedAudit(actorId, id, 'update', error, Object.keys(data), now);
        return { error };
      }

      const projected: DbUser = {
        ...current,
        password_hash: data.passwordHash ?? current.password_hash,
        role: data.role ?? current.role,
        login_attempts: data.loginAttempts ?? current.login_attempts,
        locked_until: data.lockedUntil === undefined ? current.locked_until : data.lockedUntil,
      };
      const changedFields = this.changedAdministrativeFields(current, projected);
      if (changedFields.length === 0) return { value: current };

      if (
        isUsableSuperAdmin(current, now)
        && !isUsableSuperAdmin(projected, now)
        && this.countOtherUsableSuperAdmins(id, now) === 0
      ) {
        const error = new UserAdminMutationError(
          'last_usable_super_admin',
          LAST_USABLE_SUPER_ADMIN_MESSAGE,
        );
        this.writeRejectedAudit(actorId, id, 'update', error, changedFields, now, {
          currentRole: current.role,
          requestedRole: projected.role,
        });
        return { error };
      }

      this.applyAdministrativeUpdate(id, data, now);
      const sessionsRevoked = this.revokeSessions(id, now);
      const updated = this.findById(id)!;
      this.writeAudit({
        action: 'auth.user_updated',
        actorId,
        targetId: id,
        details: {
          changedFields,
          previousRole: current.role,
          role: updated.role,
          sessionsRevoked,
        },
        now,
      });
      return { value: updated };
    });

    if ('error' in outcome) throw outcome.error;
    return outcome.value;
  }

  deleteByAdministrator(id: number, actorId: number): void {
    const outcome = this.immediateTransaction<MutationOutcome<null>>(() => {
      const now = Date.now();
      const current = this.findById(id);
      if (!current) {
        const error = new UserAdminMutationError('user_not_found', 'User not found');
        this.writeRejectedAudit(actorId, id, 'delete', error, [], now);
        return { error };
      }
      if (id === actorId) {
        const error = new UserAdminMutationError('self_delete', 'Cannot delete your own account');
        this.writeRejectedAudit(actorId, id, 'delete', error, [], now);
        return { error };
      }
      if (isUsableSuperAdmin(current, now) && this.countOtherUsableSuperAdmins(id, now) === 0) {
        const error = new UserAdminMutationError(
          'last_usable_super_admin',
          LAST_USABLE_SUPER_ADMIN_MESSAGE,
        );
        this.writeRejectedAudit(actorId, id, 'delete', error, [], now);
        return { error };
      }

      const sessions = getDatabase()
        .prepare('SELECT COUNT(*) AS count FROM auth_sessions WHERE user_id = ?')
        .get(id) as { count: number };
      this.writeAudit({
        action: 'auth.user_deleted',
        actorId,
        targetId: id,
        details: {
          username: current.username,
          role: current.role,
          sessionsRemoved: Number(sessions.count),
        },
        now,
      });
      getDatabase().prepare('DELETE FROM users WHERE id = ?').run(id);
      return { value: null };
    });

    if ('error' in outcome) throw outcome.error;
  }

  /** Login-state writes are intentionally narrower than administrator writes. */
  updateAuthenticationState(id: number, data: UserAuthenticationUpdate): void {
    const sets: string[] = [];
    const values: SQLInputValue[] = [];

    if (data.lastLogin !== undefined) { sets.push('last_login = ?'); values.push(data.lastLogin); }
    if (data.loginAttempts !== undefined) { sets.push('login_attempts = ?'); values.push(data.loginAttempts); }
    if (data.lockedUntil !== undefined) { sets.push('locked_until = ?'); values.push(data.lockedUntil); }
    if (sets.length === 0) return;

    sets.push('updated_at = ?');
    values.push(Date.now(), id);
    getDatabase().prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }

  recordLoginFailure(id: number, maxAttempts: number, lockedUntil: number): { attempts: number; locked: boolean } | null {
    const row = getDatabase().prepare(
      `UPDATE users
       SET login_attempts = login_attempts + 1,
           locked_until = CASE WHEN login_attempts + 1 >= ? THEN ? ELSE locked_until END,
           updated_at = ?
       WHERE id = ?
       RETURNING login_attempts, locked_until`
    ).get(maxAttempts, lockedUntil, Date.now(), id) as { login_attempts: number; locked_until: number | null } | undefined;
    if (!row) return null;
    return { attempts: row.login_attempts, locked: row.locked_until !== null && row.locked_until >= lockedUntil };
  }

  resetLoginAttempts(id: number): void {
    this.updateAuthenticationState(id, { loginAttempts: 0, lockedUntil: null, lastLogin: Date.now() });
  }

  private insert(data: UserCreateInput, now = Date.now()): DbUser {
    const result = getDatabase()
      .prepare(
        `INSERT INTO users (qq_id, username, password_hash, role, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(data.qqId ?? null, data.username ?? null, data.passwordHash ?? null, data.role, now, now);
    return this.findById(Number(result.lastInsertRowid))!;
  }

  private applyAdministrativeUpdate(id: number, data: UserAdministrativeUpdate, now: number): void {
    const sets: string[] = [];
    const values: SQLInputValue[] = [];
    if (data.passwordHash !== undefined) { sets.push('password_hash = ?'); values.push(data.passwordHash); }
    if (data.role !== undefined) { sets.push('role = ?'); values.push(data.role); }
    if (data.loginAttempts !== undefined) { sets.push('login_attempts = ?'); values.push(data.loginAttempts); }
    if (data.lockedUntil !== undefined) { sets.push('locked_until = ?'); values.push(data.lockedUntil); }
    if (sets.length === 0) return;
    sets.push('updated_at = ?');
    values.push(now, id);
    getDatabase().prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }

  private changedAdministrativeFields(current: DbUser, projected: DbUser): string[] {
    const changed: string[] = [];
    if (current.password_hash !== projected.password_hash) changed.push('password');
    if (current.role !== projected.role) changed.push('role');
    if (current.login_attempts !== projected.login_attempts) changed.push('loginAttempts');
    if (current.locked_until !== projected.locked_until) changed.push('lockedUntil');
    return changed;
  }

  private countOtherUsableSuperAdmins(excludedId: number | null, now: number): number {
    const exclusion = excludedId === null ? '' : 'AND id <> ?';
    const values: SQLInputValue[] = [now];
    if (excludedId !== null) values.push(excludedId);
    const row = getDatabase().prepare(
      `SELECT COUNT(*) AS count
       FROM users
       WHERE role = 'super_admin'
         AND username IS NOT NULL AND length(trim(username)) > 0
         AND password_hash IS NOT NULL AND length(password_hash) > 0
         AND (locked_until IS NULL OR locked_until <= ?)
         ${exclusion}`
    ).get(...values) as { count: number };
    return Number(row.count);
  }

  private revokeSessions(userId: number, now: number): number {
    const result = getDatabase().prepare(
      'UPDATE auth_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL'
    ).run(now, userId);
    return Number(result.changes);
  }

  private writeRejectedAudit(
    actorId: number,
    targetId: number,
    attemptedAction: 'update' | 'delete',
    error: UserAdminMutationError,
    changedFields: string[],
    now: number,
    details: Record<string, unknown> = {},
  ): void {
    this.writeAudit({
      action: 'auth.user_mutation_rejected',
      actorId,
      targetId,
      details: {
        attemptedAction,
        reason: error.code,
        changedFields,
        ...details,
      },
      now,
    });
  }

  private writeAudit(data: {
    action: string;
    actorId?: number;
    targetId: number;
    details: Record<string, unknown>;
    now?: number;
  }): void {
    getDatabase().prepare(
      `INSERT INTO audit_logs (action, actor_id, target_type, target_id, details, created_at)
       VALUES (?, ?, 'user', ?, ?, ?)`
    ).run(
      data.action,
      data.actorId === undefined ? null : String(data.actorId),
      String(data.targetId),
      JSON.stringify(data.details),
      data.now ?? Date.now(),
    );
  }

  private immediateTransaction<T>(operation: () => T): T {
    const database = getDatabase();
    database.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      database.exec('COMMIT');
      return result;
    } catch (error) {
      try { database.exec('ROLLBACK'); } catch { /* Preserve the original failure. */ }
      throw error;
    }
  }
}

export const userRepo = new UserRepository();
