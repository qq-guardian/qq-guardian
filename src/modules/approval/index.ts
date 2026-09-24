import { approvalRepo } from '../../database/repositories/approval.ts';
import { blacklistRepo } from '../../database/repositories/blacklist.ts';
import { punishmentRepo } from '../../database/repositories/punishment.ts';
import { getDatabase } from '../../database/index.ts';
import { configManager } from '../../core/config/index.ts';
import { resolveGroupConfig } from '../../core/config/group.ts';
import { callOneBot as callAction } from '../../runtime/host.ts';
import { bus } from '../../core/events/index.ts';
import { withLock, locks } from '../../core/locks.ts';
import { statisticsRepo } from '../../database/repositories/statistics.ts';
import { intelService } from '../intel/index.ts';
import { getLogger } from '../../core/logger/index.ts';
import type { OB11RequestEvent } from '../../types/napcat.ts';
import type { DbApprovalRecord } from '../../database/models/index.ts';
import type { OneBotId } from '../../types/onebot.ts';

/** Built-in reject screening for join-request comments: obvious ad/spam/
 *  fraud phrasing is turned away immediately (no admin delay), on top of
 *  each group's own reject keywords. Toggled by
 *  approval.useBuiltinRejectKeywords (default on). */
const BUILTIN_REJECT_PATTERNS: RegExp[] = [
  /(?:广告|推广|引流|加粉|涨粉|代理|招商)/,
  /(?:兼职|刷单|日结|返利|点赞赚钱|躺赚)/,
  /(?:低价|代充|代刷|外挂|辅助|科技)/,
  /加(?:我|微信|VX|V信|QQ|群)[：:，, ]*[\w@]*/i,
  /(?:约炮|裸聊|色情|博彩|赌博|下注)/,
];

/** Built-in approve screening is a high-risk, default-off convenience mode:
 *  every phrase is controlled by the applicant and proves no trusted
 *  relationship. It is consulted only for manual-review groups and only
 *  after every rejection source. */
export const BUILTIN_APPROVE_PATTERNS: RegExp[] = [
  /(?:朋友|好友|同学|同事|群友|大佬)(?:推荐|介绍|邀请|拉我|让我)/,
  /(?:管理员?|群主)(?:同意|邀请|让我|叫我)/,
  /(?:B站|哔哩|贴吧|论坛|官网|视频|直播|公告)(?:看到|过来|找到|了解|推荐)/i,
];

export type AutomaticApprovalReason =
  | 'custom_keyword_matched'
  | 'custom_pattern_matched'
  | 'builtin_referral_heuristic'
  | 'policy_auto_approve';

/** Return auditable provenance for an explicit allow-rule match. Built-in
 *  phrases are deliberately distinct from operator-authored per-group rules. */
export function matchApproveComment(
  comment: string,
  cfg: { approveKeywords: string[]; approvePatterns: string[]; action: string },
  useBuiltinApproveKeywords: boolean,
): Exclude<AutomaticApprovalReason, 'policy_auto_approve'> | null {
  for (const keyword of cfg.approveKeywords) {
    if (comment.includes(keyword)) return 'custom_keyword_matched';
  }
  for (const pattern of cfg.approvePatterns) {
    try {
      if (new RegExp(pattern).test(comment)) return 'custom_pattern_matched';
    } catch {
      // Canonical config rejects invalid patterns. Ignore a corrupted runtime
      // value defensively rather than converting it into an admission rule.
    }
  }
  if (cfg.action === 'manual' && useBuiltinApproveKeywords) {
    for (const pattern of BUILTIN_APPROVE_PATTERNS) {
      if (pattern.test(comment)) return 'builtin_referral_heuristic';
    }
  }
  return null;
}

