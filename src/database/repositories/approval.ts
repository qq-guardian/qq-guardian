import { getDatabase } from '../index.ts';
import type { DbApprovalRecord } from '../models/index.ts';
import type { OneBotId } from '../../types/onebot.ts';

export class ApprovalRepository {
  findById(id: number): DbApprovalRecord | null {
    return (
      (getDatabase()
        .prepare('SELECT * FROM approval_records WHERE id = ?')
        .get(id) as unknown as DbApprovalRecord) ?? null
    );
  }


  /** Latest record for a given OneBot request flag. The admission-sync
   *  poller uses this to skip requests the live event stream (or an earlier
   *  sweep) already routed. */
  findByFlag(flag: string): DbApprovalRecord | null {
    return (
      (getDatabase()
        .prepare('SELECT * FROM approval_records WHERE flag = ? ORDER BY created_at DESC LIMIT 1')
        .get(flag) as unknown as DbApprovalRecord) ?? null
    );
  }

  findAllPending(limit = 50, offset = 0): DbApprovalRecord[] {
    return getDatabase()
      .prepare(
        `SELECT * FROM approval_records WHERE status IN ('pending','captcha')
         ORDER BY created_at DESC LIMIT ? OFFSET ?`
      )
      .all(limit, offset) as unknown as DbApprovalRecord[];
  }


  create(data: {
    groupId: OneBotId;
    userId: OneBotId;
    flag: string;
    comment: string;
    status: DbApprovalRecord['status'];
    ttlSeconds: number;
  }): DbApprovalRecord {
    const now = Date.now();
    const result = getDatabase()
      .prepare(
        `INSERT INTO approval_records
         (group_id, user_id, flag, comment, status, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        data.groupId,
        data.userId,
        data.flag,
        data.comment,
        data.status,
        now,
        now + data.ttlSeconds * 1000
      );
    return this.findById(Number(result.lastInsertRowid))!;
  }

  updateStatus(
    id: number,
    status: DbApprovalRecord['status'],
    operatorId: string | null = null,
    reason: string | null = null,
    captchaId: string | null = null
  ): void {
    getDatabase()
      .prepare(
        `UPDATE approval_records
         SET status = ?, operator_id = ?, reason = ?, captcha_id = ?, processed_at = ?
         WHERE id = ?`
      )
      .run(status, operatorId, reason, captchaId, Date.now(), id);
  }

  expireOldPending(): number {
    const result = getDatabase()
      .prepare(
        `UPDATE approval_records SET status = 'expired', processed_at = ?
         WHERE status IN ('pending','captcha') AND expires_at < ?`
      )
      .run(Date.now(), Date.now());
    return Number(result.changes);
  }

  countByStatus(): Record<string, number> {
    const rows = getDatabase()
      .prepare('SELECT status, COUNT(*) as cnt FROM approval_records GROUP BY status')
      .all() as Array<{ status: string; cnt: number }>;
    return Object.fromEntries(rows.map((r) => [r.status, r.cnt]));
  }
}

export const approvalRepo = new ApprovalRepository();
