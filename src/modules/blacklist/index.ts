import { blacklistRepo } from '../../database/repositories/blacklist.ts';
import { configManager } from '../../core/config/index.ts';
import { resolveGroupConfig } from '../../core/config/group.ts';
import { callOneBot as callAction } from '../../runtime/host.ts';
import { getLogger } from '../../core/logger/index.ts';
import type { MemberJoinEvent, MemberJoinStageResult } from '../../types/member-join.ts';
import { punishmentService } from '../punishment/index.ts';
import type { OneBotId } from '../../types/onebot.ts';

/**
 * Applies blacklist admission policy and reports whether the member must not
 * proceed to later join stages. A failed removal remains terminal: a known
 * blacklisted member must never receive a welcome while OneBot is retried.
 */
export async function handleBlacklistMemberJoin(
  event: MemberJoinEvent
): Promise<MemberJoinStageResult> {
  const config = configManager.get();
  const groupConfig = resolveGroupConfig(config, event.groupId);
  if (!groupConfig.enabled) return 'continue';

  if (!groupConfig.autoKickBlacklisted || !blacklistRepo.isBlacklisted(event.userId, event.groupId)) {
    if (groupConfig.notifyOnJoin) await notifyJoin(config.core.superAdmins, event);
    return 'continue';
  }

  const log = getLogger().child({ module: 'blacklist' });
  log.info(
    { user_id: event.userId, group_id: event.groupId },
    'Auto-kicking blacklisted user'
  );
  try {
    await punishmentService.kick(
      event.groupId,
      event.userId,
      'Blacklisted user',
      config.core.selfId
    );
  } catch (error) {
    log.error(error, 'Blacklist auto-kick failed');
  }
  if (groupConfig.notifyOnJoin) await notifyJoin(config.core.superAdmins, event);
  return 'stop';
}

async function notifyJoin(superAdmins: OneBotId[], event: MemberJoinEvent): Promise<void> {
  for (const id of superAdmins) {
    await callAction('send_private_msg', {
      user_id: String(id),
      message: `👤 用户 ${event.userId} 加入了群 ${event.groupId}`,
    }).catch(() => {});
  }
}
