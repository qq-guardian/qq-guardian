/**
 * In-chat admin commands — lets group owners/admins moderate without the WebUI.
 *
 *   /guard help                     usage
 *   /guard status                   this group's protection settings
 *   /guard mute <@user|qq> [min]    mute (default 10 minutes)
 *   /guard unmute <@user|qq>        lift a mute
 *   /guard kick <@user|qq>          kick
 *   /guard ban <@user|qq> [reason]  blacklist (THIS group only) + kick
 *   /guard unban <@user|qq>         pardon: un-blacklist + revoke kick records
 *
 * Security model:
 *  - Permission comes from event.sender.role ('owner'/'admin'), which the QQ
 *    server sets — a client cannot spoof it — or from core.superAdmins.
 *  - A NON-admin message starting with the prefix is NOT consumed: it falls
 *    through to risk scoring like any other message. Consuming it would let
 *    spammers bypass risk detection by prefixing spam with the command prefix.
 *  - The bot's own outgoing messages never reach this handler —
 *    plugin_onmessage drops message_sent/self events before any dispatch —
 *    so a bot reply can never trigger a command loop.
 *  - The bot itself and super admins can never be targeted (super admins can
 *    only be targeted by other super admins).
 *  - Destructive actions require a fresh, structurally valid member lookup;
 *    provider failure or ambiguous absence always fails closed.
 *  - Bans are always scoped to the invoking group — an admin of one group
 *    must never gain kick power across every group the bot manages.
 *  - Replies are segment arrays (never CQ-parsed strings) and never echo raw
 *    error internals into the chat.
 *  - Every executed command emits an AuditCreated event with the real actor.
 */
import { configManager } from '../../core/config/index.ts';
import { resolveGroupConfig } from '../../core/config/group.ts';
import { callOneBot as callAction } from '../../runtime/host.ts';
import { bus } from '../../core/events/index.ts';
import { punishmentService } from '../punishment/index.ts';
import { punishmentRepo } from '../../database/repositories/punishment.ts';
import { blacklistRepo } from '../../database/repositories/blacklist.ts';
import { getLogger } from '../../core/logger/index.ts';
import type { OB11Message, OB11MessageSegment } from '../../types/napcat.ts';
import { normalizeOneBotId, type OneBotId } from '../../types/onebot.ts';

/** QQ caps set_group_ban at 30 days. */
const MAX_MUTE_MINUTES = 43_200;
const DEFAULT_MUTE_MINUTES = 10;
/** Minimum gap between commands per (group, user) — silent drop below this. */
const COOLDOWN_MS = 2_000;

export type TargetGroupRole = 'member' | 'admin' | 'owner';
export type TargetRoleLookup =
  | { kind: 'member'; role: TargetGroupRole }
  /** Reserved for positive provider-specific absence evidence. Generic
   *  OneBot v11 member-info failures never qualify as confirmed absence. */
  | { kind: 'absent' }
  | { kind: 'unavailable'; failure: 'action_failed' | 'malformed_response' };

export interface CommandServiceOptions {
  /** Injectable so a future typed provider adapter can supply positive
   *  absence evidence without teaching command authorization error strings. */
  lookupTargetRole?: (groupId: OneBotId, userId: OneBotId) => Promise<TargetRoleLookup>;
}

type AuthorizationDenialReason =
  | 'target_privileged'
  | 'target_absent'
  | 'target_role_unavailable';

type DestructiveTargetAuthorization =
  | { allowed: true }
  | { allowed: false; reason: AuthorizationDenialReason };

function matchesOneBotId(value: unknown, expected: OneBotId): boolean {
  return normalizeOneBotId(value) === expected;
}

/**
 * Accept only a complete response for the exact requested member. A role by
 * itself is not authorization evidence: stale, cross-request, and malformed
 * responses must not gain the bot's moderation privileges.
 */
