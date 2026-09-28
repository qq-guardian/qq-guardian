import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createNapCatRuntimeHost,
  resolveNapCatConfigDir,
} from '../../src/adapters/napcat/runtime-host.ts';
import type { NapCatPluginContext } from '../../src/types/napcat.ts';

test('normalizes the current NapCat config.json file contract to its directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'guardian-napcat-current-'));
  try {
    const configPath = join(root, 'plugins', 'napcat-plugin-qq-guardian', 'config.json');
    assert.equal(resolveNapCatConfigDir(configPath), join(root, 'plugins', 'napcat-plugin-qq-guardian'));

    mkdirSync(join(root, 'existing'), { recursive: true });
    const existingFile = join(root, 'existing', 'guardian.json');
    writeFileSync(existingFile, '{}');
    assert.equal(resolveNapCatConfigDir(existingFile), join(root, 'existing'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('preserves the legacy NapCat config-directory contract', () => {
  const root = mkdtempSync(join(tmpdir(), 'guardian-napcat-legacy-'));
  try {
    const existingDirectory = join(root, 'legacy-config');
    mkdirSync(existingDirectory);
    assert.equal(resolveNapCatConfigDir(existingDirectory), existingDirectory);

    const legacyDirectoryNamedLikeCurrentFile = join(root, 'config.json');
    mkdirSync(legacyDirectoryNamedLikeCurrentFile);
    assert.equal(resolveNapCatConfigDir(legacyDirectoryNamedLikeCurrentFile), legacyDirectoryNamedLikeCurrentFile);

    const notYetCreatedDirectory = join(root, 'future-config');
    assert.equal(resolveNapCatConfigDir(notYetCreatedDirectory), notYetCreatedDirectory);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('preserves NapCat void-action empty responses behind the neutral gateway', async () => {
  const root = mkdtempSync(join(tmpdir(), 'guardian-napcat-gateway-'));
  try {
    const logger = {
      log() {}, debug() {}, info() {}, warn() {}, error() {},
    };
    const context = {
      pluginName: 'napcat-plugin-qq-guardian',
      pluginPath: root,
      dataPath: join(root, 'data'),
      configPath: join(root, 'config.json'),
      logger,
      adapterName: 'test-adapter',
      pluginManager: { config: {} },
      router: {},
      actions: {
        async call() {
          throw new Error('No data returned for action');
        },
      },
    } as unknown as NapCatPluginContext;

    const host = createNapCatRuntimeHost(context);
    assert.equal(host.onebot.identity, 'napcat');
    assert.equal(host.onebot.supportsAction?.('set_group_ban'), true);
    assert.equal(host.onebot.supportsTransport?.('plugin-api'), true);
    assert.equal(host.onebot.connectionState?.(), 'connected');
    assert.equal(await host.onebot.call('set_group_ban', {
      group_id: '30001',
      user_id: '20001',
      duration: 60,
    }), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
