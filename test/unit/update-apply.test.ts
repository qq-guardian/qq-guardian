import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeDeterministicZip } from '../../scripts/lib/deterministic-zip.mjs';
import { NAPCAT_UPDATE_FILES, parseNapCatUpdateArchive } from '../../src/modules/update/archive.ts';
import { applyNapCatUpdateArchive } from '../../src/modules/update/apply.ts';

const roots: string[] = [];
const VERSION = '2.0.0';

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'guardian-update-apply-'));
  roots.push(root);
  return root;
}

function createArchive(root: string, version = VERSION): Buffer {
  const archivePath = join(root, 'update.zip');
  const entries = NAPCAT_UPDATE_FILES.map((name) => ({
    name,
    mode: 0o644,
    data: name === 'package.json' || name === 'plugin.json'
      ? Buffer.from(JSON.stringify({ name: 'napcat-plugin-qq-guardian', version, main: 'index.mjs' }))
      : Buffer.from(`new-${name}`),
  }));
  writeDeterministicZip({ outputPath: archivePath, entries });
  return readFileSync(archivePath);
}

function createInstallTree(root: string): { pluginPath: string; backupPath: string } {
  const pluginPath = join(root, 'plugin');
  const backupPath = join(root, 'guardian-data', 'backups', 'update-backups');
  mkdirSync(join(pluginPath, 'webui'), { recursive: true });
  for (const name of NAPCAT_UPDATE_FILES) {
    const path = join(pluginPath, ...name.split('/'));
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, `old-${name}`);
  }
  writeFileSync(join(pluginPath, 'config.json'), '{"preserve":true}');
  mkdirSync(join(pluginPath, 'data'), { recursive: true });
  mkdirSync(join(pluginPath, 'logs'), { recursive: true });
  writeFileSync(join(pluginPath, 'data', 'qqadmin.db'), 'database sentinel');
  writeFileSync(join(pluginPath, 'logs', 'guardian.log'), 'log sentinel');
  return { pluginPath, backupPath };
}

describe('verified NapCat update archive installation', () => {
  it('validates every archive entry, backs up old program files, and preserves persistent files', () => {
    const root = temporaryRoot();
    const archive = createArchive(root);
    const { pluginPath, backupPath } = createInstallTree(root);
    const result = applyNapCatUpdateArchive(archive, pluginPath, backupPath, VERSION);

    assert.equal(result.files, NAPCAT_UPDATE_FILES.length);
    assert.ok(result.backupPath.startsWith(backupPath));
    for (const name of NAPCAT_UPDATE_FILES) {
      assert.equal(readFileSync(join(pluginPath, ...name.split('/')), 'utf8'), name === 'package.json' || name === 'plugin.json'
        ? JSON.stringify({ name: 'napcat-plugin-qq-guardian', version: VERSION, main: 'index.mjs' })
        : `new-${name}`);
      assert.equal(readFileSync(join(result.backupPath, ...name.split('/')), 'utf8'), `old-${name}`);
    }
    assert.equal(readFileSync(join(pluginPath, 'config.json'), 'utf8'), '{"preserve":true}');
    assert.equal(readFileSync(join(pluginPath, 'data', 'qqadmin.db'), 'utf8'), 'database sentinel');
    assert.equal(readFileSync(join(pluginPath, 'logs', 'guardian.log'), 'utf8'), 'log sentinel');
    const manifest = JSON.parse(readFileSync(join(result.backupPath, 'manifest.json'), 'utf8')) as {
      version: string;
      files: Array<{ path: string; sha256: string }>;
    };
    assert.equal(manifest.version, VERSION);
    assert.equal(manifest.files.length, NAPCAT_UPDATE_FILES.length);
    assert.ok(manifest.files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256)));
  });

  it('rejects malformed ZIP data and archives with modified entry names', () => {
    assert.throws(() => parseNapCatUpdateArchive(Buffer.from('not a zip')), /invalid|size is invalid/i);
    const root = temporaryRoot();
    const archive = createArchive(root);
    const nameBytes = Buffer.from('index.mjs');
    const localName = archive.indexOf(nameBytes);
    const centralName = archive.indexOf(nameBytes, localName + nameBytes.length);
    assert.notEqual(localName, -1);
    assert.notEqual(centralName, -1);
    archive[localName] = 0x24;
    archive[centralName] = 0x24;
    assert.throws(() => parseNapCatUpdateArchive(archive), /unsafe entry|mismatched entry names/);
  });

  it('rejects content corruption and a manifest version mismatch before touching installed files', () => {
    const root = temporaryRoot();
    const archive = createArchive(root);
    const localNameLength = archive.readUInt16LE(26);
    const localExtraLength = archive.readUInt16LE(28);
    archive[30 + localNameLength + localExtraLength] ^= 0xff;
    assert.throws(() => parseNapCatUpdateArchive(archive), /decompressed|integrity checks/);

    const cleanArchive = createArchive(root, '2.0.1');
    const { pluginPath, backupPath } = createInstallTree(root);
    assert.throws(() => applyNapCatUpdateArchive(cleanArchive, pluginPath, backupPath, VERSION), /does not match/);
    assert.equal(readFileSync(join(pluginPath, 'index.mjs'), 'utf8'), 'old-index.mjs');
  });

  it('rejects symbolic-link program targets before modifying any installed file', () => {
    const root = temporaryRoot();
    const archive = createArchive(root);
    const { pluginPath, backupPath } = createInstallTree(root);
    const target = join(pluginPath, 'webui', 'user-security.js');
    rmSync(target);
    const outside = join(root, 'outside.js');
    writeFileSync(outside, 'outside sentinel');
    symlinkSync(outside, target);

    assert.throws(() => applyNapCatUpdateArchive(archive, pluginPath, backupPath, VERSION), /symbolic link|symbolic-link/i);
    assert.equal(readFileSync(join(pluginPath, 'index.mjs'), 'utf8'), 'old-index.mjs');
    assert.equal(readFileSync(outside, 'utf8'), 'outside sentinel');
  });
});
