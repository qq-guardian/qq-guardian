import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  PRIVATE_AI_ENDPOINTS_ENV,
  privateAIEndpointOverrideEnabled,
  privateAIEndpointStartupWarning,
} from '../../src/modules/risk/ai.ts';

describe('private AI endpoint override warning', () => {
  it('preserves the exact historical opt-in value', () => {
    assert.equal(privateAIEndpointOverrideEnabled('true'), true);
    for (const value of [undefined, '', 'false', 'TRUE', '1', ' true ', 'yes']) {
      assert.equal(privateAIEndpointOverrideEnabled(value), false, String(value));
    }
  });

  it('emits a stable warning only while the dangerous override is active', () => {
    assert.equal(privateAIEndpointStartupWarning(undefined), null);
    const warning = privateAIEndpointStartupWarning('true');
    assert.ok(warning);
    assert.match(warning, new RegExp(PRIVATE_AI_ENDPOINTS_ENV));
    assert.match(warning, /private network addresses/i);
    assert.match(warning, /HTTP/);
    assert.match(warning, /trusted local AI endpoint/i);
  });
});
