/**
 * Cloud intel — live threat data fetched from remote feeds at runtime.
 *
 * Feeds are plain JSON documents (see intel/feed.json in the repo for the
 * canonical shape) carrying three data sets, all merged across every
 * configured URL:
 *   - red-flag users: network-reported bad actors. Rejected at the approval
 *     door; 'kick'-level entries are also removed when they slip in through
 *     an invite (which bypasses the join-request flow entirely).
 *   - risk keywords: professional warning phrases with per-entry actions,
 *     merged into message risk detection alongside the built-in detectors.
 *   - reject patterns: extra join-request comment screening.
 *
 * Downloaded data is observation-only unless every configured source is
 * SHA-256 pinned and a super administrator explicitly enables enforcement.
 * A scheduled refresh re-fetches every refreshIntervalSeconds, and decision
 * points call ensureFresh() so a stale cache is re-fetched on demand before
 * the decision is made. Fetch failures keep last-known-good data only for
 * sources that are still configured and still match their current pins.
 */
import { bus } from '../../core/events/index.ts';
import { createHash } from 'node:crypto';
import { configManager } from '../../core/config/index.ts';
import { resolveGroupConfig } from '../../core/config/group.ts';
import { normalizeIntelFeedUrls } from '../../core/config/intel.ts';
import { callOneBot as callAction } from '../../runtime/host.ts';
import { getLogger, type SimpleLogger } from '../../core/logger/index.ts';
import { hasAmbiguousQuantifiedAlternation, hasNestedQuantifier, probePatternInWorker, MAX_PATTERN_LENGTH } from '../../core/regex/index.ts';
import { punishmentService } from '../punishment/index.ts';
import { fetchRemote, readResponseBytes, releaseRemoteResponse } from '../../runtime/safe-fetch.ts';
import type { MemberJoinEvent, MemberJoinStageResult } from '../../types/member-join.ts';
import type { IntelConfig } from '../../core/config/types.ts';
import { normalizeOneBotId, type OneBotId } from '../../types/onebot.ts';

export type RedFlagAction = 'reject' | 'kick';
export type IntelKeywordAction = 'mute' | 'kick' | 'notify_admin' | 'log_only';

export interface IntelRedFlag {
  userId: OneBotId;
  action: RedFlagAction;
  reason: string;
}

export interface IntelRiskKeyword {
  name: string;
  regex: RegExp;
  action: IntelKeywordAction;
}

export interface ParsedFeed {
  redFlags: IntelRedFlag[];
  riskKeywords: IntelRiskKeyword[];
  rejectPatterns: RegExp[];
}

export interface IntelRedFlagMatch {
  action: RedFlagAction;
  reason: string;
  enforced: boolean;
}

export interface ParsedPinnedFeed {
  feed: ParsedFeed;
  sha256: string;
  verified: boolean;
}

export class IntelFeedPinMismatchError extends Error {
  readonly expectedSha256: string;
  readonly observedSha256: string;

  constructor(
    expectedSha256: string,
    observedSha256: string,
  ) {
    super('Intel feed SHA-256 pin mismatch');
    this.name = 'IntelFeedPinMismatchError';
    this.expectedSha256 = expectedSha256;
    this.observedSha256 = observedSha256;
  }
}

export function isIntelEnforcementActive(config: Pick<IntelConfig, 'enabled' | 'enforcementMode'>): boolean {
  return config.enabled && config.enforcementMode === 'enforce';
}

/** Parse exact response bytes and reject a configured integrity mismatch
 * before any remote rule can enter the vetted cache. */
export function parsePinnedIntelFeed(bytes: Buffer, expectedSha256?: string): ParsedPinnedFeed {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (expectedSha256 && sha256 !== expectedSha256) {
    throw new IntelFeedPinMismatchError(expectedSha256, sha256);
  }
  let document: unknown;
  try {
    document = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('Intel feed is not valid JSON');
  }
  return { feed: parseFeed(document), sha256, verified: expectedSha256 !== undefined };
}

const FETCH_TIMEOUT_MS = 8_000;
const MAX_INTEL_FEED_BYTES = 2 * 1024 * 1024;

