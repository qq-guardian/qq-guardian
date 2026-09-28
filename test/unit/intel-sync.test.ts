/**
 * Unit tests for the pure helpers behind real-time enforcement:
 *  - cloud intel feed parsing (parseFeed / compileFeedPattern)
 *  - admission-sync payload normalization (extractPendingJoinRequests)
 *  - built-in approve/reject screening patterns
 *
 * Run with:  npm run test:unit
 * These exercise pure functions only — no NapCat runtime, config, or DB calls.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseFeed,
  compileFeedPattern,
  reconcileIntelSourceFeeds,
} from '../../src/modules/intel/index.ts';
import { normalizeIntelFeedUrls } from '../../src/core/config/intel.ts';
import { extractPendingJoinRequests } from '../../src/modules/approval/sync.ts';
import { BUILTIN_APPROVE_PATTERNS } from '../../src/modules/approval/index.ts';
import { probePatternInWorker, hasAmbiguousQuantifiedAlternation, hasNestedQuantifier } from '../../src/core/regex/index.ts';

// ── intel feed parsing ───────────────────────────────────────────────────────

describe('compileFeedPattern', () => {
  it('compiles a plain pattern', () => {
    const re = compileFeedPattern('foo\\d+');
    assert.ok(re instanceof RegExp);
    assert.ok(re!.test('foo123'));
  });
  it('rejects non-strings, empties, oversized and invalid patterns', () => {
    assert.equal(compileFeedPattern(42), null);
    assert.equal(compileFeedPattern(''), null);
    assert.equal(compileFeedPattern('a'.repeat(513)), null);
    assert.equal(compileFeedPattern('('), null);
  });
  it('rejects catastrophic nested quantifiers', () => {
    assert.equal(compileFeedPattern('(a+)+b'), null);
    assert.equal(compileFeedPattern('(.*)*x'), null);
    assert.equal(compileFeedPattern('a{100}(a|aa)+$'), null);
  });
});

describe('parseFeed', () => {
  it('parses snake_case documents', () => {
    const feed = parseFeed({
      red_flag_users: [10001, { id: 10002, action: 'kick', reason: 'reported' }],
      risk_keywords: [{ name: 'scam', pattern: '刷单', action: 'kick' }],
      reject_patterns: ['卖号'],
    });
    assert.deepEqual(feed.redFlags, [
      { userId: '10001', action: 'reject', reason: 'cloud red-flag list' },
      { userId: '10002', action: 'kick', reason: 'reported' },
    ]);
    assert.equal(feed.riskKeywords.length, 1);
    assert.equal(feed.riskKeywords[0].action, 'kick');
    assert.ok(feed.riskKeywords[0].regex.test('快来刷单'));
    assert.equal(feed.rejectPatterns.length, 1);
  });
  it('parses camelCase documents', () => {
    const feed = parseFeed({
      redFlagUsers: ['10003'],
      riskKeywords: [{ name: 'x', pattern: 'y' }],
      rejectPatterns: ['z'],
    });
    assert.equal(feed.redFlags[0].userId, '10003');
    assert.equal(feed.riskKeywords[0].action, 'mute'); // default action
    assert.equal(feed.rejectPatterns.length, 1);
  });
  it('drops malformed rows without poisoning the rest', () => {
    const feed = parseFeed({
      red_flag_users: [null, 'abc', -5, 0, 10004, { id: 'not-a-number' }],
      risk_keywords: [null, { name: 'bad', pattern: '(' }, { name: 'good', pattern: 'ok' }, { pattern: '(a+)+b' }],
      reject_patterns: [123, '(', 'fine'],
    });
    assert.deepEqual(feed.redFlags.map((r) => r.userId), ['10004']);
    assert.deepEqual(feed.riskKeywords.map((k) => k.name), ['good']);
    assert.equal(feed.rejectPatterns.length, 1);
  });
  it('normalizes unknown keyword actions to mute and unknown user actions to reject', () => {
    const feed = parseFeed({
      red_flag_users: [{ id: 1, action: 'nuke' }],
      risk_keywords: [{ name: 'k', pattern: 'p', action: 'explode' }],
    });
    assert.equal(feed.redFlags[0].action, 'reject');
    assert.equal(feed.riskKeywords[0].action, 'mute');
  });
  it('returns empty sets for non-object documents', () => {
    for (const doc of [null, undefined, 42, 'nope', []]) {
      const feed = parseFeed(doc);
      assert.deepEqual(feed, { redFlags: [], riskKeywords: [], rejectPatterns: [] });
    }
  });
});

describe('intel source cache reconciliation', () => {
  const sourceA = 'https://feeds.example/a.json';
  const sourceB = 'https://feeds.example/b.json';
  const destructiveFeed = parseFeed({
    red_flag_users: [{ id: 10001, action: 'kick', reason: 'source A' }],
    risk_keywords: [{ name: 'source-a-rule', pattern: 'match-all', action: 'kick' }],
    reject_patterns: ['reject-all'],
  });
  const observationFeed = parseFeed({
    risk_keywords: [{ name: 'source-b-rule', pattern: 'warning', action: 'log_only' }],
  });

  it('removes A immediately when configuration changes to an unavailable B', () => {
    const cache = new Map([[sourceA, destructiveFeed]]);
    const merged = reconcileIntelSourceFeeds([sourceB], cache);
    assert.equal(cache.has(sourceA), false);
    assert.deepEqual(merged.redFlags, []);
    assert.deepEqual(merged.riskKeywords, []);
    assert.deepEqual(merged.rejectPatterns, []);
  });

  it('retains last-known-good data only for still-configured failed sources', () => {
    const cache = new Map([[sourceA, destructiveFeed], [sourceB, observationFeed]]);
    const merged = reconcileIntelSourceFeeds([sourceA, sourceB], cache);
    assert.equal(cache.size, 2);
    assert.equal(merged.redFlags[0].action, 'kick');
    assert.deepEqual(merged.riskKeywords.map((entry) => entry.name), ['source-a-rule', 'source-b-rule']);
  });

  it('clears empty configurations and does not resurrect a source when re-added', () => {
    const cache = new Map([[sourceA, destructiveFeed]]);
    assert.deepEqual(reconcileIntelSourceFeeds([], cache), {
      redFlags: [], riskKeywords: [], rejectPatterns: [],
    });
    assert.equal(cache.size, 0);
    assert.deepEqual(reconcileIntelSourceFeeds([sourceA], cache).redFlags, []);
  });

  it('drops a removed source even if an older in-flight refresh finishes late', () => {
    const cache = new Map([[sourceB, observationFeed]]);
    cache.set(sourceA, destructiveFeed); // stale A request completes after A was removed
    const merged = reconcileIntelSourceFeeds([sourceB], cache);
    assert.deepEqual([...cache.keys()], [sourceB]);
    assert.deepEqual(merged.redFlags, []);
    assert.deepEqual(merged.riskKeywords.map((entry) => entry.name), ['source-b-rule']);
  });

  it('canonicalizes, de-fragments, and deduplicates equivalent source URLs', () => {
    assert.deepEqual(normalizeIntelFeedUrls([
      ' https://FEEDS.example:443/a.json#first ',
      'https://feeds.example/a.json#second',
      'not a URL',
      sourceB,
    ]), [sourceA, sourceB]);
  });
});

describe('probePatternInWorker', () => {
  it('kills catastrophic patterns the structural heuristic misses', async () => {
    assert.equal(hasNestedQuantifier('(a|a)+b'), false);           // heuristic blind spot…
    assert.equal(await probePatternInWorker('(a|a)+b'), false);    // …caught by the probe
  });
  it('kills digit-class catastrophic patterns (needs the digit corpus)', async () => {
    assert.equal(await probePatternInWorker('(\\d|\\d)+$'), false);
  });
  it('rejects an ambiguous quantified alternation even behind a long literal prefix', () => {
    assert.equal(hasNestedQuantifier('a{100}(a|aa)+$'), false);
    assert.equal(hasAmbiguousQuantifiedAlternation('a{100}(a|aa)+$'), true);
    assert.equal(compileFeedPattern('a{100}(a|aa)+$'), null);
  });
  it('allows finite alternation repeats while retaining the unbounded ambiguity guard', () => {
    const finitePattern = '(cat|caterpillar){2}';
    assert.equal(hasAmbiguousQuantifiedAlternation(finitePattern), false);
    assert.ok(compileFeedPattern(finitePattern));
    assert.equal(hasAmbiguousQuantifiedAlternation('(a|aa){2,}'), true);
    assert.equal(compileFeedPattern('(a|aa){2,}'), null);
    assert.equal(hasAmbiguousQuantifiedAlternation('(a|aa){20}$'), true);
    assert.equal(compileFeedPattern('(a|aa){20}$'), null);
  });
  it('passes ordinary patterns', async () => {
    assert.equal(await probePatternInWorker('(?:官方|客服)通知'), true);
  });
});

// ── admission-sync payload normalization ─────────────────────────────────────

describe('extractPendingJoinRequests', () => {
  it('parses the go-cqhttp shape with mixed string/number ids', () => {
    const reqs = extractPendingJoinRequests({
      invited_requests: [{ request_id: 9, group_id: 1, invitor_uin: 2, checked: false }],
      join_requests: [
        { request_id: 123, requester_uin: '456', message: '朋友推荐', group_id: '789', checked: false },
      ],
    });
    assert.deepEqual(reqs, [{ flag: '123', groupId: '789', userId: '456', comment: '朋友推荐' }]);
  });
  it('accepts the NapCat JoinRequest spelling', () => {
    const reqs = extractPendingJoinRequests({
      JoinRequest: [{ request_id: '55', requester_uin: 66, message: 'hi', group_id: 77, checked: false }],
    });
    assert.equal(reqs.length, 1);
    assert.equal(reqs[0].flag, '55');
  });
  it('reads the applicant from invitor_uin when requester_uin is absent (NapCat shape)', () => {
    const reqs = extractPendingJoinRequests({
      join_requests: [
        { request_id: 88, invitor_uin: 99, invitor_nick: 'n', message: 'hello', group_id: 100, checked: false },
      ],
    });
    assert.deepEqual(reqs, [{ flag: '88', groupId: '100', userId: '99', comment: 'hello' }]);
  });
  it('skips checked requests and entries without usable ids', () => {
    const reqs = extractPendingJoinRequests({
      join_requests: [
        { request_id: 1, requester_uin: 2, group_id: 3, checked: true },     // already handled
        { request_id: 4, requester_uin: 'abc', group_id: 3, checked: false }, // bad user id
        { request_id: 5, requester_uin: 2, checked: false },                  // no group id
        { requester_uin: 2, group_id: 3, checked: false },                    // no flag
        null,
      ],
    });
    assert.deepEqual(reqs, []);
  });
  it('defaults a missing comment to an empty string', () => {
    const reqs = extractPendingJoinRequests({
      join_requests: [{ request_id: 1, requester_uin: 2, group_id: 3, checked: false }],
    });
    assert.equal(reqs[0].comment, '');
  });
  it('returns [] for non-object payloads', () => {
    for (const p of [null, undefined, 'x', 42, []]) {
      assert.deepEqual(extractPendingJoinRequests(p), []);
    }
  });
});

// ── built-in approve screening ───────────────────────────────────────────────

describe('BUILTIN_APPROVE_PATTERNS', () => {
  const matches = (comment: string) => BUILTIN_APPROVE_PATTERNS.some((re) => re.test(comment));
  it('matches genuine referral phrasing', () => {
    assert.ok(matches('朋友推荐来的'));
    assert.ok(matches('群友邀请我加群'));
    assert.ok(matches('管理员让我进来的'));
    assert.ok(matches('在B站看到的这个群'));
  });
  it('does not match empty or unrelated comments', () => {
    assert.ok(!matches(''));
    assert.ok(!matches('随便看看'));
    assert.ok(!matches('11111'));
  });
});
