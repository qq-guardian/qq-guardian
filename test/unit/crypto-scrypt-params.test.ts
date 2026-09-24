/**
 * Additional unit tests for src/core/crypto/index.ts
 * Verifies scrypt cost parameters are embedded in hash format.
 *
 * Run with: npm run test:unit
 * Requires: Node >= 22.6.0  (--experimental-strip-types)
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

const PASSWORD = 'Compatibility!42';
const WRONG_PASSWORD = 'Compatibility!43';
const SALT = '00112233445566778899aabbccddeeff';
const DIGEST = '987abfa34777252d83b5e7c75f8d3d26ada208c9aa5b7dc7c4ded84d6a2c2d2a';
const HISTORICAL_HASHES = [
  `scrypt:v1:16384:8:1:${SALT}:${DIGEST}`,
  `scrypt:v2:16384:8:1:${SALT}:${DIGEST}`,
  `scrypt:v1:${SALT}:${DIGEST}`,
];

describe('scrypt hash format and compatibility', () => {
  let hash: typeof import('../../src/core/crypto/index.ts').hashPassword;
  let verify: typeof import('../../src/core/crypto/index.ts').verifyPassword;

  before(async () => {
    const mod = await import('../../src/core/crypto/index.ts');
    hash = mod.hashPassword;
    verify = mod.verifyPassword;
  });

  it('produces a hash with N, r, p parameters', async () => {
    const h = await hash('test-password');
    // Canonical format: scrypt:v2:<N>:<r>:<p>:<salt32hex>:<hash64hex>
    assert.match(
      h,
      /^scrypt:v2:16384:8:1:[0-9a-f]{32}:[0-9a-f]{64}$/,
      `Hash should include N=16384, r=8, p=1: ${h}`
    );
  });

  it('verifies hash with embedded parameters', async () => {
    const h = await hash('correct-password');
    assert.equal(await verify(h, 'correct-password'), true);
  });

  it('verifies every historically emitted format and rejects wrong passwords', async () => {
    for (const fixture of HISTORICAL_HASHES) {
      assert.equal(await verify(fixture, PASSWORD), true, fixture);
      assert.equal(await verify(fixture, WRONG_PASSWORD), false, fixture);
    }
  });

  it('rejects malformed versions, parameters, salts, and digests before derivation', async () => {
    const malformed = [
      `scrypt:v3:16384:8:1:${SALT}:${DIGEST}`,
      `scrypt:v2:not-a-number:8:1:${SALT}:${DIGEST}`,
      `scrypt:v2:016384:8:1:${SALT}:${DIGEST}`,
      `scrypt:v2:0:8:1:${SALT}:${DIGEST}`,
      `scrypt:v2:12000:8:1:${SALT}:${DIGEST}`,
      `scrypt:v2:16384:8:1:not-hex:${DIGEST}`,
      `scrypt:v2:16384:8:1:${SALT}:00`,
      `scrypt:v1:${SALT}:not-hex`,
    ];
    for (const fixture of malformed) assert.equal(await verify(fixture, PASSWORD), false, fixture);
  });

  it('rejects scrypt costs above the memory or CPU work bounds', async () => {
    const excessive = [
      `scrypt:v2:131072:8:1:${SALT}:${DIGEST}`,
      `scrypt:v2:65536:16:1:${SALT}:${DIGEST}`,
      `scrypt:v2:32768:8:4:${SALT}:${DIGEST}`,
      `scrypt:v2:16384:32:1:${SALT}:${DIGEST}`,
      `scrypt:v2:16384:8:8:${SALT}:${DIGEST}`,
    ];
    for (const fixture of excessive) assert.equal(await verify(fixture, PASSWORD), false, fixture);
  });

  it('handles hash with valid but non-default parameters', async () => {
    // This tests that verifyPassword can handle different N, r, p values
    // We manually construct a hash with different parameters
    const customHash = `scrypt:v1:8192:4:1:${SALT}:${DIGEST}`;
    // This should fail verification because the hash doesn't match the password,
    // but it should NOT crash due to parameter parsing
    assert.equal(await verify(customHash, 'wrong-password'), false);
  });
});