/** Converts a raw.githubusercontent.com URL to its jsDelivr CDN mirror.
 *  Returns null for URLs that are not in the expected format.
 *  jsDelivr is a reliable CDN that proxies GitHub content and is accessible
 *  in regions where raw.githubusercontent.com is blocked or unreliable.
 *  Exported for unit tests. */
export function rawToJsdelivr(url: string): string | null {
  const m = url.match(/^https:\/\/raw\.githubusercontent\.com\/([^/]+\/[^/]+)\/([^/]+)\/(.+)$/);
  if (!m) return null;
  return `https://cdn.jsdelivr.net/gh/${m[1]}@${m[2]}/${m[3]}`;
}
const MAX_ENTRIES_PER_LIST = 5_000;
const FAIL_LOG_INTERVAL_MS = 30 * 60_000; // warn about a broken URL at most every 30 min

const VALID_KEYWORD_ACTIONS = new Set<string>(['mute', 'kick', 'notify_admin', 'log_only']);

/** Compiles an untrusted-ish feed pattern, rejecting oversized, invalid, or
 *  structurally catastrophic ones. This is only the CHEAP synchronous
 *  filter — every pattern that survives it is additionally probed in a
 *  worker thread (see _vetPattern) before it may run against message text,
 *  because shapes like (a|a)+b slip past the structural heuristic. Feeds are
 *  maintainer-controlled but travel over the network — a bad entry must
 *  degrade to "skipped", never to a frozen event loop.
 *  Exported for unit tests. */
export function compileFeedPattern(pattern: unknown): RegExp | null {
  if (typeof pattern !== 'string' || !pattern || pattern.length > MAX_PATTERN_LENGTH) return null;
  if (hasNestedQuantifier(pattern) || hasAmbiguousQuantifiedAlternation(pattern)) return null;
  try { return new RegExp(pattern); } catch { return null; }
}

/** Parses one feed document, accepting both snake_case and camelCase keys.
 *  Malformed entries are dropped individually — one bad row never poisons
 *  the rest of the feed. Exported for unit tests. */
export function parseFeed(doc: unknown): ParsedFeed {
  const out: ParsedFeed = { redFlags: [], riskKeywords: [], rejectPatterns: [] };
  if (!doc || typeof doc !== 'object') return out;
  const d = doc as Record<string, unknown>;

  const users = [d['red_flag_users'], d['redFlagUsers']].find(Array.isArray) as unknown[] | undefined;
  for (const entry of (users ?? []).slice(0, MAX_ENTRIES_PER_LIST)) {
    let rawUserId: unknown;
    let action: RedFlagAction = 'reject', reason = 'cloud red-flag list';
    if (typeof entry === 'number' || typeof entry === 'string') {
      rawUserId = entry;
    } else if (entry && typeof entry === 'object') {
      const e = entry as Record<string, unknown>;
      rawUserId = e['id'] ?? e['user_id'] ?? e['userId'];
      if (e['action'] === 'kick') action = 'kick';
      if (typeof e['reason'] === 'string' && e['reason']) reason = e['reason'];
    } else continue;
    const userId = normalizeOneBotId(rawUserId);
    if (userId === null) continue;
    out.redFlags.push({ userId, action, reason });
  }

  const keywords = [d['risk_keywords'], d['riskKeywords']].find(Array.isArray) as unknown[] | undefined;
  for (const entry of (keywords ?? []).slice(0, MAX_ENTRIES_PER_LIST)) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const regex = compileFeedPattern(e['pattern']);
    if (!regex) continue;
    const action = VALID_KEYWORD_ACTIONS.has(String(e['action']))
      ? (String(e['action']) as IntelKeywordAction) : 'mute';
    const name = typeof e['name'] === 'string' && e['name'] ? e['name'] : 'unnamed';
    out.riskKeywords.push({ name, regex, action });
  }

  const rejects = [d['reject_patterns'], d['rejectPatterns']].find(Array.isArray) as unknown[] | undefined;
  for (const entry of (rejects ?? []).slice(0, MAX_ENTRIES_PER_LIST)) {
    const regex = compileFeedPattern(entry);
    if (regex) out.rejectPatterns.push(regex);
  }

  return out;
}

interface SourceStatus {
  url: string;
  ok: boolean;
  lastError: string | null;
  lastSuccessAt: number | null;
  expectedSha256: string | null;
  activeSha256: string | null;
  lastObservedSha256: string | null;
  verified: boolean;
}

