import { getDatabase } from '../index.ts';
import type { DbAuditLog } from '../models/index.ts';
import type { SQLInputValue } from 'node:sqlite';

export interface RetentionPruneResult {
  auditLogs: number;
  loginLogs: number;
  approvals: number;
  punishments: number;
  captchaSessions: number;
}

export class AuditRepository {
  log(data: {
    action: string;
    actorId?: string;
    targetType?: string;
    targetId?: string;
    details?: Record<string, unknown>;
  }): void {
    getDatabase()
      .prepare(
        `INSERT INTO audit_logs (action, actor_id, target_type, target_id, details, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        data.action,
        data.actorId ?? null,
        data.targetType ?? null,
        data.targetId ?? null,
        JSON.stringify(data.details ?? {}),
        Date.now()
      );
  }

  findAll(
    opts: { action?: string; actorId?: string; limit?: number; offset?: number } = {}
  ): DbAuditLog[] {
    const { action, actorId, limit = 50, offset = 0 } = opts;
    const where: string[] = [];
    const vals: unknown[] = [];

    if (action) { where.push('action = ?'); vals.push(action); }
    if (actorId !== undefined) { where.push('actor_id = ?'); vals.push(actorId); }

    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    vals.push(limit, offset);

    return getDatabase()
      .prepare(`SELECT * FROM audit_logs ${clause} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .all(...(vals as SQLInputValue[])) as unknown as DbAuditLog[];
  }

  logLogin(data: { userId: number; ip: string; userAgent?: string; success: boolean }): void {
    getDatabase()
      .prepare(
        `INSERT INTO login_logs (user_id, ip, user_agent, success, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(data.userId, data.ip, data.userAgent ?? null, data.success ? 1 : 0, Date.now());
  }

  /**
   * Prune only historical rows that can no longer affect live moderation or
   * admission state. Permanent/active punishments and pending admissions are
   * deliberately retained. The caller supplies an absolute cutoff so policy
   * remains explicit and testable.
   */
  pruneHistory(cutoffMs: number): RetentionPruneResult {
    if (!Number.isSafeInteger(cutoffMs) || cutoffMs < 0) throw new RangeError('retention cutoff must be a non-negative integer');
    const db = getDatabase();
    db.exec('BEGIN IMMEDIATE');
    try {
      const auditLogs = Number(db.prepare('DELETE FROM audit_logs WHERE created_at < ?').run(cutoffMs).changes);
      const loginLogs = Number(db.prepare('DELETE FROM login_logs WHERE created_at < ?').run(cutoffMs).changes);
      const captchaSessions = Number(db.prepare('DELETE FROM captcha_sessions WHERE expires_at < ?').run(cutoffMs).changes);
      const approvals = Number(db.prepare(
        `DELETE FROM approval_records
         WHERE status NOT IN ('pending', 'captcha')
           AND created_at < ?
           AND expires_at < ?`
      ).run(cutoffMs, cutoffMs).changes);
      const punishments = Number(db.prepare(
        `DELETE FROM punishment_records
         WHERE created_at < ?
           AND (
             (revoked_at IS NOT NULL AND revoked_at < ?)
             OR (expires_at IS NOT NULL AND expires_at < ?)
           )`
      ).run(cutoffMs, cutoffMs, cutoffMs).changes);
      db.exec('COMMIT');
      return { auditLogs, loginLogs, approvals, punishments, captchaSessions };
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* Preserve original error. */ }
      throw error;
    }
  }
}

export const auditRepo = new AuditRepository();
