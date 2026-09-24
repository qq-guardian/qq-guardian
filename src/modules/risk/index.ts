import { getDatabase } from '../../database/index.ts';
import { configManager } from '../../core/config/index.ts';
import { resolveGroupConfig } from '../../core/config/group.ts';
import { callOneBot as callAction } from '../../runtime/host.ts';
import { statisticsRepo } from '../../database/repositories/statistics.ts';
import { getLogger } from '../../core/logger/index.ts';
import type { OB11Message, OB11MessageSegment } from '../../types/napcat.ts';
import type { RiskDetectorAction } from '../../core/config/types.ts';
import type { DbRiskRule } from '../../database/models/index.ts';
import { punishmentService } from '../punishment/index.ts';
import { intelService } from '../intel/index.ts';
import { createAIProvider } from './ai.ts';
import { validateRegexPattern } from '../../core/regex/index.ts';
import { createHash } from 'crypto';
import type { OneBotId, OneBotMessageId } from '../../types/onebot.ts';

const BUILTIN: Record<string, RegExp[]> = {
  advertising:      [/加(?:我|微信|QQ|群)[：:，, ]*[\w@]+/i, /(?:推广|代理|招商|佣金|返利)/, /(?:私信|私聊)我/],
  fraud:            [/(?:兼职|日结|月薪|年薪)\s*[\d万]+/, /(?:刷单|刷流水|点赞赚钱)/, /(?:免费领取|限时领取)/],
  grayMarket:       [/(?:发票|洗钱|代开|空壳)/, /(?:非法|违禁品|走私)/],
  pornography:      [/(?:约炮|约P|开房|一夜情)/i, /(?:裸聊|色情|黄片)/i],
  political:        [/(?:推翻|颠覆|政权|敏感政治)/],
  gambling:         [/(?:赌博|博彩|百家乐|老虎机|彩票代购)/, /(?:下注|押注|赌场)/],
  shortLinks:       [/(?:t\.cn|suo\.im|dwz\.cn|bit\.ly|tinyurl)\//],
  spam:             [/(.{5,})\1{3,}/],
};

/** A detector (or custom rule) that matched, with its configured consequence. */
interface RiskHit {
  name: string;
  action: Exclude<RiskDetectorAction, 'off'>;
}

const ACTION_SEVERITY: Record<Exclude<RiskDetectorAction, 'off'>, number> = {
  log_only: 0,
  notify_admin: 1,
  mute: 2,
  kick: 3,
};

const VALID_ACTIONS = new Set<string>(['mute', 'kick', 'notify_admin', 'log_only', 'off']);

/** Coerces a stored/user-supplied action string to a valid one ('mute' fallback). */
export function normalizeRuleAction(action: unknown): RiskDetectorAction {
  return VALID_ACTIONS.has(String(action)) ? (String(action) as RiskDetectorAction) : 'mute';
}

/** The most severe action wins: kick > mute > notify_admin > log_only. */
export function pickMostSevere(actions: Array<Exclude<RiskDetectorAction, 'off'>>): Exclude<RiskDetectorAction, 'off'> {
  let winner: Exclude<RiskDetectorAction, 'off'> = 'log_only';
  for (const a of actions) {
    if (ACTION_SEVERITY[a] > ACTION_SEVERITY[winner]) winner = a;
  }
  return winner;
}

/** Returns true when any segment in the array is a rich-card type.
 *  QQ sends mini-programs, app shares, and structured content as `json`
 *  segments; some older clients emit `miniapp` instead.
 *  A card is a signal, not proof of abuse — policy is controlled by the
 *  configurable `cardMessage` detector action (default: log_only).
 *  Exported for unit testing. */
export function hasCardSegment(segments: OB11MessageSegment[]): boolean {
  return segments.some(s => s.type === 'json' || s.type === 'miniapp');
}

const AI_MEMO_TTL_MS = 600_000;
const AI_MEMO_MAX = 500;

/** How far back a flood cleanup reaches, and how many messages it recalls.
 *  QQ only allows recalling recent messages anyway, so a short window is
 *  both sufficient and safe. */
const RECALL_WINDOW_MS = 120_000;
const RECALL_MAX_MESSAGES = 30;
/** Per-(user,group) message history window used for flood detection. */
const DUP_WINDOW_MS = 10_000;

interface RecentMsg { ts: number; id: OneBotMessageId; }

export class RiskService {
  private recentMsgs = new Map<string, RecentMsg[]>();
  private _lastRecentMsgSweep = 0;
  /** Enabled custom rules with their regexes compiled ONCE at load time —
   *  recompiling per message per rule was pure waste. */
  private _rules: Array<{ rule: DbRiskRule; regex: RegExp }> = [];
  /** text-hash → AI risk score memo (bounded, insertion-order eviction). */
  private _aiMemo = new Map<string, { score: number; ts: number }>();

  async handleGroupMessage(event: OB11Message): Promise<void> {
    const cfg = configManager.get();
    const groupCfg = resolveGroupConfig(cfg, event.group_id!);
    if (!groupCfg.enabled || !groupCfg.riskEnabled) return;

    // Track every message (id + timestamp) per (user, group): the duplicate
    // detector counts them, and a risk hit batch-recalls them — a spam flood
    // is cleaned up as a whole, not one message per detection.
    this._trackMessage(event.group_id!, event.user_id, event.message_id);

    const riskCfg = cfg.risk;
    const hits = await this._detect(event.raw_message, event.group_id!, event.user_id);

    // Rich cards are legitimate QQ content as well as a common spam carrier.
    // Treat them exactly like every other detector instead of performing the
    // old unconditional recall + GLOBAL blacklist side effect. The default is
    // log_only; admins may opt into notify/mute/kick explicitly.
    const cardAction = riskCfg.detectorActions.cardMessage ?? 'log_only';
    if (hasCardSegment(event.message) && cardAction !== 'off') {
      hits.push({ name: 'cardMessage', action: cardAction });
    }

    if (hits.length === 0) return;
    const action = pickMostSevere(hits.map(h => h.action));
    const detectorNames = hits.map(h => h.name);

    const log = getLogger().child({ module: 'risk' });
    log.warn({ group_id: event.group_id, user_id: event.user_id, detectors: detectorNames, action }, 'Risk detected');
    statisticsRepo.bump(event.group_id!, 'risk_detections');

    // PUNISH FIRST, recall after: under a malicious flood the mute/kick is
    // what actually stops the spam — serializing dozens of recalls before it
    // would leave the attacker free to keep posting the whole time, and a
    // failed recall must never delay or block the punishment.
    const selfId = cfg.core.selfId;
    const reason = `Risk: ${detectorNames.join(', ')}`;
    try {
      switch (action) {
        case 'mute':   await punishmentService.mute(event.group_id!, event.user_id, riskCfg.muteDurationSeconds, reason, selfId); break;
        case 'kick':   await punishmentService.kick(event.group_id!, event.user_id, reason, selfId); break;
        case 'notify_admin':
          await this._notifyAdmins(event.group_id!, event.user_id, detectorNames, event.raw_message);
          break;
        // log_only: the warn log + statistics above are the action
      }
    } catch (e) {
      // The reverse also holds: a punishment the platform rejected (bot not
      // admin here, target is an admin, transient API error) must not abort
      // the sweep — the recall and admin notification below still run.
      log.error(e, 'Punishment action failed — continuing with recall/notify');
    }

    // Recall runs in ADDITION to the configured action, never instead of it.
    // Recalls the triggering message plus every recent message from the same
    // user in this group (concurrently, best-effort) so a burst of spam
    // images/text disappears in one sweep. Failures are non-fatal: messages
    // may be too old to recall or the bot may lack admin rights here.
    if (riskCfg.recallMessage) {
      await this._recallRecentMessages(event.group_id!, event.user_id, event.message_id);
    }

    // Per-group notification toggle — fires independently of the detector action
    if (groupCfg.notifyOnRisk && action !== 'notify_admin') {
      await this._notifyAdmins(event.group_id!, event.user_id, detectorNames, event.raw_message);
    }
  }

  private _trackMessage(groupId: OneBotId, userId: OneBotId, messageId: OneBotMessageId): void {
    const key = `${userId}:${groupId}`;
    const now = Date.now();
    const entries = (this.recentMsgs.get(key) ?? []).filter(m => now - m.ts < RECALL_WINDOW_MS);
    entries.push({ ts: now, id: messageId });
    if (entries.length > RECALL_MAX_MESSAGES) entries.splice(0, entries.length - RECALL_MAX_MESSAGES);
    this.recentMsgs.set(key, entries);
    // Sweep the whole map every 60 s so inactive users' keys don't stay
    // resident indefinitely.
    if (now - this._lastRecentMsgSweep > 60_000) {
      for (const [k, v] of this.recentMsgs) {
        if (v.every(m => now - m.ts >= RECALL_WINDOW_MS)) this.recentMsgs.delete(k);
      }
      this._lastRecentMsgSweep = now;
    }
  }

  /** Concurrent best-effort recall of the user's recent messages (including
   *  the triggering one). Never throws; logs a single summary on failures. */
  private async _recallRecentMessages(
    groupId: OneBotId,
    userId: OneBotId,
    triggerMessageId: OneBotMessageId,
  ): Promise<void> {
    const now = Date.now();
    const ids = new Set<OneBotMessageId>([triggerMessageId]);
    for (const m of this.recentMsgs.get(`${userId}:${groupId}`) ?? []) {
      if (now - m.ts < RECALL_WINDOW_MS) ids.add(m.id);
    }
    const results = await Promise.allSettled(
      [...ids].map(id => callAction('delete_msg', { message_id: id }))
    );
    const failed = results.filter(r => r.status === 'rejected').length;
    const log = getLogger().child({ module: 'risk' });
    log.info({ group_id: groupId, user_id: userId, recalled: results.length - failed, failed }, 'Recalled recent risky messages');
  }

  private async _notifyAdmins(groupId: OneBotId, userId: OneBotId, detectors: string[], rawMessage: string): Promise<void> {
    for (const id of configManager.get().core.superAdmins) {
      await callAction('send_private_msg', { user_id: String(id), message: `⚠️ Risk in group ${groupId}: user ${userId}, detectors [${detectors.join(', ')}]\n${rawMessage.slice(0, 100)}` }).catch(() => {});
    }
  }

  reloadRules(): void {
    const rows = getDatabase().prepare('SELECT * FROM risk_rules WHERE enabled = 1').all() as unknown as DbRiskRule[];
    this._rules = [];
    for (const rule of rows) {
      try { this._rules.push({ rule, regex: new RegExp(rule.pattern) }); }
      catch { getLogger().child({ module: 'risk' }).warn({ rule_id: rule.id, name: rule.name }, 'Skipping rule with invalid pattern'); }
    }
  }

  async addRule(data: { name: string; pattern: string; action: RiskDetectorAction }): Promise<DbRiskRule> {
    await validateRegexPattern(data.pattern); // throws on invalid/unsafe patterns
    const now = Date.now();
    const r = getDatabase().prepare(`INSERT INTO risk_rules (name, pattern, action, enabled, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)`).run(data.name, data.pattern, normalizeRuleAction(data.action), now, now);
    this.reloadRules();
    return getDatabase().prepare('SELECT * FROM risk_rules WHERE id = ?').get(Number(r.lastInsertRowid)) as unknown as DbRiskRule;
  }

  toggleRule(id: number, enabled: boolean): void {
    getDatabase().prepare('UPDATE risk_rules SET enabled = ?, updated_at = ? WHERE id = ?').run(enabled ? 1 : 0, Date.now(), id);
    this.reloadRules();
  }

  /** Collects every detector and custom rule that matches this message. */
  private async _detect(text: string, groupId: OneBotId, userId: OneBotId): Promise<RiskHit[]> {
    const cfg = configManager.get().risk;
    const hits: RiskHit[] = [];

    for (const [name, patterns] of Object.entries(BUILTIN)) {
      const act = cfg.detectorActions[name as keyof typeof cfg.detectorActions] ?? 'off';
      if (act === 'off') continue;
      if (patterns.some(re => re.test(text))) hits.push({ name, action: act });
    }

    const dupAction = cfg.detectorActions.duplicateMessages ?? 'off';
    if (dupAction !== 'off') {
      const now = Date.now();
      const recent = (this.recentMsgs.get(`${userId}:${groupId}`) ?? [])
        .filter(m => now - m.ts < DUP_WINDOW_MS);
      if (recent.length >= 5) hits.push({ name: 'duplicateMessages', action: dupAction });
    }

    for (const { rule, regex } of this._rules) {
      const act = normalizeRuleAction(rule.action);
      if (act === 'off') continue;
      if (regex.test(text)) hits.push({ name: `rule:${rule.name}`, action: act });
    }

    // Cloud intel keywords — live professional warning phrases with per-entry
    // severity. The cached copy is matched synchronously; the freshness nudge
    // runs in the background so message handling never blocks on the network
    // (the scheduled refresh keeps the cache current anyway).
    void intelService.ensureFresh();
    for (const kw of intelService.getEnforcedRiskKeywords()) {
      if (kw.regex.test(text)) hits.push({ name: `cloud:${kw.name}`, action: kw.action });
    }
    const observedCloudHits = intelService.getObservedRiskKeywords()
      .filter((keyword) => keyword.regex.test(text))
      .map((keyword) => keyword.name);
    if (observedCloudHits.length > 0) {
      getLogger().child({ module: 'risk' }).warn({
        group_id: groupId,
        user_id: userId,
        detectors: observedCloudHits.map((name) => `cloud:${name}`),
        enforcement: 'observe',
      }, 'Cloud risk match observed; no message action permitted');
    }

    // AI is the expensive fallback: consulted only when nothing cheap matched.
    const aiAction = cfg.detectorActions.aiViolation ?? 'off';
    if (aiAction !== 'off' && hits.length === 0) {
      const hash = createHash('md5').update(text).digest('hex');
      const memo = this._aiMemo.get(hash);
      let score: number | undefined =
        memo && Date.now() - memo.ts < AI_MEMO_TTL_MS ? memo.score : undefined;
      if (score === undefined) {
        const r = await createAIProvider().analyzeRisk(text);
        if (r.ok && r.data) {
          if (this._aiMemo.size >= AI_MEMO_MAX) {
            const oldest = this._aiMemo.keys().next().value;
            if (oldest !== undefined) this._aiMemo.delete(oldest);
          }
          this._aiMemo.set(hash, { score: r.data.score, ts: Date.now() });
          score = r.data.score;
        }
      }
      if (score !== undefined && score >= cfg.aiMinScore) hits.push({ name: 'aiViolation', action: aiAction });
    }

    return hits;
  }
}

export const riskService = new RiskService();