export interface IntelSourceStatus extends SourceStatus {
  active: boolean;
  stale: boolean;
  staleAgeSeconds: number | null;
}

interface IntelPolicy {
  enabled: boolean;
  enforcementMode: IntelConfig['enforcementMode'];
  urls: string[];
  pins: Record<string, string>;
  key: string;
}

function readIntelPolicy(): IntelPolicy {
  const config = configManager.get().intel;
  const urls = config.enabled ? normalizeIntelFeedUrls(config.feedUrls) : [];
  const pins = Object.fromEntries(urls.flatMap((url) => config.feedPins[url] ? [[url, config.feedPins[url]]] : []));
  return {
    enabled: config.enabled,
    enforcementMode: config.enforcementMode,
    urls,
    pins,
    key: JSON.stringify([config.enabled, config.enforcementMode, urls.map((url) => [url, pins[url] ?? null])]),
  };
}

/**
 * Remove cache entries that no longer belong to configured URLs and merge
 * only the remaining per-source data. Mutating the map is intentional: a URL
 * that is removed and later re-added must be fetched again, never resurrected
 * from an operator-revoked cache entry.
 */
export function reconcileIntelSourceFeeds(
  configuredUrls: readonly string[],
  sourceFeeds: Map<string, ParsedFeed>,
): ParsedFeed {
  const configured = new Set(configuredUrls);
  for (const url of sourceFeeds.keys()) {
    if (!configured.has(url)) sourceFeeds.delete(url);
  }

  const merged: ParsedFeed = { redFlags: [], riskKeywords: [], rejectPatterns: [] };
  for (const url of configuredUrls) {
    const feed = sourceFeeds.get(url);
    if (!feed) continue;
    merged.redFlags.push(...feed.redFlags);
    merged.riskKeywords.push(...feed.riskKeywords);
    merged.rejectPatterns.push(...feed.rejectPatterns);
  }
  return merged;
}

export class IntelService {
  private _redFlags = new Map<OneBotId, { action: RedFlagAction; reason: string }>();
  private _riskKeywords: IntelRiskKeyword[] = [];
  private _rejectPatterns: RegExp[] = [];
  private _lastFetchAt = 0;
  private _inFlight: Promise<void> | null = null;
  private _inFlightKey: string | null = null;
  private _timer: NodeJS.Timeout | null = null;
  private _sources: SourceStatus[] = [];
  /** Last verified data for each configured feed. A partial outage must not
   * erase the good data previously received from another source. */
  private _sourceFeeds = new Map<string, ParsedFeed>();
  private _sourceDigests = new Map<string, string>();
  private _lastFailLog = new Map<string, number>();
  /** pattern source → worker-probe verdict, memoized per process so each
   *  distinct pattern pays the probe cost once, not on every refresh. */
  private _probeVerdicts = new Map<string, boolean>();

  init(): void {
    this._armTimer();
    bus.on('ConfigChanged', () => this._armTimer());
  }

  /**
   * Applies cloud red-flag policy after local blacklist and anti-evasion
   * stages have completed. Kick-level flags terminate the admission flow even
   * when the OneBot removal call fails, preventing an unsafe welcome.
   */
  async handleMemberJoin(event: MemberJoinEvent): Promise<MemberJoinStageResult> {
    const config = configManager.get();
    if (!resolveGroupConfig(config, event.groupId).enabled) return 'continue';

    await this.ensureFresh();
    const flag = this.getRedFlag(event.userId);
    if (!flag) return 'continue';

    const log = getLogger().child({ module: 'intel' });
    if (!flag.enforced) {
      log.warn(
        { user_id: event.userId, group_id: event.groupId, reason: flag.reason, enforcement: 'observe' },
        'Cloud red-flag observed; no member action permitted'
      );
      return 'continue';
    }
    if (flag.action === 'kick') {
      log.warn(
        { user_id: event.userId, group_id: event.groupId, reason: flag.reason },
        'Cloud red-flag (kick level) joined — removing'
      );
      try {
        await punishmentService.kick(
          event.groupId,
          event.userId,
          `Cloud red-flag: ${flag.reason}`,
          config.core.selfId
        );
      } catch (error) {
        log.error(error, 'Cloud red-flag removal failed');
      }
      return 'stop';
    }

    // Reject-level flags can arrive through an invite, after admission has
    // already happened. Notify operators but keep the prior behavior of not
    // removing the member solely for that door-screening signal.
    log.warn(
      { user_id: event.userId, group_id: event.groupId, reason: flag.reason },
      'Cloud red-flag (reject level) joined via invite'
    );
    for (const id of config.core.superAdmins) {
      await callAction('send_private_msg', {
        user_id: String(id),
        message: `⚠️ 云端风控名单用户 ${event.userId} 通过邀请加入了群 ${event.groupId}（${flag.reason}）`,
      }).catch(() => {});
    }
    return 'continue';
  }

