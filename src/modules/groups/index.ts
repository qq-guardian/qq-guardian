/**
 * Boot-time group bootstrap.
 *
 * Sequencing contract (per spec):
 *   1. Fetch the bot's own QQ account info FIRST. This is a prerequisite —
 *      if it fails after all retries, we log an explicit error and DO NOT
 *      proceed to fetch the group list (group list pulling is skipped, not
 *      attempted with a missing/invalid bot identity).
 *   2. Only once bot info succeeds do we fetch the full group list.
 *   3. The fetched groups are MERGED into persisted config — any group the
 *      admin has already configured keeps every existing field untouched;
 *      only genuinely new groups receive default values, and group_name is
 *      refreshed for all groups (it's a display cache, safe to overwrite).
 *
 * Both bot info and the group list are cached in module-level variables so
 * the WebUI can render instantly without waiting on a live OneBot round trip
 * on every page load. The WebUI's own "refresh" action re-runs this bootstrap.
 */
import { callOneBot as callAction } from '../../runtime/host.ts';
import { configManager } from '../../core/config/index.ts';
import { buildNewGroupConfig } from '../../core/config/group.ts';
import { getLogger } from '../../core/logger/index.ts';
import type { DeepPartial, GroupApprovalConfig } from '../../core/config/types.ts';
import { normalizeOneBotId, type OneBotId } from '../../types/onebot.ts';

export interface BotInfo {
  user_id: OneBotId;
  nickname: string;
}

export interface OneBotGroup {
  group_id: OneBotId;
  group_name: string;
  member_count: number;
  max_member_count: number;
}

let _botInfo: BotInfo | undefined;
let _groupList: OneBotGroup[] | undefined;

const RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1500;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function nonNegativeCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function normalizeBotInfoResponse(value: unknown): BotInfo | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const info = value as Record<string, unknown>;
  const userId = normalizeOneBotId(info['user_id']);
  return userId !== null && typeof info['nickname'] === 'string'
    ? { user_id: userId, nickname: info['nickname'] }
    : null;
}

export function normalizeGroupListResponse(value: unknown): OneBotGroup[] | null {
  if (!Array.isArray(value)) return null;
  const groups: OneBotGroup[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const group = entry as Record<string, unknown>;
    const groupId = normalizeOneBotId(group['group_id']);
    const memberCount = nonNegativeCount(group['member_count']);
    const maxMemberCount = nonNegativeCount(group['max_member_count']);
    if (
      groupId === null || typeof group['group_name'] !== 'string'
      || memberCount === null || maxMemberCount === null
    ) return null;
    groups.push({
      group_id: groupId,
      group_name: group['group_name'],
      member_count: memberCount,
      max_member_count: maxMemberCount,
    });
  }
  return groups;
}

/**
 * Fetch the bot's own QQ account info, retrying on failure.
 * Returns null only after all retries are exhausted — every failure is
 * explicitly logged so a missing identity is never a silent no-op.
 */
async function fetchBotInfo(): Promise<BotInfo | null> {
  const log = getLogger().child({ module: 'groups' });

  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    try {
      const info = normalizeBotInfoResponse(await callAction('get_login_info', {}));
      if (!info) {
        throw new Error('get_login_info returned an unexpected shape');
      }
      log.info({ user_id: info.user_id, nickname: info.nickname, attempt }, 'Bot account info fetched');
      _botInfo = info;

      // Keep core.selfId in sync with the actual logged-in account — the
      // bot's own identity should never be a value the admin has to type in.
      const cfg = configManager.get();
      if (cfg.core.selfId !== info.user_id) {
        configManager.update({ core: { selfId: info.user_id } });
      }
      return info;
    } catch (err) {
      log.error(
        { attempt, maxAttempts: RETRY_ATTEMPTS, error: String(err) },
        'Failed to fetch bot account info'
      );
      if (attempt < RETRY_ATTEMPTS) await sleep(RETRY_DELAY_MS * attempt);
    }
  }

  log.error('Bot account info fetch exhausted all retries — group list pull will be skipped this boot');
  return null;
}

/** Fetch the live group list. Caller must ensure fetchBotInfo() succeeded first. */
async function fetchGroupList(): Promise<OneBotGroup[] | null> {
  const log = getLogger().child({ module: 'groups' });
  try {
    const list = normalizeGroupListResponse(await callAction('get_group_list', {}));
    if (!list) throw new Error('get_group_list returned an unexpected shape');
    log.info({ count: list.length }, 'Group list fetched');
    _groupList = list;
    return list;
  } catch (err) {
    log.error({ error: String(err) }, 'Failed to fetch group list');
    return null;
  }
}

/**
 * Merge freshly-fetched groups into persisted config.
 * - Existing groups: ONLY group_name is refreshed; every toggle the admin
 *   already set (enabled, riskEnabled, autoKickBlacklisted, notifyOnRisk,
 *   notifyOnJoin, approval action/keywords) is left exactly as-is.
 * - New groups: created with strict-boolean defaults (defaultGroupEnabled,
 *   global risk/blacklist settings), never with string "true"/"false".
 */
function mergeGroupsIntoConfig(groups: OneBotGroup[]): void {
  const cfg = configManager.get();
  const existing = cfg.approval.groups;
  const merged: Record<string, DeepPartial<GroupApprovalConfig>> = {};

  for (const g of groups) {
    const gid = g.group_id;
    const prior = existing[gid];
    if (prior) {
      // Only the display-name cache is refreshed; every toggle is preserved untouched.
      merged[gid] = { groupName: g.group_name };
    } else {
      merged[gid] = buildNewGroupConfig(cfg, g.group_name);
    }
  }

  if (Object.keys(merged).length > 0) {
    configManager.update({ approval: { groups: merged } });
  }
}

/** Orchestrates the full sequenced bootstrap. Never throws — every failure is logged. */
export async function bootstrapGroups(): Promise<void> {
  const log = getLogger().child({ module: 'groups' });
  const bot = await fetchBotInfo();
  if (!bot) return; // prerequisite failed — do not attempt group list pull

  const groups = await fetchGroupList();
  if (!groups) return;

  mergeGroupsIntoConfig(groups);
  log.info({ groupCount: groups.length }, 'Group bootstrap complete');
}

export function getCachedBotInfo(): BotInfo | undefined {
  return _botInfo;
}

export function getCachedGroupList(): OneBotGroup[] | undefined {
  return _groupList;
}
