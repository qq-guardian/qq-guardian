import { getDatabase } from '../index.ts';
import type { DbBlacklistEntry } from '../models/index.ts';
import type { SQLInputValue } from 'node:sqlite';
import type { OneBotId } from '../../types/onebot.ts';

export class BlacklistRepository {
  isBlacklisted(userId: OneBotId, groupId: OneBotId | null = null): boolean {
    const now = Date.now();
    // Check global blacklist
    const global = getDatabase()
      .prepare(
        `SELECT 1 FROM blacklist
         WHERE user_id = ? AND group_id IS NULL
           AND (expires_at IS NULL OR expires_at > ?)
         LIMIT 1`
      )
      .get(userId, now);
    if (global) return true;

    if (groupId !== null) {
      const group = getDatabase()
        .prepare(
          `SELECT 1 FROM blacklist
           WHERE user_id = ? AND group_id = ?
             AND (expires_at IS NULL OR expires_at > ?)
           LIMIT 1`
        )
        .get(userId, groupId, now);
      if (group) return true;
    }
    return false;
  }

  findAll(limit = 50, offset = 0): DbBlacklistEntry[] {
    return getDatabase()
      .prepare('SELECT * FROM blacklist ORDER BY created_at DESC LIMIT ? OFFSET ?')
      .all(limit, offset) as unknown as DbBlacklistEntry[];
  }

  add(data: {
    userId: OneBotId;
    groupId: OneBotId | null;
    reason: string;
    createdBy: OneBotId | null;
    expiresAt?: number;
  }): DbBlacklistEntry {
    const now = Date.now();
    const db = getDatabase();
    // Two SQLite quirks force an explicit update-then-insert instead of a
    // plain upsert: (1) UNIQUE(user_id, group_id) treats NULL != NULL, so
    // global entries would silently duplicate; (2) on the DO UPDATE path
    // lastInsertRowid still points at whatever row was inserted LAST, so
    // re-selecting by it returns an unrelated user's entry.
    const updated =
      data.groupId === null
        ? db.prepare(
            `UPDATE blacklist SET reason = ?, created_by = ?, created_at = ?, expires_at = ?
             WHERE user_id = ? AND group_id IS NULL`
          ).run(data.reason, data.createdBy, now, data.expiresAt ?? null, data.userId)
        : db.prepare(
            `UPDATE blacklist SET reason = ?, created_by = ?, created_at = ?, expires_at = ?
             WHERE user_id = ? AND group_id = ?`
          ).run(data.reason, data.createdBy, now, data.expiresAt ?? null, data.userId, data.groupId);

    if (Number(updated.changes) === 0) {
      db.prepare(
        `INSERT INTO blacklist (user_id, group_id, reason, created_by, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(data.userId, data.groupId, data.reason, data.createdBy, now, data.expiresAt ?? null);
    }

    return (
      data.groupId === null
        ? db.prepare('SELECT * FROM blacklist WHERE user_id = ? AND group_id IS NULL').get(data.userId)
        : db.prepare('SELECT * FROM blacklist WHERE user_id = ? AND group_id = ?').get(data.userId, data.groupId)
    ) as unknown as DbBlacklistEntry;
  }

  remove(userId: OneBotId, groupId: OneBotId | null = null): boolean {
    const result = getDatabase()
      .prepare(
        groupId === null
          ? 'DELETE FROM blacklist WHERE user_id = ? AND group_id IS NULL'
          : 'DELETE FROM blacklist WHERE user_id = ? AND group_id = ?'
      )
      .run(...([userId, ...(groupId !== null ? [groupId] : [])] as SQLInputValue[]));
    return result.changes > 0;
  }

  purgeExpired(limit = 250): number {
    const result = getDatabase()
      .prepare(
        `DELETE FROM blacklist
         WHERE id IN (
           SELECT id FROM blacklist
           WHERE expires_at IS NOT NULL AND expires_at < ?
           ORDER BY id
           LIMIT ?
         )`
      )
      .run(Date.now(), limit);
    return Number(result.changes);
  }
}

export const blacklistRepo = new BlacklistRepository();