  stop(): void {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }

  private _armTimer(): void {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    const policy = readIntelPolicy();
    this._reconcileConfiguredSources(policy);
    if (!policy.enabled || policy.urls.length === 0) {
      this._lastFetchAt = 0;
      return;
    }
    const intervalMs = Math.max(60, configManager.get().intel.refreshIntervalSeconds || 300) * 1000;
    this._timer = setInterval(() => void this.refresh(true), intervalMs);
    void this.refresh(true); // warm changed/new sources immediately
  }

  /** Refreshes the cache when it is older than the configured interval.
   *  Concurrent callers share one in-flight fetch. Never throws. */
  async ensureFresh(): Promise<void> {
    const cfg = configManager.get().intel;
    if (!cfg.enabled) return;
    const ttlMs = Math.max(60, cfg.refreshIntervalSeconds || 300) * 1000;
    if (Date.now() - this._lastFetchAt < ttlMs) return;
    await this.refresh(false);
  }

  /** Fetches and merges every configured feed. force=false is a no-op while
   *  a fetch is already in flight (callers share it). Never throws. */
  async refresh(force: boolean): Promise<void> {
    const policy = readIntelPolicy();
    this._reconcileConfiguredSources(policy);
    if (!policy.enabled || policy.urls.length === 0) {
      this._lastFetchAt = 0;
      return;
    }
    const requestedKey = policy.key;
    if (this._inFlight) {
      const activeKey = this._inFlightKey;
      await this._inFlight;
      const latestKey = readIntelPolicy().key;
      if (activeKey === requestedKey && latestKey === requestedKey) return;
      await this.refresh(true);
      return;
    }
    if (!force && Date.now() - this._lastFetchAt < 1_000) return; // debounce
    const task = this._doRefresh(policy);
    this._inFlight = task;
    this._inFlightKey = requestedKey;
    try { await task; } finally {
      if (this._inFlight === task) {
        this._inFlight = null;
        this._inFlightKey = null;
      }
    }

    if (readIntelPolicy().key !== requestedKey) await this.refresh(true);
  }

