/**
 * Welcome messages — greets new members in groups that opted in.
 *
 * The per-group template supports two placeholders:
 *   {user}  → replaced with an @-mention segment for the new member
 *   {group} → replaced with the group's display name
 * A template without {user} gets the mention prepended, so the new member is
 * always notified. An empty template falls back to DEFAULT_TEMPLATE.
 */
import { configManager } from '../../core/config/index.ts';
import { resolveGroupConfig } from '../../core/config/group.ts';
import { callOneBot as callAction } from '../../runtime/host.ts';
import type { OB11MessageSegment } from '../../types/napcat.ts';
import type { MemberJoinEvent } from '../../types/member-join.ts';
import type { OneBotId } from '../../types/onebot.ts';

export const DEFAULT_TEMPLATE = '👋 欢迎 {user} 加入 {group}！请先阅读群公告。';

/**
 * Builds OB11 message segments from a welcome template. {user} becomes a real
 * @-mention segment (not just the QQ number as text); {group} is plain text.
 */
export function buildWelcomeSegments(
  template: string,
  userId: OneBotId,
  groupName: string,
  groupId: OneBotId
): OB11MessageSegment[] {
  const text = (template.trim() || DEFAULT_TEMPLATE)
    .replaceAll('{group}', groupName || String(groupId));
  const at: OB11MessageSegment = { type: 'at', data: { qq: String(userId) } };

  const parts = text.split('{user}');
  const segments: OB11MessageSegment[] = [];
  parts.forEach((part, i) => {
    if (i > 0) segments.push(at);
    if (part) segments.push({ type: 'text', data: { text: part } });
  });
  // No {user} in the template — still @-mention so the member gets notified.
  if (parts.length === 1) segments.unshift(at, { type: 'text', data: { text: ' ' } });
  return segments;
}

// Flood guard: join/leave cycling must not turn the welcome into a spam
// source that trips QQ's rate limits against the bot account itself.
const USER_COOLDOWN_MS = 10 * 60_000; // same user re-greeted at most every 10 min
const GROUP_MIN_INTERVAL_MS = 3_000;  // at most one welcome per group per 3 s
const _lastUserWelcome = new Map<string, number>();
const _lastGroupWelcome = new Map<OneBotId, number>();

/** Sends a welcome only after every terminal admission stage has passed. */
export async function sendWelcomeForMemberJoin(event: MemberJoinEvent): Promise<void> {
  const config = configManager.get();
  const groupConfig = resolveGroupConfig(config, event.groupId);
  if (!groupConfig.enabled || !groupConfig.welcomeEnabled) return;

  const now = Date.now();
  const userKey = `${event.groupId}:${event.userId}`;
  if (now - (_lastUserWelcome.get(userKey) ?? 0) < USER_COOLDOWN_MS) return;
  if (now - (_lastGroupWelcome.get(event.groupId) ?? 0) < GROUP_MIN_INTERVAL_MS) return;
  _lastUserWelcome.set(userKey, now);
  _lastGroupWelcome.set(event.groupId, now);
  if (_lastUserWelcome.size > 5000) {
    for (const [key, timestamp] of _lastUserWelcome) {
      if (now - timestamp > USER_COOLDOWN_MS) _lastUserWelcome.delete(key);
    }
  }

  await callAction('send_group_msg', {
    group_id: String(event.groupId),
    message: buildWelcomeSegments(
      groupConfig.welcomeTemplate,
      event.userId,
      groupConfig.groupName,
      event.groupId
    ),
  });
}
