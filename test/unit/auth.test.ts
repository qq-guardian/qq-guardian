/**
 * Unit tests for src/core/crypto/index.ts and src/modules/update/index.ts
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

describe('hashPassword / verifyPassword', () => {
  let hash: typeof import('../../src/core/crypto/index.ts').hashPassword;
  let verify: typeof import('../../src/core/crypto/index.ts').verifyPassword;

  before(async () => {
    const mod = await import('../../src/core/crypto/index.ts');
    hash = mod.hashPassword;
    verify = mod.verifyPassword;
  });

  it('produces a canonical scrypt:v2 hash with cost parameters', async () => {
    const h = await hash('my-password');
    assert.match(h, /^scrypt:v2:16384:8:1:[0-9a-f]{32}:[0-9a-f]{64}$/);
  });

  it('verifies the correct password', async () => {
    const h = await hash('correct');
    assert.equal(await verify(h, 'correct'), true);
  });

  it('rejects a wrong password', async () => {
    const h = await hash('correct');
    assert.equal(await verify(h, 'wrong'), false);
  });

  it('rejects an empty password against a non-empty hash', async () => {
    const h = await hash('not-empty');
    assert.equal(await verify(h, ''), false);
  });

  it('rejects a malformed hash string', async () => {
    assert.equal(await verify('not-a-real-hash', 'password'), false);
  });

  it('two hashes of the same password differ (salted)', async () => {
    const h1 = await hash('same');
    const h2 = await hash('same');
    assert.notEqual(h1, h2);
  });
});

describe('isNewerVersion', () => {
  let newer: typeof import('../../src/modules/update/index.ts').isNewerVersion;
  before(async () => { newer = (await import('../../src/modules/update/index.ts')).isNewerVersion; });
  it('detects higher versions', () => { assert.equal(newer('1.0.1','1.0.0'), true); });
  it('rejects equal versions', () => { assert.equal(newer('1.0.0','1.0.0'), false); });
});

describe('validateDownloadUrl', () => {
  let validateUrl: typeof import('../../src/modules/update/index.ts').validateDownloadUrl;
  before(async () => { validateUrl = (await import('../../src/modules/update/index.ts')).validateDownloadUrl; });
  it('allows GitHub releases', () => { assert.doesNotThrow(() => validateUrl('https://github.com/owner/repo/releases/download/v1/plugin.zip')); });
  it('rejects HTTP', () => { assert.throws(() => validateUrl('http://github.com/x'), /HTTPS/); });
});