export class ApprovalService {
  async handleJoinRequest(event: OB11RequestEvent): Promise<void> {
    if (event.request_type !== 'group' || event.sub_type !== 'add') return;
    const { group_id, user_id, flag, comment } = event as Required<OB11RequestEvent>;
    const cfg = configManager.get();
    const groupCfg = resolveGroupConfig(cfg, group_id);

    // Master per-group toggle — plugin does nothing for this group when disabled
    if (!groupCfg.enabled) return;

    // Cloud red-flag screening with FRESH data: ensureFresh() re-fetches the
    // feed whenever the cached copy is older than the configured interval, so
    // the decision uses the latest network-reported list, not a stale copy.
    // Runs BEFORE the per-flag lock — the (shared, coalesced) network wait
    // must not extend the critical section below.
    await intelService.ensureFresh();

    // The live OB11 event and the admission-sync sweep can race on the same
    // request. The per-flag lock plus the record check make routing
    // idempotent: exactly one caller decides, the other sees the record and
    // stops. Every decided branch below persists a record for the flag, so a
    // request is never routed (nor counted) twice — even when the OneBot
    // reject call itself fails.
    await withLock(locks.approval(flag), async () => {
      if (approvalRepo.findByFlag(flag)) return;
      const ttl = cfg.approval.pendingTtlSeconds;

      // Each request is counted exactly once, in whichever branch decides it.
      statisticsRepo.bump(group_id, 'approvals_total');

      if (blacklistRepo.isBlacklisted(user_id, group_id)) {
        await this._rejectRecorded(group_id, user_id, flag, comment ?? '', 'You are on the group blacklist.', ttl);
        return;
      }

      // Anti-evasion at the DOOR, not just after entry: leaving a group wipes
      // QQ's own penalty state, so a kicked user could simply re-apply. An
      // unrevoked kick record in our own persistent store means the penalty is
      // still active — reject the application outright instead of admitting
      // and re-kicking (the ordered admission pipeline remains the second
      // layer for invite-based joins that bypass the request flow).
      const hasActiveKick = punishmentRepo
        .findByUser(user_id, group_id)
        .some((r) => r.type === 'kick' && r.revoked_at === null);
      if (hasActiveKick) {
        getLogger().child({ module: 'approval' }).warn({ group_id, user_id }, 'Rejecting join request: unrevoked kick penalty on record');
        await this._rejectRecorded(group_id, user_id, flag, comment ?? '', '您此前被移出本群且处罚未撤销 / A prior removal penalty is still active.', ttl);
        return;
      }

      const redFlag = intelService.getRedFlag(user_id);
      if (redFlag) {
        const log = getLogger().child({ module: 'approval' });
        if (redFlag.enforced) {
          log.warn({ group_id, user_id, reason: redFlag.reason }, 'Rejecting join request: pinned cloud red-flag list');
          await this._rejectRecorded(group_id, user_id, flag, comment ?? '', '云端风控名单命中 / Flagged by the live risk list.', ttl);
          return;
        }
        log.warn(
          { group_id, user_id, reason: redFlag.reason, enforcement: 'observe' },
          'Cloud red-flag observed; no approval action permitted'
        );
      }

      const rejectReason = this._matchReject(comment ?? '', groupCfg);
      if (rejectReason) {
        await this._rejectRecorded(group_id, user_id, flag, comment ?? '', rejectReason, ttl);
        return;
      }

      const approveReason = matchApproveComment(
        comment ?? '',
        groupCfg,
        cfg.approval.useBuiltinApproveKeywords,
      );
      if (approveReason) {
        await this._approveRecorded(group_id, user_id, flag, comment ?? '', ttl, approveReason);
        return;
      }

      switch (groupCfg.action) {
        case 'auto_approve':
          await this._approveRecorded(group_id, user_id, flag, comment ?? '', ttl, 'policy_auto_approve'); break;
        case 'auto_reject':
          await this._rejectRecorded(group_id, user_id, flag, comment ?? '', groupCfg.rejectReason, ttl); break;
        case 'captcha':
          await this._routeToCaptcha(group_id, user_id, flag, comment ?? '', ttl); break;
        default:
          approvalRepo.create({ groupId: group_id, userId: user_id, flag, comment: comment ?? '', status: 'pending', ttlSeconds: ttl });
          getLogger().child({ module: 'approval' }).info({ group_id, user_id }, 'Queued for manual review');
      }
    });
  }

  async approveManually(id: number, operatorId: string): Promise<void> {
    const initial = approvalRepo.findById(id);
    if (!initial) throw new Error('Invalid approval record');
    await withLock(locks.approval(initial.flag), async () => {
      const rec = approvalRepo.findById(id);
      if (!rec || rec.status !== 'pending') throw new Error('Invalid approval record');
      try {
        await this._approve(rec.flag, operatorId, 'manual_operator');
      } catch (error) {
        this._markActionFailure(rec.id, 'manual_approval_failed');
        throw error;
      }
      approvalRepo.updateStatus(rec.id, 'approved', operatorId, null);
      statisticsRepo.bump(rec.group_id, 'approvals_passed');
    });
  }

  async rejectManually(id: number, operatorId: string, reason: string): Promise<void> {
    const initial = approvalRepo.findById(id);
    if (!initial) throw new Error('Invalid approval record');
    await withLock(locks.approval(initial.flag), async () => {
      const rec = approvalRepo.findById(id);
      if (!rec || rec.status !== 'pending') throw new Error('Invalid approval record');
      try {
        await this._reject(rec.flag, reason, operatorId);
      } catch (error) {
        this._markActionFailure(rec.id, 'manual_rejection_failed');
        throw error;
      }
      approvalRepo.updateStatus(rec.id, 'rejected', operatorId, reason);
      statisticsRepo.bump(rec.group_id, 'approvals_rejected');
    });
  }

  async approveAfterCaptcha(candidate: DbApprovalRecord): Promise<boolean> {
    return withLock(locks.approval(candidate.flag), async () => {
      const rec = approvalRepo.findById(candidate.id);
      if (!rec || rec.status !== 'captcha') return false;
      try {
        await this._approve(rec.flag, null, 'captcha_passed');
      } catch (error) {
        this._markActionFailure(rec.id, 'captcha_approval_failed');
        throw error;
      }
      approvalRepo.updateStatus(rec.id, 'approved', null, 'captcha_passed');
      statisticsRepo.bump(rec.group_id, 'approvals_passed');
      return true;
    });
  }

