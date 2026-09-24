import { getDatabase } from '../index.ts';
import type { DbPunishmentRecord } from '../models/index.ts';
import type { OneBotId } from '../../types/onebot.ts';

export class PunishmentRepository {
  findById(id: number): DbPunishmentRecord | null {
    return (
      (getDatabase()
        .prepare('SELECT * FROM punishment_records WHERE id = ?')
        .get(id) as unknown as DbPunishmentRecord) ?? null
    );
  }

  findByUser(userId: OneBotId, groupId?: OneBotId): DbPunishmentRecord[] {
    if (groupId !== undefined) {
      return getDatabase()
        .prepare(
          'SELECT * FROM punishment_records WHERE user_id = ? AND group_id = ? ORDER BY created_at DESC'
        )
        .all(userId, groupId) as unknown as DbPunishmentRecord[];
    }
    return getDatabase()
      .prepare('SELECT * FROM punishment_records WHERE user_id = ? ORDER BY created_at DESC')
      .all(userId) as unknown as DbPunishmentRecord[];
  }


  findAll(limit = 50, offset = 0): DbPunishmentRecord[] {
    return getDatabase()
      .prepare('SELECT * FROM punishment_records ORDER BY created_at DESC LIMIT ? OFFSET ?')
      .all(limit, offset) as unknown as DbPunishmentRecord[];
  }

  countActivePunishmentsByUser(userId: OneBotId, groupId: OneBotId, now = Date.now()): number {
    const row = getDatabase()
      .prepare(
        `SELECT COUNT(*) AS cnt
         FROM punishment_records
         WHERE user_id = ? AND group_id = ?
           AND revoked_at IS NULL
           AND (expires_at IS NULL OR expires_at > ?)`
      )
      .get(userId, groupId, now) as { cnt: number };
    return Number(row.cnt);
  }

  countActiveKicksByUser(userId: OneBotId, groupId: OneBotId, now = Date.now()): number {
    const row = getDatabase()
      .prepare(
        `SELECT COUNT(*) AS cnt
         FROM punishment_records
         WHERE user_id = ? AND group_id = ?
           AND type = 'kick'
           AND revoked_at IS NULL
           AND (expires_at IS NULL OR expires_at > ?)`
      )
      .get(userId, groupId, now) as { cnt: number };
    return Number(row.cnt);
  }

  create(data: {
    groupId: OneBotId;
    userId: OneBotId;
    type: DbPunishmentRecord['type'];
    durationSeconds: number | null;
    reason: string;
    operatorId: OneBotId | null;
  }): DbPunishmentRecord {
    const now = Date.now();
    const expiresAt =
      data.durationSeconds !== null ? now + data.durationSeconds * 1000 : null;
    const result = getDatabase()
      .prepare(
        `INSERT INTO punishment_records
         (group_id, user_id, type, duration_seconds, reason, operator_id, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        data.groupId,
        data.userId,
        data.type,
        data.durationSeconds,
        data.reason,
        data.operatorId,
        now,
        expiresAt
      );
    return this.findById(Number(result.lastInsertRowid))!;
  }

  revoke(id: number, revokedBy: OneBotId | null): void {
    getDatabase()
      .prepare(
        'UPDATE punishment_records SET revoked_at = ?, revoked_by = ? WHERE id = ?'
      )
      .run(Date.now(), revokedBy, id);
  }

}

export const punishmentRepo = new PunishmentRepository();
