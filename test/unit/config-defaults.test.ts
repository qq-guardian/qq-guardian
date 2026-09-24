import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildDefaults } from '../../src/core/config/defaults.ts';

describe('security-sensitive defaults', () => {
  it('keeps remote intel opt-in on fresh installs', () => {
    const intel = buildDefaults().intel;
    assert.equal(intel.enabled, false);
    assert.equal(intel.enforcementMode, 'observe');
    assert.deepEqual(intel.feedPins, {});
  });

  it('does not punish or blacklist rich cards by default', () => {
    assert.equal(buildDefaults().risk.detectorActions.cardMessage, 'log_only');
  });

  it('keeps attacker-controlled referral claims in manual review by default', () => {
    const defaults = buildDefaults();
    assert.equal(defaults.approval.defaultAction, 'manual');
    assert.equal(defaults.approval.useBuiltinApproveKeywords, false);
  });
});