  async rejectAfterCaptchaFail(candidate: DbApprovalRecord, reason: string): Promise<boolean> {
    return withLock(locks.approval(candidate.flag), async () => {
      const rec = approvalRepo.findById(candidate.id);
      if (!rec || rec.status !== 'captcha') return false;
      try {
        await this._reject(rec.flag, reason, null);
      } catch (error) {
        this._markActionFailure(rec.id, 'captcha_rejection_failed');
        throw error;
      }
      approvalRepo.updateStatus(rec.id, 'rejected', null, reason);
      statisticsRepo.bump(rec.group_id, 'approvals_rejected');
      return true;
    });
  }

  private async _approve(flag: string, operatorId: string | null, decisionReason: string): Promise<void> {
    await callAction('set_group_add_request', { flag, sub_type: 'add', approve: true });
    bus.emit('AuditCreated', {
      action: 'approval.approve',
      actorId: operatorId,
      targetType: 'approval',
      targetId: flag,
      details: { operatorId, decisionReason },
      timestamp: Date.now(),
    });
  }

  private async _reject(flag: string, reason: string, operatorId: string | null): Promise<void> {
    await callAction('set_group_add_request', { flag, sub_type: 'add', approve: false, reason });
    bus.emit('AuditCreated', { action: 'approval.reject', actorId: operatorId, targetType: 'approval', targetId: flag, details: { reason }, timestamp: Date.now() });
  }

  /** Record FIRST, OneBot call second: the persisted record is what makes
   *  routing idempotent (the admission-sync sweep and the live event both
   *  dedupe on it), so a failed approve call must not leave the request
   *  eligible for automatic re-routing — the request then simply stays in
   *  QQ's system messages for a human admin. */
  private async _approveRecorded(groupId: OneBotId, userId: OneBotId, flag: string, comment: string, ttl: number, reason: AutomaticApprovalReason): Promise<void> {
    const r = approvalRepo.create({ groupId, userId, flag, comment, status: 'pending', ttlSeconds: ttl });
    try {
      await this._approve(flag, null, reason);
    } catch (error) {
      this._markActionFailure(r.id, 'automatic_approval_failed');
      throw error;
    }
    approvalRepo.updateStatus(r.id, 'approved', null, reason);
    statisticsRepo.bump(groupId, 'approvals_passed');
  }

  /** Reject twin of _approveRecorded — same record-first idempotency contract. */
  private async _rejectRecorded(groupId: OneBotId, userId: OneBotId, flag: string, comment: string, reason: string, ttl: number): Promise<void> {
    const r = approvalRepo.create({ groupId, userId, flag, comment, status: 'pending', ttlSeconds: ttl });
    try {
      await this._reject(flag, reason, null);
    } catch (error) {
      this._markActionFailure(r.id, 'automatic_rejection_failed');
      throw error;
    }
    approvalRepo.updateStatus(r.id, 'rejected', null, reason);
    statisticsRepo.bump(groupId, 'approvals_rejected');
  }

  private async _routeToCaptcha(groupId: OneBotId, userId: OneBotId, flag: string, comment: string, ttl: number): Promise<void> {
    const r = approvalRepo.create({ groupId, userId, flag, comment, status: 'captcha', ttlSeconds: ttl });
    bus.emit('CaptchaRequired', { approvalId: r.id, groupId, userId, timestamp: Date.now() });
    getLogger().child({ module: 'approval' }).info({ group_id: groupId, user_id: userId, approval_id: r.id }, 'Routed to captcha');
  }

  /**
   * Remote failures leave a request in the operator-actionable pending queue.
   * Store a fixed failure code, never an arbitrary transport error that may
   * contain endpoint details or credentials.
   */
  private _markActionFailure(id: number, code: string): void {
    getDatabase()
      .prepare(
        `UPDATE approval_records
         SET status = 'pending', reason = ?, operator_id = NULL, processed_at = NULL
         WHERE id = ? AND status IN ('pending', 'captcha')`
      )
      .run(code, id);
  }

  private _matchReject(comment: string, cfg: { rejectKeywords: string[]; rejectPatterns: string[]; rejectReason: string }): string | null {
    for (const kw of cfg.rejectKeywords) if (comment.includes(kw)) return cfg.rejectReason;
    for (const p of cfg.rejectPatterns) { try { if (new RegExp(p).test(comment)) return cfg.rejectReason; } catch { /**/ } }
    if (configManager.get().approval.useBuiltinRejectKeywords) {
      for (const re of BUILTIN_REJECT_PATTERNS) if (re.test(comment)) return cfg.rejectReason;
    }
    // Only pinned, explicitly enabled feed patterns may reject. Observation
    // matches are logged without changing the approval decision.
    for (const re of intelService.getEnforcedRejectPatterns()) if (re.test(comment)) return cfg.rejectReason;
    if (intelService.getObservedRejectPatterns().some((re) => re.test(comment))) {
      getLogger().child({ module: 'approval' }).warn(
        { enforcement: 'observe' },
        'Cloud join-request pattern observed; no approval action permitted'
      );
    }
    return null;
  }
}

export const approvalService = new ApprovalService();
