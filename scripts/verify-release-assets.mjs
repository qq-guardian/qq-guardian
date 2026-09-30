#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const directory = resolve(process.argv[2] ?? 'release');
const archives = readdirSync(directory)
  .filter((name) => name.endsWith('.zip') || name.endsWith('.tar.gz'))
  .sort();

const version = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')).version;
const expected = [
  'napcat-plugin-qq-guardian-v' + version + '.zip',
  'napcat-plugin-qq-guardian-v' + version + '.tar.gz',
  'qq-guardian-snowluma-v' + version + '-win-x64.zip',
  'qq-guardian-snowluma-v' + version + '-win-x64-lite.zip',
  'qq-guardian-snowluma-v' + version + '-linux-x64.tar.gz',
  'qq-guardian-snowluma-v' + version + '-linux-x64-lite.tar.gz',
  'qq-guardian-snowluma-v' + version + '-linux-arm64.tar.gz',
  'qq-guardian-snowluma-v' + version + '-linux-arm64-lite.tar.gz',
];

if (JSON.stringify(archives) !== JSON.stringify([...expected].sort())) {
  throw new Error(
    'Release archive set mismatch.\nExpected:\n' + expected.sort().join('\n') +
    '\nActual:\n' + archives.join('\n'),
  );
}

const checksumPath = resolve(directory, 'SHA256SUMS');
if (!existsSync(checksumPath)) throw new Error('SHA256SUMS is missing');

const declared = new Map();
for (const line of readFileSync(checksumPath, 'utf8').trim().split('\n')) {
  const match = /^([a-f0-9]{64})  ([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(line);
  if (!match) throw new Error('Invalid SHA256SUMS line: ' + line);
  if (declared.has(match[2])) throw new Error('Duplicate SHA256SUMS entry: ' + match[2]);
  declared.set(match[2], match[1]);
}
if (declared.size !== archives.length) throw new Error('SHA256SUMS must cover exactly the eight release archives');

for (const name of archives) {
  const path = resolve(directory, name);
  const digest = createHash('sha256').update(readFileSync(path)).digest('hex');
  if (declared.get(name) !== digest) throw new Error('SHA256SUMS mismatch for ' + name);
  const sidecarPath = path + '.sha256';
  if (!existsSync(sidecarPath)) throw new Error('Missing SHA-256 sidecar for ' + name);
  const expectedSidecar = digest + '  ' + name + '\n';
  if (readFileSync(sidecarPath, 'utf8') !== expectedSidecar) throw new Error('Sidecar mismatch for ' + name);
}

for (const name of expected) {
  const windows = name.endsWith('.zip');
  if (name.includes('win-x64') && !windows) throw new Error(name + ' must use ZIP');
  if (!name.includes('win-x64') && windows && name.startsWith('qq-guardian-snowluma-')) {
    throw new Error(name + ' must use TAR.GZ on Linux');
  }
}

console.log('✓ verified exact release matrix: 8 archives, sidecars, and aggregate checksums');
