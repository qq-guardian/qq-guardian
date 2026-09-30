#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { readTarGzipEntry, readTarGzipEntryNames, readZipEntry, readZipEntryNames } from './lib/deterministic-zip.mjs';

const directory = resolve(arg('--directory') ?? 'release');
const manifest = JSON.parse(readFileSync(resolve('UPSTREAM-SNOWLUMA.json'), 'utf8'));

for (const platform of ['win-x64', 'linux-x64', 'linux-arm64']) {
  const asset = manifest.platforms?.[platform]?.full;
  assert.ok(asset?.file && Number.isInteger(asset.size) && /^[a-f0-9]{64}$/.test(asset.sha256),
    `bad upstream full-asset manifest: ${platform}`);
}

const archives = readdirSync(directory).filter((name) =>
  /^qq-guardian-snowluma-installer-v\d+\.\d+\.\d+-(?:win-x64|linux-x64|linux-arm64)\.(?:zip|tar\.gz)$/.test(name),
);
assert.ok(archives.length, 'No SnowLuma integration installer archives found');

for (const archiveName of archives) {
  verify(resolve(directory, archiveName));
}
console.log(`✓ verified ${archives.length} SnowLuma integration installer archive(s)`);

function verify(archivePath) {
  const name = basename(archivePath);
  const entries = name.endsWith('.zip')
    ? readZipEntryNames(archivePath)
    : readTarGzipEntryNames(archivePath);
  const roots = new Set(entries.map((entry) => entry.split('/')[0]));
  assert.equal(roots.size, 1, `${name} must have one root directory`);

  const root = [...roots][0];
  const relative = entries.map((entry) => entry.slice(root.length + 1));
  const set = new Set(relative);
  const platform = name.includes('-win-x64.')
    ? 'win-x64'
    : name.includes('-linux-arm64.')
      ? 'linux-arm64'
      : name.includes('-linux-x64.')
        ? 'linux-x64'
        : null;
  assert.ok(platform, `cannot determine platform from ${name}`);

  for (const required of [
    'README.md',
    'SNOWLUMA-INTEGRATION-NOTICE.md',
    'UPSTREAM-SNOWLUMA.json',
    'official-snowluma.sha256',
    'official-snowluma.size',
    'LICENSE',
    'dist-snowluma/index.mjs',
  ]) {
    assert.ok(set.has(required), `${name} missing ${required}`);
  }

  const official = manifest.platforms[platform].full;
  const readEntry = name.endsWith('.zip') ? readZipEntry : readTarGzipEntry;
  const checksumText = readEntry(archivePath, `${root}/official-snowluma.sha256`).toString('utf8').trim();
  const sizeText = readEntry(archivePath, `${root}/official-snowluma.size`).toString('utf8').trim();
  assert.equal(checksumText, `${official.sha256}  ${official.file}`, `${name} official checksum contract mismatch`);
  assert.equal(sizeText, String(official.size), `${name} official size contract mismatch`);

  if (platform === 'win-x64') {
    assert.ok(set.has('deploy/native/snowluma-install.ps1'));
    assert.ok(set.has('deploy/native/start-snowluma-guardian.ps1'));
    assert.ok(!relative.some((entry) => entry.endsWith('.sh')));
  } else {
    assert.ok(set.has('deploy/native/snowluma-install.sh'));
    assert.ok(set.has('deploy/native/start-snowluma-guardian.sh'));
    assert.ok(set.has('deploy/native/qq-guardian-snowluma.service'));
    assert.ok(!relative.some((entry) => entry.endsWith('.ps1')));
  }

  assert.ok(!relative.some((entry) =>
    /(?:^|\/)snowluma-[^/]+\.(?:node|dll|so)$/i.test(entry),
  ), `${name} must not redistribute SnowLuma native binaries`);
}
function arg(name) {
  const hit = process.argv.find((argument) => argument.startsWith(name + '='));
  return hit?.slice(name.length + 1);
}