export function classifyTargetRoleResponse(
  value: unknown,
  groupId: OneBotId,
  userId: OneBotId,
): TargetRoleLookup {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { kind: 'unavailable', failure: 'malformed_response' };
  }
  const info = value as Record<string, unknown>;
  const role = info['role'];
  if (
    (role !== 'member' && role !== 'admin' && role !== 'owner')
    || !matchesOneBotId(info['group_id'], groupId)
    || !matchesOneBotId(info['user_id'], userId)
  ) {
    return { kind: 'unavailable', failure: 'malformed_response' };
  }
  return { kind: 'member', role };
}

export function authorizeDestructiveTarget(
  lookup: TargetRoleLookup,
  invokerIsOwner: boolean,
  isSuperAdmin: boolean,
): DestructiveTargetAuthorization {
  if (lookup.kind === 'unavailable') {
    return { allowed: false, reason: 'target_role_unavailable' };
  }
  // Today's `ban` command is kick + blacklist, not a separately designed
  // pre-emptive blacklist operation. Even positively confirmed absence is
  // therefore denied instead of silently changing command semantics.
  if (lookup.kind === 'absent') return { allowed: false, reason: 'target_absent' };
  if (
    (lookup.role === 'admin' || lookup.role === 'owner')
    && !invokerIsOwner
    && !isSuperAdmin
  ) {
    return { allowed: false, reason: 'target_privileged' };
  }
  return { allowed: true };
}

async function lookupTargetRoleViaOneBot(groupId: OneBotId, userId: OneBotId): Promise<TargetRoleLookup> {
  try {
    const info = await callAction('get_group_member_info', {
      group_id: String(groupId), user_id: String(userId), no_cache: true,
    });
    // OneBot v11 does not standardize a portable "not a member" response.
    // Null and missing data are malformed success responses, not proof of
    // absence; rejected actions likewise conflate transport and logical errors.
    return classifyTargetRoleResponse(info, groupId, userId);
  } catch {
    return { kind: 'unavailable', failure: 'action_failed' };
  }
}

function authorizationDenialText(reason: AuthorizationDenialReason): string {
  switch (reason) {
    case 'target_privileged':
      return '❌ 目标是群主/管理员，仅群主或超级管理员可对其执行该指令。';
    case 'target_absent':
      return '❌ 目标当前不在群内，已拒绝该指令；预先拉黑尚未启用。';
    case 'target_role_unavailable':
      return '❌ 无法确认目标的群成员身份，已安全拒绝该指令。请稍后重试。';
  }
}

export interface CommandInput {
  /** Concatenated text-segment content (CQ codes never leak in here) */
  text: string;
  /** QQ ids of @-mentioned users, in message order ('all' mentions excluded) */
  atTargets: OneBotId[];
  /** True when the message quotes another message (reply segment present) */
  hasReply: boolean;
}

/** Flattens OB11 segments into plain text + the list of @-mentioned QQ ids. */
export function extractCommandInput(message: OB11MessageSegment[] | undefined, rawMessage: string): CommandInput {
  if (!Array.isArray(message) || message.length === 0) {
    return { text: rawMessage, atTargets: [], hasReply: false };
  }
  let text = '';
  let hasReply = false;
  const atTargets: OneBotId[] = [];
  for (const seg of message) {
    if (seg.type === 'text') text += String(seg.data['text'] ?? '');
    else if (seg.type === 'reply') hasReply = true;
    else if (seg.type === 'at') {
      const qq = normalizeOneBotId(seg.data['qq']); // 'all' and malformed ids are excluded
      if (qq !== null) atTargets.push(qq);
    }
  }
  return { text, atTargets, hasReply };
}

/**
 * Parses "<prefix> <name> [args…]". Returns null when the text is not a
 * command. The prefix must be followed by whitespace or end-of-string, so a
 * prefix of "/guard" never swallows an unrelated "/guardian…" message.
 */
