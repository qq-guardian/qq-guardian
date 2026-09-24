import { punishmentRepo } from '../../database/repositories/punishment.ts';
import { blacklistRepo } from '../../database/repositories/blacklist.ts';
import { configManager } from '../../core/config/index.ts';
import { resolveGroupConfig } from '../../core/config/group.ts';
import { callOneBot as callAction } from '../../runtime/host.ts';
import { bus } from '../../core/events/index.ts';
import { withLock, locks } from '../../core/locks.ts';
import { statisticsRepo } from '../../database/repositories/statistics.ts';
import { getLogger } from '../../core/logger/index.ts';
import type { DbPunishmentRecord } from '../../database/models/index.ts';
import { normalizeOneBotId, type OneBotId } from '../../types/onebot.ts';

function canonicalActorId(value: string | null): OneBotId | null {
  if (value === null || value === '0') return null;
  const actorId = normalizeOneBotId(value);
  if (!actorId) throw new Error('Punishment actor must be a canonical OneBot identifier or the unset system actor');
  return actorId;
}

export class PunishmentService {
  async checkAndReapplyOnJoin(groupId: OneBotId, userId: OneBotId): Promise<boolean> {
    const cfg = configManager.get();
    if (!resolveGroupConfig(cfg, groupId).enabled) return false;

    const log = getLogger().child({ module: 'punishment' });
    let reKicked = false;
    await withLock(locks.punishment(groupId, userId), async () => {
      const now = Date.now();
      // Re-read inside the same lock used by mute, kick, and revoke. A revoke
      // that wins the race must prevent a stale join event from reapplying an
      // already-lifted punishment.
      const active = punishmentRepo
        .findByUser(userId, groupId)
        .filter((record) => record.revoked_at === null && (record.expires_at === null || record.expires_at > now));
      if (active.length === 0) return;

      const activeKick = active.find((record) => record.type === 'kick');
      if (activeKick) {
        const actorId = canonicalActorId(cfg.core.selfId);
        await this._kickLocked(
          groupId,
          userId,
          'Evasion attempt: rejoined after an unrevoked kick',
          actorId,
          false
        );
        log.warn(
          { user_id: userId, group_id: groupId, originalPunishmentId: activeKick.id },
          'Anti-evasion: re-kicked after an unrevoked removal'
        );
        bus.emit('AuditCreated', {
          action: 'punishment.anti_evasion_rekick',
          actorId: null,
          targetType: 'user',
          targetId: String(userId),
          details: { groupId, originalPunishmentId: activeKick.id },
          timestamp: now,
        });
        reKicked = true;
        await this._checkEscalationLocked(groupId, userId, actorId);
        return;
      }

      const activeMute = active.find((record) => record.type === 'mute');
      if (activeMute && activeMute.expires_at !== null) {
        const remainingSeconds = Math.max(1, Math.ceil((activeMute.expires_at - now) / 1000));
        await callAction('set_group_ban', {
          group_id: String(groupId),
          user_id: String(userId),
          duration: remainingSeconds,
        });
        log.warn(
          { user_id: userId, group_id: groupId, remainingSeconds, originalPunishmentId: activeMute.id },
          'Anti-evasion: re-applied mute for remaining duration'
        );
        bus.emit('AuditCreated', {
          action: 'punishment.anti_evasion_remute',
          actorId: null,
          targetType: 'user',
          targetId: String(userId),
          details: { groupId, remainingSeconds, originalPunishmentId: activeMute.id },
          timestamp: now,
        });
      }
    });

    return reKicked;
  }

  async mute(
    groupId: OneBotId,
    userId: OneBotId,
    durationSeconds: number,
    reason: string,
    operatorId: string | null
  ): Promise<DbPunishmentRecord> {
    const actorId = canonicalActorId(operatorId);
    return withLock(locks.punishment(groupId, userId), async () => {
      const record = await this._muteLocked(groupId, userId, durationSeconds, reason, actorId);
      await this._checkEscalationLocked(groupId, userId, actorId);
      return record;
    });
  }

