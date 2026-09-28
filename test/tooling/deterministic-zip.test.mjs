import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import {
  collectArchiveEntries,
  readTarGzipEntryNames,
  readZipEntryNames,
  writeDeterministicTarGzip,
  writeDeterministicZip,
  writeSha256Sidecar,
} from '../../scripts/lib/deterministic-zip.mjs';
import { isNapCatRuntimeReleaseFile, isSnowLumaDeploymentReleaseFile, isSnowLumaRuntimeReleaseFile } from '../../scripts/lib/release-entry-policy.mjs';

const directory = mkdtempSync(join(tmpdir(), 'qq-guardian-zip-'));
after(() => rmSync(directory, { recursive: true, force: true }));

describe('deterministic ZIP packaging', () => {
  it('sorts entries, preserves prefixes, and writes a verifiable checksum', () => {
    const source = join(directory, 'source');
    mkdirSync(join(source, 'nested'), { recursive: true });
    writeFileSync(join(source, 'z.txt'), 'z');
    writeFileSync(join(source, 'nested', 'a.txt'), 'a');

    const archivePath = join(directory, 'archive.zip');
    const repeatedArchivePath = join(directory, 'archive-repeat.zip');
    const entries = collectArchiveEntries([{ directory: source, prefix: 'bundle' }]);
    writeDeterministicZip({ outputPath: archivePath, entries });
    writeDeterministicZip({ outputPath: repeatedArchivePath, entries });
    const { digest, sidecarPath } = writeSha256Sidecar(archivePath);

    assert.deepEqual(readZipEntryNames(archivePath), ['bundle/nested/a.txt', 'bundle/z.txt']);
    assert.deepEqual(readFileSync(archivePath), readFileSync(repeatedArchivePath));
    assert.equal(
      readFileSync(sidecarPath, 'utf8'),
      `${createHash('sha256').update(readFileSync(archivePath)).digest('hex')}  archive.zip\n`,
    );
    assert.match(digest, /^[a-f0-9]{64}$/);
  });

  it('writes the standard CRC-32 checksum without relying on a newer Node zlib API', () => {
    const archivePath = join(directory, 'crc32.zip');
    writeDeterministicZip({
      outputPath: archivePath,
      entries: [{ name: 'checksum.txt', data: Buffer.from('123456789') }],
    });

    const archive = readFileSync(archivePath);
    const centralDirectoryOffset = archive.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    assert.notEqual(centralDirectoryOffset, -1);
    assert.equal(archive.readUInt32LE(14), 0xcbf43926);
    assert.equal(archive.readUInt32LE(centralDirectoryOffset + 16), 0xcbf43926);
  });

  it('writes a deterministic TAR.GZ with the same ordered layout as ZIP', () => {
    const source = join(directory, 'tar-source');
    mkdirSync(join(source, 'nested'), { recursive: true });
    writeFileSync(join(source, 'z.txt'), 'z');
    writeFileSync(join(source, 'nested', 'a.txt'), 'a');
    const entries = collectArchiveEntries([{ directory: source, prefix: 'bundle' }]);
    const first = join(directory, 'archive.tar.gz');
    const repeated = join(directory, 'archive-repeat.tar.gz');
    writeDeterministicTarGzip({ outputPath: first, entries });
    writeDeterministicTarGzip({ outputPath: repeated, entries });
    assert.deepEqual(readFileSync(first), readFileSync(repeated));
    assert.deepEqual(readTarGzipEntryNames(first), ['bundle/nested/a.txt', 'bundle/z.txt']);
  });

  it('allows only reviewed deployment assets, never a local deployment secret', () => {
    const deploy = join(directory, 'deploy');
    mkdirSync(deploy, { recursive: true });
    writeFileSync(join(deploy, 'Dockerfile'), 'FROM scratch\n');
    writeFileSync(join(deploy, 'compose.yaml'), 'services: {}\n');
    writeFileSync(join(deploy, '.env.example'), 'VNC_PASSWD=example\n');
    writeFileSync(join(deploy, '.env'), 'VNC_PASSWD=real-secret\n');
    writeFileSync(join(deploy, 'notes.txt'), 'operator-only note\n');

    const entries = collectArchiveEntries([{
      directory: deploy,
      prefix: 'deploy',
      include: (absolutePath) => isSnowLumaDeploymentReleaseFile(deploy, absolutePath),
    }]);
    assert.deepEqual(entries.map((entry) => entry.name), [
      'deploy/.env.example',
      'deploy/Dockerfile',
      'deploy/compose.yaml',
    ]);
    assert.equal(entries.some((entry) => entry.data.includes('real-secret')), false);
  });

  it('packages a single root plugin icon for each runtime target', () => {
    const napcat = join(directory, 'napcat');
    const snowluma = join(directory, 'snowluma');
    for (const runtime of [napcat, snowluma]) {
      mkdirSync(join(runtime, 'webui'), { recursive: true });
      writeFileSync(join(runtime, 'index.mjs'), 'export {};\n');
      writeFileSync(join(runtime, 'package.json'), '{}\n');
      writeFileSync(join(runtime, 'plugin-icon.png'), 'root icon\n');
      writeFileSync(join(runtime, 'webui', 'app.js'), "console.log('app');\n");
      writeFileSync(join(runtime, 'webui', 'index.html'), '<!doctype html>\n');
      writeFileSync(join(runtime, 'webui', 'plugin-icon.png'), 'retired copy\n');
      writeFileSync(join(runtime, 'webui', 'release-view.js'), "console.log('release view');\n");
      writeFileSync(join(runtime, 'webui', 'user-security.js'), "console.log('user security');\n");
    }
    writeFileSync(join(napcat, 'plugin.json'), '{}\n');

    const napcatEntries = collectArchiveEntries([{
      directory: napcat,
      include: (absolutePath) => isNapCatRuntimeReleaseFile(napcat, absolutePath),
    }]);
    const snowlumaEntries = collectArchiveEntries([{
      directory: snowluma,
      include: (absolutePath) => isSnowLumaRuntimeReleaseFile(snowluma, absolutePath),
    }]);

    assert.deepEqual(napcatEntries.map((entry) => entry.name), [
      'index.mjs',
      'package.json',
      'plugin-icon.png',
      'plugin.json',
      'webui/app.js',
      'webui/index.html',
      'webui/release-view.js',
      'webui/user-security.js',
    ]);
    assert.deepEqual(snowlumaEntries.map((entry) => entry.name), [
      'index.mjs',
      'package.json',
      'plugin-icon.png',
      'webui/app.js',
      'webui/index.html',
      'webui/release-view.js',
      'webui/user-security.js',
    ]);
  });

  it('adds an explicitly named root file without scanning unrelated directories', () => {
    const metadata = join(directory, '.dockerignore');
    writeFileSync(metadata, '.env\n');
    const entries = collectArchiveEntries([{ file: metadata, name: '.dockerignore' }]);
    assert.deepEqual(entries.map((entry) => entry.name), ['.dockerignore']);
    assert.equal(entries[0].data.toString('utf8'), '.env\n');
  });
});