export function parseCommand(text: string, prefix: string): { name: string; args: string[] } | null {
  const trimmed = text.trim();
  if (!prefix || !trimmed.startsWith(prefix)) return null;
  const rest = trimmed.slice(prefix.length);
  if (rest !== '' && !/^\s/.test(rest)) return null;
  const parts = rest.trim().split(/\s+/).filter(Boolean);
  return { name: (parts[0] ?? 'help').toLowerCase(), args: parts.slice(1) };
}

/**
 * Resolves the command's target user: an @-mention wins; otherwise the first
 * argument that looks like a QQ id (all digits, 5–20 long — so a "10"-minute
 * duration is never mistaken for a target).
 */
export function resolveTarget(input: Pick<CommandInput, 'atTargets'>, args: string[]): OneBotId | null {
  if (input.atTargets.length > 0) return input.atTargets[0];
  const numeric = args.find((a) => /^\d{5,20}$/.test(a));
  return numeric ? normalizeOneBotId(numeric) : null;
}

/** First plausible duration-in-minutes argument, clamped to QQ's 30-day cap.
 *  Callers must remove the argument that resolved as the TARGET first —
 *  otherwise a 5-digit QQ id would be misread as a (clamped) duration. */
export function resolveMinutes(args: string[]): number {
  const numeric = args.find((a) => /^\d{1,5}$/.test(a));
  const n = numeric ? Number(numeric) : DEFAULT_MUTE_MINUTES;
  return Math.min(Math.max(n, 1), MAX_MUTE_MINUTES);
}

async function reply(groupId: OneBotId, text: string): Promise<void> {
  await callAction('send_group_msg', {
    group_id: String(groupId),
    message: [{ type: 'text', data: { text } }],
  }).catch(() => {});
}

function helpText(prefix: string): string {
  return [
    '🛡️ QQ Guardian 指令：',
    `${prefix} status — 查看本群防护状态`,
    `${prefix} mute <@某人|QQ号> [分钟] — 禁言（默认 10 分钟）`,
    `${prefix} unmute <@某人|QQ号> — 解除禁言`,
    `${prefix} kick <@某人|QQ号> — 踢出`,
    `${prefix} ban <@某人|QQ号> [原因] — 拉黑并踢出（仅本群）`,
    `${prefix} unban <@某人|QQ号> — 移出本群黑名单`,
  ].join('\n');
}

const ACTION_COMMANDS = new Set(['mute', 'unmute', 'kick', 'ban', 'unban']);

export class CommandService {
  private _lastCommandAt = new Map<string, number>();
  private readonly _lookupTargetRole: (groupId: OneBotId, userId: OneBotId) => Promise<TargetRoleLookup>;

  constructor(options: CommandServiceOptions = {}) {
    this._lookupTargetRole = options.lookupTargetRole ?? lookupTargetRoleViaOneBot;
  }

