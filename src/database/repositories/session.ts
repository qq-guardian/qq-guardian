import { getDatabase } from '../index.ts';
import type { DbAuthSession } from '../models/index.ts';

export type AuthSessionKind = DbAuthSession['kind'];

/** Durable token-id registry. The database stores opaque JWT ids, never the
 * signed token itself, allowing a restart-safe revocation decision. */
export class AuthSessionRepository {
  create(data: {
    tokenId: string;
    userId: number;
    kind: AuthSessionKind;
    issuedAt: number;
    expiresAt: number;
  }): void {
    getDatabase().prepare(
      `INSERT INTO auth_sessions (token_id, user_id, kind, issued_at, expires_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, NULL)`
    ).run(data.tokenId, data.userId, data.kind, data.issuedAt, data.expiresAt);
  }

  findActive(tokenId: string, userId: number, kind: AuthSessionKind, now = Date.now()): DbAuthSession | null {
    return (getDatabase().prepare(
      `SELECT * FROM auth_sessions
       WHERE token_id = ? AND user_id = ? AND kind = ? AND revoked_at IS NULL AND expires_at > ?`
    ).get(tokenId, userId, kind, now) as unknown as DbAuthSession) ?? null;
  }

  revoke(tokenId: string, now = Date.now()): boolean {
    const result = getDatabase().prepare(
      'UPDATE auth_sessions SET revoked_at = ? WHERE token_id = ? AND revoked_at IS NULL'
    ).run(now, tokenId);
    return Number(result.changes) > 0;
  }

  revokeAllForUser(userId: number, now = Date.now()): number {
    const result = getDatabase().prepare(
      'UPDATE auth_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL'
    ).run(now, userId);
    return Number(result.changes);
  }

  purgeExpired(now = Date.now()): number {
    const result = getDatabase().prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').run(now);
    return Number(result.changes);
  }
}

export const authSessionRepo = new AuthSessionRepository();
