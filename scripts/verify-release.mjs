#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readZipEntryNames } from './lib/deterministic-zip.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RELEASE = join(ROOT, 'release');
const archivePath = join(RELEASE, 'napcat-plugin-qq-guardian.zip');
const sidecarPath = archivePath + '.sha256';
if (!existsSync(archivePath) || !existsSync(sidecarPath)) throw new Error('NapCat release archive or SHA-256 sidecar is missing');
const digest = createHash('sha256').update(readFileSync(archivePath)).digest('hex');
const expected = `${digest}  ${basename(archivePath)}\n`;
if (readFileSync(sidecarPath, 'utf8') !== expected) throw new Error('NapCat SHA-256 sidecar mismatch');
const names = new Set(readZipEntryNames(archivePath));
for (const required of ['index.mjs','package.json','plugin-icon.png','plugin.json','webui/app.js','webui/index.html','webui/release-view.js','webui/user-security.js']) {
  if (!names.has(required)) throw new Error('NapCat archive is missing ' + required);
}
if (names.has('webui/plugin-icon.png')) throw new Error('NapCat archive contains retired webui/plugin-icon.png');
console.log('✓ NapCat release archive verified');