  private async _doRefresh(policy: IntelPolicy): Promise<void> {
    const log = getLogger().child({ module: 'intel' });
    const sources: SourceStatus[] = [];

    for (const url of policy.urls) {
      // Build a candidate list: primary URL, then jsDelivr CDN mirror as
      // fallback for raw.githubusercontent.com URLs that are unreliable in
      // some regions.  The first candidate that succeeds wins.
      const candidates = [url];
      const mirror = rawToJsdelivr(url);
      if (mirror) candidates.push(mirror);

      let parsed: ParsedPinnedFeed | null = null;
      let lastError = '';
      let lastObservedSha256 = this._sources.find((source) => source.url === url)?.lastObservedSha256 ?? null;
      for (const candidate of candidates) {
        try {
          const res = await fetchRemote(candidate, {
            headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
          }, {
            timeoutMs: FETCH_TIMEOUT_MS,
          });
          if (!res.ok) {
            await releaseRemoteResponse(res);
            throw new Error(`HTTP ${res.status}`);
          }
          parsed = parsePinnedIntelFeed(
            await readResponseBytes(res, MAX_INTEL_FEED_BYTES),
            policy.pins[url],
          );
          if (candidate !== url)
            log.info({ url, mirror: candidate }, 'Intel feed fetched via CDN mirror');
          break;
        } catch (e) {
          if (e instanceof IntelFeedPinMismatchError) lastObservedSha256 = e.observedSha256;
          lastError = e instanceof Error ? e.message : String(e);
        }
      }

      if (parsed) {
        const feed = parsed.feed;
        feed.riskKeywords = await this._filterProbed(feed.riskKeywords, (keyword) => keyword.regex, log);
        feed.rejectPatterns = await this._filterProbed(feed.rejectPatterns, (pattern) => pattern, log);
        this._sourceFeeds.set(url, feed);
        this._sourceDigests.set(url, parsed.sha256);
        sources.push({
          url,
          ok: true,
          lastError: null,
          lastSuccessAt: Date.now(),
          expectedSha256: policy.pins[url] ?? null,
          activeSha256: parsed.sha256,
          lastObservedSha256: parsed.sha256,
          verified: parsed.verified,
        });
      } else {
        const prior = this._sources.find((source) => source.url === url);
        const activeSha256 = this._sourceDigests.get(url) ?? null;
        sources.push({
          url,
          ok: false,
          lastError,
          lastSuccessAt: prior?.lastSuccessAt ?? null,
          expectedSha256: policy.pins[url] ?? null,
          activeSha256,
          lastObservedSha256,
          verified: policy.pins[url] !== undefined && activeSha256 === policy.pins[url],
        });
        const last = this._lastFailLog.get(url) ?? 0;
        if (Date.now() - last > FAIL_LOG_INTERVAL_MS) {
          this._lastFailLog.set(url, Date.now());
          log.warn(
            { url, error: lastError, activeCached: this._sourceFeeds.has(url) },
            'Intel feed fetch failed'
          );
        }
      }
    }

    // Configuration may have changed while network and worker probes were in
    // flight. Re-read it immediately before activation. This guarantees an
    // old request can never restore a source the operator has removed.
    const latest = readIntelPolicy();
    this._reconcileConfiguredSources(latest);
    if (latest.key !== policy.key) {
      this._lastFetchAt = 0;
      return;
    }

    this._sources = sources;
    this._activateConfiguredFeeds(policy.urls);
    this._lastFetchAt = Date.now();
    log.info({
      redFlags: this._redFlags.size,
      riskKeywords: this._riskKeywords.length,
      rejectPatterns: this._rejectPatterns.length,
    }, 'Intel feed refreshed');
  }

  private _reconcileConfiguredSources(policy: IntelPolicy): void {
    const configured = new Set(policy.urls);
    for (const url of this._lastFailLog.keys()) {
      if (!configured.has(url)) this._lastFailLog.delete(url);
    }
    for (const url of this._sourceFeeds.keys()) {
      const digest = this._sourceDigests.get(url);
      const pin = policy.pins[url];
      const missingRequiredPin = policy.enforcementMode === 'enforce' && pin === undefined;
      if (!configured.has(url) || missingRequiredPin || (pin !== undefined && digest !== pin)) {
        this._sourceFeeds.delete(url);
        this._sourceDigests.delete(url);
      }
    }
    const priorStatuses = new Map(this._sources.map((source) => [source.url, source]));
    this._activateConfiguredFeeds(policy.urls);
    this._sources = policy.urls.map((url) => {
      const prior = priorStatuses.get(url);
      const activeSha256 = this._sourceDigests.get(url) ?? null;
      const expectedSha256 = policy.pins[url] ?? null;
      const verified = expectedSha256 !== null && activeSha256 === expectedSha256;
      const active = this._sourceFeeds.has(url);
      return {
        url,
        ok: Boolean(prior?.ok && active && (expectedSha256 === null || verified)),
        lastError: active ? (prior?.lastError ?? null) : (prior?.lastError ?? 'Not fetched yet'),
        lastSuccessAt: active ? (prior?.lastSuccessAt ?? null) : null,
        expectedSha256,
        activeSha256,
        lastObservedSha256: prior?.lastObservedSha256 ?? null,
        verified,
      };
    });
  }