  async kick(
    groupId: OneBotId,
    userId: OneBotId,
    reason: string,
    operatorId: string | null,
    rejectFuture = false
  ): Promise<DbPunishmentRecord> {
    const actorId = canonicalActorId(operatorId);
    return withLock(locks.punishment(groupId, userId), async () => {
      const record = await this._kickLocked(groupId, userId, reason, actorId, rejectFuture);
      await this._checkEscalationLocked(groupId, userId, actorId);
      return record;
    });
  }

  async unban(groupId: OneBotId, userId: OneBotId, operatorId: string | null): Promise<void> {
    const actorId = canonicalActorId(operatorId);
    await withLock(locks.punishment(groupId, userId), () =>
      this._unbanLocked(groupId, userId, actorId)
    );
  }

  async revoke(punishmentId: number, operatorId: string | null): Promise<void> {
    const actorId = canonicalActorId(operatorId);
    const candidate = punishmentRepo.findById(punishmentId);
    if (!candidate) throw new Error(`Punishment ${punishmentId} not found`);

    await withLock(locks.punishment(candidate.group_id, candidate.user_id), async () => {
      const record = punishmentRepo.findById(punishmentId);
      if (!record) throw new Error(`Punishment ${punishmentId} not found`);
      if (record.revoked_at !== null) return;

      const now = Date.now();
      const shouldUnban = this._isActiveMute(record, now) && !punishmentRepo
        .findByUser(record.user_id, record.group_id)
        .some((other) => other.id !== record.id && this._isActiveMute(other, now));

      // OneBot must acknowledge the unmute before the persisted revocation is
      // committed. If the call fails, the active record remains in place for a
      // safe retry and anti-evasion logic still sees the correct state.
      if (shouldUnban) {
        await callAction('set_group_ban', {
          group_id: String(record.group_id),
          user_id: String(record.user_id),
          duration: 0,
        });
      }

      punishmentRepo.revoke(record.id, actorId);
      if (shouldUnban) {
        bus.emit('AuditCreated', {
          action: 'punishment.unban',
          actorId,
          targetType: 'user',
          targetId: String(record.user_id),
          details: { groupId: record.group_id, via: 'revoke' },
          timestamp: now,
        });
      }
      bus.emit('AuditCreated', {
        action: 'punishment.revoke',
        actorId,
        targetType: 'punishment',
        targetId: String(record.id),
        details: { groupId: record.group_id, unbanned: shouldUnban },
        timestamp: now,
      });
    });
  }

  private async _muteLocked(
    groupId: OneBotId,
    userId: OneBotId,
    durationSeconds: number,
    reason: string,
    actorId: OneBotId | null
  ): Promise<DbPunishmentRecord> {
    await callAction('set_group_ban', {
      group_id: String(groupId),
      user_id: String(userId),
      duration: durationSeconds,
    });
    const record = punishmentRepo.create({ groupId, userId, type: 'mute', durationSeconds, reason, operatorId: actorId });
    statisticsRepo.bump(groupId, 'punishments_total');
    bus.emit('AuditCreated', {
      action: 'punishment.mute',
      actorId,
      targetType: 'user',
      targetId: String(userId),
      details: { groupId, durationSeconds, reason },
      timestamp: Date.now(),
    });
    return record;
  }

  private async _kickLocked(
    groupId: OneBotId,
    userId: OneBotId,
    reason: string,
    actorId: OneBotId | null,
    rejectFuture: boolean
  ): Promise<DbPunishmentRecord> {
    await callAction('set_group_kick', {
      group_id: String(groupId),
      user_id: String(userId),
      reject_add_request: rejectFuture,
    });
    const record = punishmentRepo.create({ groupId, userId, type: 'kick', durationSeconds: null, reason, operatorId: actorId });
    statisticsRepo.bump(groupId, 'punishments_total');
    bus.emit('AuditCreated', {
      action: 'punishment.kick',
      actorId,
      targetType: 'user',
      targetId: String(userId),
      details: { groupId, reason },
      timestamp: Date.now(),
    });
    return record;
  }

