import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDefaults } from '../../src/core/config/defaults.ts';
import { configManager } from '../../src/core/config/index.ts';
import {
  migrateLegacyConfig,
  validateCanonicalConfig,
} from '../../src/core/config/schema.ts';
import {
  IntelFeedPinMismatchError,
  isIntelEnforcementActive,
  IntelService,
  parsePinnedIntelFeed,
} from '../../src/modules/intel/index.ts';

const FEED_URL = 'https://feeds.example/intel.json';
const PIN = 'a'.repeat(64);

test('fresh and migrated configurations remain observation-only', () => {
  const fresh = buildDefaults();
  assert.equal(isIntelEnforcementActive(fresh.intel), false);

  const legacy = buildDefaults() as unknown as Record<string, unknown>;
  const legacyIntel: Record<string, unknown> = {
    ...(legacy['intel'] as Record<string, unknown>),
    enabled: true,
  };
  delete legacyIntel['enforcementMode'];
  delete legacyIntel['feedPins'];
  legacy['intel'] = legacyIntel;
  const migrated = migrateLegacyConfig({ schemaVersion: 3, config: legacy });
  assert.equal(migrated.file.schemaVersion, 6);
  assert.equal(migrated.file.config.intel.enabled, true);
  assert.equal(migrated.file.config.intel.enforcementMode, 'observe');
  assert.deepEqual(migrated.file.config.intel.feedPins, {});
  assert.equal(isIntelEnforcementActive(migrated.file.config.intel), false);
});

test('enforcement requires an exact SHA-256 pin for every configured feed', () => {
  const config = buildDefaults();
  config.intel.enabled = true;
  config.intel.enforcementMode = 'enforce';
  config.intel.feedUrls = [FEED_URL];
  assert.throws(() => validateCanonicalConfig(config), /must pin/);

  config.intel.feedPins = { [FEED_URL]: PIN.toUpperCase() };
  const validated = validateCanonicalConfig(config);
  assert.equal(validated.intel.feedPins[FEED_URL], PIN);
  assert.equal(isIntelEnforcementActive(validated.intel), true);

  config.intel.feedPins = { 'https://feeds.example/other.json': PIN };
  assert.throws(() => validateCanonicalConfig(config), /must identify a configured feed URL/);
});

test('feed parsing fails closed on a pin mismatch and records verified provenance', () => {
  const bytes = Buffer.from(JSON.stringify({
    red_flag_users: [{ id: 42, action: 'kick', reason: 'fixture' }],
    risk_keywords: [{ name: 'fixture', pattern: 'danger', action: 'kick' }],
    reject_patterns: ['blocked'],
  }));
  const digest = createHash('sha256').update(bytes).digest('hex');

  const unpinned = parsePinnedIntelFeed(bytes);
  assert.equal(unpinned.sha256, digest);
  assert.equal(unpinned.verified, false);
  assert.equal(unpinned.feed.redFlags[0].action, 'kick');

  const pinned = parsePinnedIntelFeed(bytes, digest);
  assert.equal(pinned.verified, true);
  assert.equal(pinned.sha256, digest);
  assert.throws(
    () => parsePinnedIntelFeed(bytes, '0'.repeat(64)),
    (error) => {
      assert.ok(error instanceof IntelFeedPinMismatchError);
      assert.equal(error.expectedSha256, '0'.repeat(64));
      assert.equal(error.observedSha256, digest);
      return true;
    },
  );
});

test('observation mode withholds every action-bearing feed view', () => {
  const root = mkdtempSync(join(tmpdir(), 'guardian-intel-policy-'));
  try {
    configManager.init(root);
    configManager.update({ intel: { enabled: true } });
    const service = new IntelService();
    const state = service as unknown as {
      _redFlags: Map<string, { action: 'reject' | 'kick'; reason: string }>;
      _riskKeywords: Array<{ name: string; regex: RegExp; action: 'kick' }>;
      _rejectPatterns: RegExp[];
    };
    state._redFlags.set('42', { action: 'kick', reason: 'fixture' });
    state._riskKeywords = [{ name: 'fixture', regex: /danger/, action: 'kick' }];
    state._rejectPatterns = [/blocked/];

    assert.equal(service.getRedFlag('42')?.enforced, false);
    assert.deepEqual(service.getEnforcedRiskKeywords(), []);
    assert.equal(service.getObservedRiskKeywords().length, 1);
    assert.deepEqual(service.getEnforcedRejectPatterns(), []);
    assert.equal(service.getObservedRejectPatterns().length, 1);

    configManager.update({
      intel: {
        enforcementMode: 'enforce',
        feedUrls: [FEED_URL],
        feedPins: { [FEED_URL]: PIN },
      },
    });
    assert.equal(service.getRedFlag('42')?.enforced, true);
    assert.equal(service.getEnforcedRiskKeywords().length, 1);
    assert.deepEqual(service.getObservedRiskKeywords(), []);
    assert.equal(service.getEnforcedRejectPatterns().length, 1);
    assert.deepEqual(service.getObservedRejectPatterns(), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