  private _activateConfiguredFeeds(urls: readonly string[]): void {
    const merged = reconcileIntelSourceFeeds(urls, this._sourceFeeds);
    for (const url of this._sourceDigests.keys()) {
      if (!this._sourceFeeds.has(url)) this._sourceDigests.delete(url);
    }

    const redFlags = new Map<OneBotId, { action: RedFlagAction; reason: string }>();
    for (const rf of merged.redFlags) {
      const prior = redFlags.get(rf.userId);
      // Most severe level wins when the same user appears in several feeds.
      if (!prior || (prior.action === 'reject' && rf.action === 'kick')) {
        redFlags.set(rf.userId, { action: rf.action, reason: rf.reason });
      }
    }
    this._redFlags = redFlags;
    this._riskKeywords = merged.riskKeywords;
    this._rejectPatterns = merged.rejectPatterns;
  }

  /** Keeps only entries whose pattern passes the worker probe. Verdicts are
   *  memoized by pattern source, and probes run in bounded batches — a huge
   *  feed must not fan out thousands of worker threads at once. Nothing here
   *  blocks the event loop. */
  private async _filterProbed<T>(entries: T[], regexOf: (e: T) => RegExp, log: SimpleLogger): Promise<T[]> {
    const CONCURRENT_PROBES = 8;
    if (this._probeVerdicts.size > 20_000) this._probeVerdicts.clear(); // unbounded-growth backstop
    const verdicts: boolean[] = new Array(entries.length);
    for (let i = 0; i < entries.length; i += CONCURRENT_PROBES) {
      const batch = entries.slice(i, i + CONCURRENT_PROBES);
      const results = await Promise.all(batch.map(async (e) => {
        const source = regexOf(e).source;
        let ok = this._probeVerdicts.get(source);
        if (ok === undefined) {
          ok = await probePatternInWorker(source);
          this._probeVerdicts.set(source, ok);
          if (!ok) log.warn({ pattern: source.slice(0, 80) }, 'Dropping feed pattern that failed the ReDoS probe');
        }
        return ok;
      }));
      results.forEach((ok, j) => { verdicts[i + j] = ok; });
    }
    return entries.filter((_, i) => verdicts[i]);
  }

  getRedFlag(userId: OneBotId): IntelRedFlagMatch | null {
    const config = configManager.get().intel;
    if (!config.enabled) return null;
    const match = this._redFlags.get(userId);
    return match ? { ...match, enforced: isIntelEnforcementActive(config) } : null;
  }

  getEnforcedRiskKeywords(): IntelRiskKeyword[] {
    return isIntelEnforcementActive(configManager.get().intel) ? this._riskKeywords : [];
  }

  getObservedRiskKeywords(): IntelRiskKeyword[] {
    const config = configManager.get().intel;
    return config.enabled && !isIntelEnforcementActive(config) ? this._riskKeywords : [];
  }

  getEnforcedRejectPatterns(): RegExp[] {
    return isIntelEnforcementActive(configManager.get().intel) ? this._rejectPatterns : [];
  }

  getObservedRejectPatterns(): RegExp[] {
    const config = configManager.get().intel;
    return config.enabled && !isIntelEnforcementActive(config) ? this._rejectPatterns : [];
  }

  getStatus(): {
    enabled: boolean;
    enforcementMode: IntelConfig['enforcementMode'];
    enforcementReady: boolean;
    lastFetchAt: number | null;
    redFlagCount: number;
    riskKeywordCount: number;
    rejectPatternCount: number;
    sources: IntelSourceStatus[];
  } {
    const now = Date.now();
    const config = configManager.get().intel;
    const configuredUrls = normalizeIntelFeedUrls(config.feedUrls);
    const enforcementReady = isIntelEnforcementActive(config)
      && configuredUrls.length > 0
      && this._sources.length === configuredUrls.length
      && this._sources.every((source) => source.verified && this._sourceFeeds.has(source.url));
    return {
      enabled: config.enabled,
      enforcementMode: config.enforcementMode,
      enforcementReady,
      lastFetchAt: this._lastFetchAt || null,
      redFlagCount: this._redFlags.size,
      riskKeywordCount: this._riskKeywords.length,
      rejectPatternCount: this._rejectPatterns.length,
      sources: this._sources.map((source) => {
        const active = this._sourceFeeds.has(source.url);
        const stale = active && !source.ok;
        return {
          ...source,
          active,
          stale,
          staleAgeSeconds: stale && source.lastSuccessAt !== null
            ? Math.max(0, Math.floor((now - source.lastSuccessAt) / 1_000))
            : null,
        };
      }),
    };
  }
}

export const intelService = new IntelService();