  private async _unbanLocked(groupId: OneBotId, userId: OneBotId, actorId: OneBotId | null): Promise<void> {
    await callAction('set_group_ban', {
      group_id: String(groupId),
      user_id: String(userId),
      duration: 0,
    });
    bus.emit('AuditCreated', {
      action: 'punishment.unban',
      actorId,
      targetType: 'user',
      targetId: String(userId),
      details: { groupId },
      timestamp: Date.now(),
    });
  }

  private _isActiveMute(record: DbPunishmentRecord, now: number): boolean {
    return record.type === 'mute'
      && record.revoked_at === null
      && (record.expires_at === null || record.expires_at > now);
  }

  /** Blacklist-threshold check alone (never kicks, never recurses, never
   *  throws). Returns true when the user was just auto-blacklisted. */
  private _maybeBlacklistLocked(groupId: OneBotId, userId: OneBotId, actorId: OneBotId | null): boolean {
    const log = getLogger().child({ module: 'punishment' });
    try {
      const cfg = configManager.get().punishment;
      const threshold = cfg.escalateToBlacklistAfter;
      if (threshold === 0) return false;

      const qualifyingKickCount = punishmentRepo.countActiveKicksByUser(userId, groupId);
      if (qualifyingKickCount >= threshold && !blacklistRepo.isBlacklisted(userId, groupId)) {
        blacklistRepo.add({
          userId,
          groupId,
          reason: `Auto-blacklisted after ${qualifyingKickCount} qualifying kicks`,
          createdBy: actorId,
        });
        log.warn(
          { user_id: userId, group_id: groupId, qualifying_kick_count: qualifyingKickCount, threshold },
          'Escalated to blacklist'
        );
        bus.emit('AuditCreated', {
          action: 'blacklist.auto_add',
          actorId,
          targetType: 'user',
          targetId: String(userId),
          details: { groupId, qualifyingKickCount, threshold },
          timestamp: Date.now(),
        });
        return true;
      }
    } catch (error) {
      log.error({ user_id: userId, group_id: groupId, error: String(error) }, 'Blacklist escalation check failed');
    }
    return false;
  }

  /** Escalation is best-effort: a failure here must never reject the mute or
   *  kick that already succeeded and is already recorded. */
  private async _checkEscalationLocked(groupId: OneBotId, userId: OneBotId, actorId: OneBotId | null): Promise<void> {
    const log = getLogger().child({ module: 'punishment' });
    if (this._maybeBlacklistLocked(groupId, userId, actorId)) return;
    try {
      const cfg = configManager.get().punishment;
      const threshold = cfg.escalateToKickAfter;
      if (threshold === 0) return;

      const qualifyingPunishmentCount = punishmentRepo.countActivePunishmentsByUser(userId, groupId);
      if (qualifyingPunishmentCount < threshold) return;
      if (punishmentRepo.countActiveKicksByUser(userId, groupId) > 0) return;

      log.warn(
        { user_id: userId, group_id: groupId, qualifying_punishment_count: qualifyingPunishmentCount, threshold },
        'Escalated to kick'
      );
      await this._kickLocked(
        groupId,
        userId,
        `Auto-kicked after ${qualifyingPunishmentCount} qualifying punishments`,
        actorId,
        false
      );
      bus.emit('AuditCreated', {
        action: 'punishment.auto_kick',
        actorId,
        targetType: 'user',
        targetId: String(userId),
        details: { groupId, qualifyingPunishmentCount, threshold },
        timestamp: Date.now(),
      });
      this._maybeBlacklistLocked(groupId, userId, actorId);
    } catch (error) {
      log.error({ user_id: userId, group_id: groupId, error: String(error) }, 'Escalation check failed');
    }
  }
}

export const punishmentService = new PunishmentService();
