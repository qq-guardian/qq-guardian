/**
 * Real-time admission sync — polls get_group_system_msg so join requests are
 * processed with the LATEST data even when the OB11 request event was missed
 * (bot offline when the request arrived, NapCat restart, plugin reload) or is
 * sitting unhandled in QQ's system messages waiting for a phone admin.
 *
 * Every unchecked request runs through the exact same handleJoinRequest
 * pipeline as a live event — blacklist, unrevoked-penalty, cloud red-flag and
 * keyword screening all apply — so an applicant cannot "apply, wait a few
 * minutes, get waved in manually and re-enter" past the plugin's checks.
 */
import { callOneBot as callAction } from '../../runtime/host.ts';
import { configManager } from '../../core/config/index.ts';
import { resolveGroupConfig } from '../../core/config/group.ts';
import { approvalRepo } from '../../database/repositories/approval.ts';
import { approvalService } from './index.ts';
import { bus } from '../../core/events/index.ts';
import { getLogger } from '../../core/logger/index.ts';
import { normalizeOneBotId, type OneBotId } from '../../types/onebot.ts';

export interface PendingJoinRequest {
  flag: string;
  groupId: OneBotId;
  userId: OneBotId;
  comment: string;
}

/**
 * Normalizes a get_group_system_msg payload. Field spellings vary across
 * OneBot implementations (go-cqhttp `join_requests`, NapCat historically also
 * used `JoinRequest`), and ids arrive as strings or numbers — accept all of
 * them. Checked (already handled) requests and entries without usable ids
 * are skipped. Exported for unit tests.
 */
export function extractPendingJoinRequests(payload: unknown): PendingJoinRequest[] {
  if (!payload || typeof payload !== 'object') return [];
  const p = payload as Record<string, unknown>;
  const raw = [p['join_requests'], p['JoinRequest'], p['joinRequests']].find(Array.isArray) as
    | unknown[]
    | undefined;
  const out: PendingJoinRequest[] = [];
  for (const entry of raw ?? []) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (e['checked']) continue; // already decided (by an admin or by us)
    const flagSrc = e['request_id'] ?? e['flag'];
    if (flagSrc === undefined || flagSrc === null || flagSrc === '') continue;
    const groupId = normalizeOneBotId(e['group_id']);
    // go-cqhttp puts the applicant in requester_uin; NapCat reuses the
    // invited-request shape and puts the applicant in invitor_uin even for
    // join requests (confirmed against node-napcat-ts's typings) — accept all.
    const userId = normalizeOneBotId(e['requester_uin'] ?? e['user_id'] ?? e['invitor_uin']);
    if (groupId === null || userId === null) continue;
    out.push({
      flag: String(flagSrc),
      groupId,
      userId,
      comment: typeof e['message'] === 'string' ? e['message'] : typeof e['comment'] === 'string' ? e['comment'] : '',
    });
  }
  return out;
}

let _timer: NodeJS.Timeout | null = null;
let _running = false;

/**
 * One sweep: fetch the current system messages and run every unchecked,
 * not-yet-seen join request through the standard pipeline. Never throws.
 * Returns the number of requests handed to the pipeline.
 */
export async function syncPendingJoinRequests(): Promise<number> {
  if (_running) return 0; // a slow previous sweep is still going — skip
  _running = true;
  const log = getLogger().child({ module: 'approval' });
  try {
    const payload = await callAction('get_group_system_msg', {});
    const pending = extractPendingJoinRequests(payload);
    let processed = 0;
    const cfg = configManager.get();
    for (const req of pending) {
      // Unmanaged group: the plugin must not touch (or even log) requests the
      // admins handle themselves — they would otherwise be re-logged forever,
      // since nothing ever marks them checked from our side.
      if (!resolveGroupConfig(cfg, req.groupId).enabled) continue;
      // A record with this flag means the live event (or an earlier sweep)
      // already routed it — pending manual reviews stay with the admins.
      if (approvalRepo.findByFlag(req.flag)) continue;
      processed++;
      log.info({ group_id: req.groupId, user_id: req.userId, flag: req.flag }, 'Admission sync: picking up join request missed by the event stream');
      await approvalService
        .handleJoinRequest({
          time: Math.floor(Date.now() / 1000),
          self_id: cfg.core.selfId,
          post_type: 'request',
          request_type: 'group',
          sub_type: 'add',
          group_id: req.groupId,
          user_id: req.userId,
          comment: req.comment,
          flag: req.flag,
        })
        .catch((e) => log.error(e, 'Admission sync: failed to process join request'));
    }
    return processed;
  } catch (e) {
    // get_group_system_msg can fail transiently (adapter reconnecting) — the
    // next tick retries; this must never crash the interval loop.
    log.warn({ error: e instanceof Error ? e.message : String(e) }, 'Admission sync: could not fetch group system messages');
    return 0;
  } finally {
    _running = false;
  }
}

function armTimer(): void {
  if (_timer) { clearInterval(_timer); _timer = null; }
  const cfg = configManager.get().approval;
  if (!cfg.realtimeSyncEnabled) return;
  const intervalMs = Math.max(10, cfg.syncIntervalSeconds || 30) * 1000;
  _timer = setInterval(() => void syncPendingJoinRequests(), intervalMs);
}

export function initApprovalSync(): void {
  armTimer();
  // Interval changes take effect immediately, not on next boot.
  bus.on('ConfigChanged', () => armTimer());
  // Catch-up sweep right away: requests that arrived while the bot was down
  // are already sitting in QQ's system messages.
  void syncPendingJoinRequests();
}

export function stopApprovalSync(): void {
  if (_timer) { clearInterval(_timer); _timer = null; }
}
