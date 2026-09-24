#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readZipEntryNames } from './lib/deterministic-zip.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RELEASE = join(ROOT, 'release');
const requestedArchive = process.argv.find((argument) => argument.startsWith('--archive='))?.slice('--archive='.length);
const archives = {
  napcat: {
    filename: 'napcat-plugin-qq-guardian.zip',
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
    forbidden: ['webui/plugin-icon.png'],
  },
  snowluma: {
    filename: 'qq-guardian-snowluma.zip',
    required: [
      'dist-snowluma/index.mjs',
      'dist-snowluma/package.json',
      'dist-snowluma/webui/app.js',
      'dist-snowluma/webui/index.html',
      'dist-snowluma/webui/release-view.js',
      'dist-snowluma/webui/user-security.js',
      '.dockerignore',
      'deploy/Dockerfile',
      'deploy/compose.yaml',
      'docs/deployment/snowluma.md',
      'docs/security/super-admin-recovery.md',
      'deploy/native/initialize-guardian-state.ps1',
      'deploy/native/start-guardian.ps1',
      'deploy/native/start-guardian.sh',
    ],
    forbidden: ['dist-snowluma/webui/plugin-icon.png'],
  },
};
const archiveEntries = requestedArchive ? [[requestedArchive, archives[requestedArchive]]] : Object.entries(archives);

if (archiveEntries.some(([, archive]) => !archive)) {
  console.error(`Unknown archive. Expected one of: ${Object.keys(archives).join(', ')}`);
  process.exit(2);
}

for (const [name, archive] of archiveEntries) verifyArchive(name, archive);
console.log('✓ release archive verification passed');

/** @param {string} name @param {{ filename: string, required: string[], forbidden: string[] }} archive */
function verifyArchive(name, archive) {
  const archivePath = join(RELEASE, archive.filename);
  const sidecarPath = `${archivePath}.sha256`;
  if (!existsSync(archivePath) || !existsSync(sidecarPath)) {
    throw new Error(`${name} release archive or SHA-256 sidecar is missing`);
  }

  const expectedSidecar = `${createHash('sha256').update(readFileSync(archivePath)).digest('hex')}  ${basename(archivePath)}\n`;
  if (readFileSync(sidecarPath, 'utf8') !== expectedSidecar) {
    throw new Error(`${name} SHA-256 sidecar does not match ${archive.filename}`);
  }

  const names = new Set(readZipEntryNames(archivePath));
  for (const required of archive.required) {
    if (!names.has(required)) throw new Error(`${name} archive is missing ${required}`);
  }
  for (const forbidden of archive.forbidden) {
    if (names.has(forbidden)) throw new Error(`${name} archive contains retired ${forbidden}`);
  }
  console.log(`✓ ${archive.filename}: ${names.size} files and verified SHA-256`);
}
