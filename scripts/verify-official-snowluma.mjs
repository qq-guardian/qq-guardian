#!/usr/bin/env node
/**
 * Verify an operator-supplied official SnowLuma FULL release archive.
 * QQ Guardian never republishes or embeds the upstream proprietary binaries.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { readTarGzipEntryNames, readZipEntryNames } from './lib/deterministic-zip.mjs';

const root = resolve(process.cwd());
const manifest = JSON.parse(readFileSync(resolve(root, 'UPSTREAM-SNOWLUMA.json'), 'utf8'));
const archive = resolve(required('--archive'));
const platform = required('--platform');

const expected = manifest.platforms?.[platform]?.full;
assert.ok(expected, `Unknown SnowLuma full-release platform: ${platform}`);
assert.equal(basename(archive), expected.file, 'official archive filename mismatch');
assert.equal(statSync(archive).size, expected.size, 'official archive size mismatch');

const digest = createHash('sha256').update(readFileSync(archive)).digest('hex');
assert.equal(digest, expected.sha256, 'official archive SHA-256 mismatch');

const names = archive.endsWith('.zip')
  ? readZipEntryNames(archive)
  : readTarGzipEntryNames(archive);
const set = new Set(names);

for (const entry of [
  'index.mjs',
  'package.json',
  'check-node-version.cjs',
  'EULA.md',
  'PRIVACY.md',
]) {
  assert.ok(set.has(entry), `official archive missing ${entry}`);
}

if (platform === 'win-x64') {
  for (const entry of [
    'launcher.bat',
    'node.exe',
    'native/snowluma-win32-x64.dll',
    'native/snowluma-win32-x64.node',
    'native/websocket-win32-x64.node',
    'native/ffmpeg/ffmpegAddon.win32.x64.node',
  ]) assert.ok(set.has(entry), `official Windows archive missing ${entry}`);
} else if (platform === 'linux-x64' || platform === 'linux-arm64') {
  const arch = platform === 'linux-x64' ? 'x64' : 'arm64';
  for (const entry of [
    'launcher.sh',
    'node',
    `native/snowluma-linux-${arch}.node`,
    `native/snowluma-linux-${arch}.so`,
    `native/websocket-linux-${arch}.node`,
    `native/ffmpeg/ffmpegAddon.linux.${arch}.node`,
  ]) assert.ok(set.has(entry), `official Linux archive missing ${entry}`);
} else {
  throw new Error(`unsupported platform ${platform}`);
}

console.log(`✓ verified official SnowLuma ${manifest.officialRelease.tag} ${platform}: ${expected.file} (${expected.size} bytes)`);

function required(name) {
  const hit = process.argv.find((argument) => argument.startsWith(name + '='));
  if (!hit) throw new Error(`Missing ${name}=...`);
  return hit.slice(name.length + 1);
}