  /**
   * Returns true when the message was consumed as a command (skip risk
   * scoring), false when normal message processing should continue.
   */
  async handleGroupCommand(event: OB11Message): Promise<boolean> {
    const cfg = configManager.get();
    if (!cfg.commands.enabled) return false;

    // Any non-empty prefix the admin saved is honored (every config surface
    // already falls back to '/guard' for empty values) — silently overriding
    // a stored short prefix here would make saved settings appear broken.
    const prefix = cfg.commands.prefix?.trim() || '/guard';

    const input = extractCommandInput(event.message, event.raw_message);
    const cmd = parseCommand(input.text, prefix);
    if (!cmd) return false;

    const isSuperAdmin = cfg.core.superAdmins.includes(event.user_id);
    const isAdmin = event.sender?.role === 'owner' || event.sender?.role === 'admin' || isSuperAdmin;
    if (!isAdmin) return false; // falls through to risk scoring — see header

    const groupId = event.group_id!;

    // Per-(group,user) cooldown — silently drop bursts so the bot can never be
    // made to flood the group (sustained reply floods trip QQ risk control).
    const cooldownKey = `${groupId}:${event.user_id}`;
    const now = Date.now();
    const last = this._lastCommandAt.get(cooldownKey) ?? 0;
    if (now - last < COOLDOWN_MS) return true;
    this._lastCommandAt.set(cooldownKey, now);
    if (this._lastCommandAt.size > 5000) {
      for (const [k, v] of this._lastCommandAt) {
        if (now - v > COOLDOWN_MS) this._lastCommandAt.delete(k);
      }
    }

    const groupCfg = resolveGroupConfig(cfg, groupId);
    const log = getLogger().child({ module: 'commands' });
    log.info({ group_id: groupId, user_id: event.user_id, command: cmd.name }, 'Admin command received');

    try {
      switch (cmd.name) {
        case 'help':
          await reply(groupId, helpText(prefix));
          break;

        case 'status': {
          const lines = [
            `🛡️ 本群防护：${groupCfg.enabled ? '✅ 已开启' : '❌ 未开启'}`,
            `风险检测：${groupCfg.riskEnabled ? '开' : '关'} · 入群处理：${groupCfg.action}`,
            `黑名单自动踢出：${groupCfg.autoKickBlacklisted ? '开' : '关'} · 入群欢迎：${groupCfg.welcomeEnabled ? '开' : '关'}`,
            `宵禁：${groupCfg.curfewEnabled ? `${groupCfg.curfewStart} → ${groupCfg.curfewEnd}` : '关'}`,
          ];
          await reply(groupId, lines.join('\n'));
          break;
        }

        default: {
          if (!ACTION_COMMANDS.has(cmd.name)) {
            await reply(groupId, `❓ 未知指令 "${cmd.name.slice(0, 20)}"。发送 ${prefix} help 查看用法。`);
            break;
          }
          if (!groupCfg.enabled) {
            await reply(groupId, '❌ 本群防护未开启，无法执行管理指令。请先在 WebUI 中开启防护。');
            break;
          }
          if (input.hasReply) {
            // A quoted message can carry an auto-@ of its author, silently
            // retargeting the command — refuse rather than guess.
            await reply(groupId, `❌ 请不要引用回复使用指令，直接发送，如：${prefix} mute @某人 10`);
            break;
          }
          if (input.atTargets.length > 1) {
            await reply(groupId, '❌ 一次只能指定一个目标用户。');
            break;
          }
          const target = resolveTarget(input, cmd.args);
          if (!target) { await reply(groupId, `❌ 缺少目标用户。用法见 ${prefix} help`); break; }
          if (target === event.self_id || target === cfg.core.selfId) {
            await reply(groupId, '❌ 不能对机器人自身执行该指令。');
            break;
          }
          if (cfg.core.superAdmins.includes(target) && !isSuperAdmin) {
            await reply(groupId, '❌ 该用户是超级管理员，无法被普通管理员处理。');
            break;
          }
          // Destructive commands must not let one admin turn the bot's rank
          // against a fellow admin or the owner (the bot often outranks its
          // human admins). Only the group owner or a super admin may target
          // an admin. Pardons (unmute/unban) stay unrestricted.
          if (cmd.name === 'mute' || cmd.name === 'kick' || cmd.name === 'ban') {
            const targetLookup = await this._lookupTargetRole(groupId, target);
            const authorization = authorizeDestructiveTarget(
              targetLookup,
              event.sender?.role === 'owner',
              isSuperAdmin,
            );
            if (!authorization.allowed) {
              const denialDetails: Record<string, unknown> = {
                groupId,
                command: cmd.name,
                reason: authorization.reason,
                lookupStatus: targetLookup.kind,
              };
              if (targetLookup.kind === 'unavailable') {
                denialDetails['lookupFailure'] = targetLookup.failure;
              }
              log.warn(
                {
                  group_id: groupId,
                  user_id: event.user_id,
                  target_id: target,
                  command: cmd.name,
                  reason: authorization.reason,
                  lookup_status: targetLookup.kind,
                  ...(targetLookup.kind === 'unavailable'
                    ? { lookup_failure: targetLookup.failure }
                    : {}),
                },
                'Destructive command denied by target authorization',
              );
              bus.emit('AuditCreated', {
                action: 'command.authorization_denied',
                actorId: event.user_id,
                targetType: 'user',
                targetId: String(target),
                details: denialDetails,
                timestamp: Date.now(),
              });
              await reply(groupId, authorizationDenialText(authorization.reason));
              break;
            }
          }
          await this._runAction(cmd.name, groupId, target, cmd.args, event.user_id);
        }
      }
    } catch (e) {
      // Generic reply only — raw error text could leak internals into the chat.
      log.error({ group_id: groupId, command: cmd.name, error: String(e) }, 'Command failed');
      await reply(groupId, '❌ 执行失败（机器人可能不是管理员，或目标无法被处理）。详情见日志。');
    }

    bus.emit('AuditCreated', {
      action: `command.${cmd.name}`, actorId: event.user_id,
      targetType: 'group', targetId: String(groupId),
      details: { args: cmd.args, atTargets: input.atTargets }, timestamp: Date.now(),
    });
    return true;
  }

