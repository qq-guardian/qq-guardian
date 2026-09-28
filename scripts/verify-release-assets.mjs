#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { readTarGzipEntryNames, readZipEntryNames } from './lib/deterministic-zip.mjs';

const directory = resolve(process.argv[2] ?? 'release');
const checksumPath = resolve(directory, 'SHA256SUMS');
if (!existsSync(checksumPath)) throw new Error('SHA256SUMS is missing');
const archives = readdirSync(directory)
  .filter((name) => name.endsWith('.zip') || name.endsWith('.tar.gz'))
  .sort();
const declared = new Map();
for (const line of readFileSync(checksumPath, 'utf8').trim().split('\n')) {
  const match = /^([a-f0-9]{64})  ([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(line);
  if (!match) throw new Error(`Invalid SHA256SUMS line: ${line}`);
  if (declared.has(match[2])) throw new Error(`Duplicate SHA256SUMS entry: ${match[2]}`);
  declared.set(match[2], match[1]);
}
if (declared.size !== archives.length) throw new Error('SHA256SUMS must cover every archive exactly once');
for (const name of archives) {
  const path = resolve(directory, name);
  const digest = createHash('sha256').update(readFileSync(path)).digest('hex');
  if (declared.get(name) !== digest) throw new Error(`SHA256SUMS mismatch for ${name}`);
  const sidecarPath = `${path}.sha256`;
  if (existsSync(sidecarPath)) {
    const expected = `${digest}  ${basename(path)}\n`;
    if (readFileSync(sidecarPath, 'utf8') !== expected) throw new Error(`Sidecar mismatch for ${name}`);
  }
}

for (const zipName of archives.filter((name) => name.endsWith('.zip') && name !== 'releaseDownload.zip')) {
  const stem = zipName.slice(0, -4);
  const tarName = `${stem}.tar.gz`;
  if (!archives.includes(tarName)) throw new Error(`Missing TAR.GZ peer for ${zipName}`);
  const zipEntries = readZipEntryNames(resolve(directory, zipName));
  const tarEntries = readTarGzipEntryNames(resolve(directory, tarName));
  if (JSON.stringify(zipEntries) !== JSON.stringify(tarEntries)) {
    throw new Error(`ZIP/TAR.GZ layouts differ for ${stem}`);
  }
}

const compatibility = resolve(directory, 'releaseDownload.zip');
if (existsSync(compatibility)) {
  const compatibilityDigest = createHash('sha256').update(readFileSync(compatibility)).digest('hex');
  const matchingFull = archives.some((name) => /-full-.*\.zip$/.test(name)
    && createHash('sha256').update(readFileSync(resolve(directory, name))).digest('hex') === compatibilityDigest);
  if (!matchingFull) throw new Error('releaseDownload.zip must be byte-identical to a versioned full archive');
}

console.log(`✓ ${archives.length} release assets, archive pairs, sidecars, and aggregate checksums verified`);
