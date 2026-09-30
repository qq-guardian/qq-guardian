#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTarGzipEntryNames, readZipEntryNames } from './lib/deterministic-zip.mjs';

const ROOT = join(fileURLToPath(new URL('..', import.meta.url)));
const RELEASE = join(ROOT, 'release');
const requestedArchive = process.argv.find((argument) => argument.startsWith('--archive='))?.slice('--archive='.length);

const napcat = {
  filename: 'napcat-plugin-qq-guardian.zip',
  format: 'zip',
  required: [
    'index.mjs',
    'package.json',
    'plugin-icon.png',
    'plugin.json',
    'webui/app.js',
    'webui/index.html',
    'webui/release-view.js',
    'webui/user-security.js',
  ],
};

const providers = readdirSync(RELEASE, { withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => entry.name)
  .filter((name) => /^qq-guardian-snowluma-v\d+\.\d+\.\d+-(?:win-x64|linux-x64|linux-arm64)(?:-lite)?\.(?:zip|tar\.gz)$/.test(name))
  .sort();

if (requestedArchive === 'napcat') {
  verifyZip(napcat.filename, napcat.required);
} else if (requestedArchive === 'snowluma') {
  if (providers.length === 0) throw new Error('No SnowLuma provider archive found');
  for (const name of providers) verifyProvider(name);
} else if (requestedArchive) {
  verifyRequested(requestedArchive);
} else {
  verifyZip(napcat.filename, napcat.required);
  if (providers.length === 0) throw new Error('No SnowLuma provider archive found');
  for (const name of providers) verifyProvider(name);
}

console.log('✓ release archive verification passed');

function verifyRequested(name) {
  if (name === napcat.filename) {
    verifyZip(name, napcat.required);
    return;
  }
  if (providers.includes(name)) {
    verifyProvider(name);
    return;
  }
  throw new Error('Unknown release archive: ' + name);
}

function verifyProvider(name) {
  const archivePath = join(RELEASE, name);
  const sidecarPath = archivePath + '.sha256';
  if (!existsSync(archivePath) || !existsSync(sidecarPath)) {
    throw new Error('SnowLuma provider archive or SHA-256 sidecar is missing: ' + name);
  }

  const digest = createHash('sha256').update(readFileSync(archivePath)).digest('hex');
  const expectedSidecar = digest + '  ' + basename(archivePath) + '\n';
  if (readFileSync(sidecarPath, 'utf8') !== expectedSidecar) {
    throw new Error('SnowLuma provider SHA-256 sidecar does not match ' + name);
  }

  const names = new Set(name.endsWith('.tar.gz')
    ? readTarGzipEntryNames(archivePath)
    : readZipEntryNames(archivePath));

  const root = 'qq-guardian-snowluma-' + name.match(/^qq-guardian-snowluma-(v\d+\.\d+\.\d+)/)[1];
  for (const required of [
    root + '/README.md',
    root + '/UPSTREAM-SNOWLUMA.json',
    root + '/dist-snowluma/index.mjs',
    root + '/dist-snowluma/package.json',
  ]) {
    if (!names.has(required)) throw new Error(name + ' is missing ' + required);
  }
  console.log('✓ ' + name + ': ' + names.size + ' files and verified SHA-256');
}

function verifyZip(name, required) {
  const archivePath = join(RELEASE, name);
  const sidecarPath = archivePath + '.sha256';
  if (!existsSync(archivePath) || !existsSync(sidecarPath)) {
    throw new Error('NapCat archive or SHA-256 sidecar is missing: ' + name);
  }

  const digest = createHash('sha256').update(readFileSync(archivePath)).digest('hex');
  const expectedSidecar = digest + '  ' + basename(archivePath) + '\n';
  if (readFileSync(sidecarPath, 'utf8') !== expectedSidecar) {
    throw new Error('NapCat SHA-256 sidecar does not match ' + name);
  }

  const names = new Set(
    archivePath.endsWith('.zip')
      ? readZipEntryNames(archivePath)
      : readTarGzipEntryNames(archivePath),
  );
  for (const requiredEntry of required) {
    if (!names.has(requiredEntry)) throw new Error(name + ' is missing ' + requiredEntry);
  }
  console.log('✓ ' + name + ': ' + names.size + ' files and verified SHA-256');
}
