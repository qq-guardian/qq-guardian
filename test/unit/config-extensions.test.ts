import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { ConfigManager } from '../../src/core/config/index.ts';
import { buildDefaults } from '../../src/core/config/defaults.ts';
import {
  CONFIG_SCHEMA_VERSION,
  migrateLegacyConfig,
  validateCanonicalConfigFile,
  validateConfigExtensions,
} from '../../src/core/config/schema.ts';

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function legacyConfigWithExtensions(): unknown {
  const config = buildDefaults() as unknown as Record<string, unknown>;
  config.providerMetadata = {
    vendor: 'SnowLuma',
    capabilities: ['reverse-ws', 'http-events'],
  };
  config['captcha/providerOptions'] = { scope: 'top-level' };
  const captcha = config.captcha as Record<string, unknown>;
  captcha.providerOptions = { challengeLocale: 'en-US', renderMode: 'compact' };
  const approval = config.approval as { groups: Record<string, Record<string, unknown>> };
  approval.groups['123456'] = {
    enabled: true,
    action: 'manual',
    approveKeywords: [],
    rejectKeywords: [],
    approvePatterns: [],
    rejectPatterns: [],
    rejectReason: '',
    riskEnabled: true,
    autoKickBlacklisted: true,
    notifyOnRisk: false,
    notifyOnJoin: false,
    groupName: '',
    welcomeEnabled: false,
    welcomeTemplate: '',
    curfewEnabled: false,
    curfewStart: '23:00',
    curfewEnd: '07:00',
    providerPolicy: { eventMode: 'ordered' },
  };
  const risk = config.risk as Record<string, unknown>;
  (risk.detectorActions as Record<string, unknown>).providerDetector = 'log_only';
  return {
    schemaVersion: CONFIG_SCHEMA_VERSION - 1,
    config,
    deploymentMetadata: { source: 'operator-import' },
  };
}

describe('forward-compatible configuration extensions', () => {
  it('moves safe unknown fields into an inert, path-addressed envelope', () => {
    const migrated = migrateLegacyConfig(legacyConfigWithExtensions());

    assert.deepEqual(migrated.preservedFields, [
      '/config/approval/groups/123456/providerPolicy',
      '/config/captcha/providerOptions',
      '/config/captcha~1providerOptions',
      '/config/providerMetadata',
      '/config/risk/detectorActions/providerDetector',
      '/deploymentMetadata',
    ]);
    assert.deepEqual(migrated.file.extensions?.legacy['/config/providerMetadata'], {
      vendor: 'SnowLuma',
      capabilities: ['reverse-ws', 'http-events'],
    });
    assert.deepEqual(migrated.file.extensions?.legacy['/config/captcha~1providerOptions'], {
      scope: 'top-level',
    });
    assert.equal(
      (migrated.file.config.risk.detectorActions as Record<string, unknown>).providerDetector,
      undefined,
    );

    const roundTripped = validateCanonicalConfigFile(JSON.parse(JSON.stringify(migrated.file)));
    assert.deepEqual(roundTripped.extensions, migrated.file.extensions);
  });

  it('preserves the envelope across normal runtime updates without exposing it as config', () => {
    const root = mkdtempSync(join(tmpdir(), 'guardian-config-extensions-'));
    roots.push(root);
    const migrated = migrateLegacyConfig(legacyConfigWithExtensions()).file;
    writeFileSync(join(root, 'config.json'), JSON.stringify(migrated, null, 2));

    const manager = new ConfigManager();
    manager.init(root);
    assert.equal((manager.get() as unknown as Record<string, unknown>).extensions, undefined);
    manager.update({ commands: { enabled: false } });

    const persisted = validateCanonicalConfigFile(JSON.parse(readFileSync(join(root, 'config.json'), 'utf8')));
    assert.equal(persisted.config.commands.enabled, false);
    assert.deepEqual(persisted.extensions, migrated.extensions);
  });

  it('keeps operational configuration closed to unknown properties', () => {
    const config = buildDefaults() as unknown as Record<string, unknown>;
    config.providerMetadata = { vendor: 'SnowLuma' };
    assert.throws(
      () => validateCanonicalConfigFile({ schemaVersion: CONFIG_SCHEMA_VERSION, config }),
      /config: contains unsupported key "providerMetadata"/,
    );
  });

  it('rejects prototype keys, secret-like paths, and non-JSON values', () => {
    const prototypePayload = JSON.parse('{"legacy":{"/config/provider":{"safe":{"__proto__":{"polluted":true}}}}}');
    assert.throws(() => validateConfigExtensions(prototypePayload), /unsafe key "__proto__"/);
    assert.throws(
      () => validateConfigExtensions({ legacy: { '/config/provider/access_token': 'do-not-copy' } }),
      /secret-like extension paths/,
    );
    assert.throws(
      () => validateConfigExtensions({ legacy: { '/config/provider/callback': undefined } }),
      /only JSON values/,
    );
    assert.throws(
      () => validateConfigExtensions({ legacy: { '/config/provider/~2invalid': true } }),
      /invalid JSON Pointer escape/,
    );
    assert.equal(({} as { polluted?: boolean }).polluted, undefined);
  });

  it('enforces depth, entry, string, and serialized-size bounds', () => {
    let deep: unknown = 'leaf';
    for (let index = 0; index < 10; index += 1) deep = { nested: deep };
    assert.throws(
      () => validateConfigExtensions({ legacy: { '/config/provider/deep': deep } }),
      /must not exceed 8 levels/,
    );
    assert.throws(
      () => validateConfigExtensions({ legacy: { '/config/provider/label': 'x'.repeat(4097) } }),
      /strings must not exceed 4096 characters/,
    );
    const large = Object.fromEntries(
      Array.from({ length: 20 }, (_, index) => [`/config/provider/field${index}`, 'x'.repeat(4000)]),
    );
    assert.throws(() => validateConfigExtensions({ legacy: large }), /must not exceed 65536 serialized bytes/);
  });
});