  private async _runAction(name: string, groupId: OneBotId, target: OneBotId, args: string[], operatorId: OneBotId): Promise<void> {
    switch (name) {
      case 'mute': {
        // Exclude the target's own id token before parsing the duration —
        // a 5-digit QQ id must never be misread as minutes.
        const minutes = resolveMinutes(args.filter((a) => normalizeOneBotId(a) !== target));
        await punishmentService.mute(groupId, target, minutes * 60, `群内指令（操作人 ${operatorId}）`, operatorId);
        await reply(groupId, `🔇 已禁言 ${target} ${minutes} 分钟。`);
        break;
      }
      case 'unmute': {
        // A pardon must also revoke the active mute records — otherwise the
        // anti-evasion check re-applies the mute if the user leaves and
        // rejoins before the original expiry (and the un-revoked record
        // keeps counting toward escalation).
        const now = Date.now();
        const activeMutes = punishmentRepo.findByUser(target, groupId)
          .filter((r) => r.type === 'mute' && r.revoked_at === null && (r.expires_at === null || r.expires_at > now));
        for (const r of activeMutes) punishmentRepo.revoke(r.id, operatorId);
        await punishmentService.unban(groupId, target, operatorId);
        await reply(groupId, `🔊 已解除 ${target} 的禁言。`);
        break;
      }
      case 'kick':
        await punishmentService.kick(groupId, target, `群内指令（操作人 ${operatorId}）`, operatorId);
        await reply(groupId, `👢 已踢出 ${target}。`);
        break;
      case 'ban': {
        // Reason = every argument that is neither the target id nor a duration
        const reason = args.filter((a) => !/^\d+$/.test(a)).join(' ').slice(0, 100) || '群内指令拉黑';
        // OneBot call FIRST, record second (same rule as punishmentService):
        // a QQ-rejected kick must not leave a silent blacklist entry behind
        // while the reply claims the command failed.
        await punishmentService.kick(groupId, target, reason, operatorId);
        blacklistRepo.add({ userId: target, groupId, reason, createdBy: operatorId });
        await reply(groupId, `⛔ 已将 ${target} 加入本群黑名单并踢出。`);
        break;
      }
      case 'unban': {
        blacklistRepo.remove(target, groupId);
        // A pardon must also revoke unrevoked kick records — otherwise the
        // anti-evasion check re-kicks the pardoned user on their next join.
        const activeKicks = punishmentRepo.findByUser(target, groupId)
          .filter((r) => r.type === 'kick' && r.revoked_at === null);
        for (const r of activeKicks) punishmentRepo.revoke(r.id, operatorId);
        await reply(groupId, `✅ 已将 ${target} 移出本群黑名单。`);
        break;
      }
    }
  }
}

export const commandService = new CommandService();
