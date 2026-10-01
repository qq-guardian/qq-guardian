#!/usr/bin/env node
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTarGzipEntryNames, readZipEntryNames } from './lib/deterministic-zip.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const dir = resolve(ROOT, process.argv.find(a => a.startsWith('--directory='))?.slice(12) ?? 'release');
if (!existsSync(dir)) throw new Error(`Missing release directory: ${dir}`);
const files = [
  ...list(/qq-guardian-v\d+\.\d+\.\d+-win-x64\.zip$/),
  ...list(/qq-guardian-v\d+\.\d+\.\d+-linux-x64\.tar\.gz$/),
];
if (!files.length) throw new Error('No production archives found');
for (const archive of files) {
  const names = archive.endsWith('.zip') ? readZipEntryNames(archive) : readTarGzipEntryNames(archive);
  const root = names[0]?.split('/')[0];
  if (!root || names.some(n => !n.startsWith(root + '/'))) throw new Error(`Invalid archive root: ${archive}`);
  for (const required of ['launcher.bat','update.bat','install.ps1','verify.ps1','uninstall.ps1','updater/update.ps1','app/index.mjs','runtime/node/node.exe','config/.env.example','logs/.gitkeep','RELEASE-MANIFEST.json']) {
    if (archive.endsWith('.zip') && !names.includes(root + '/' + required)) throw new Error(`${archive} missing ${required}`);
  }
  for (const required of ['launcher.sh','update.sh','install.sh','verify.sh','uninstall.sh','updater/update.sh','service/qq-guardian.service','app/index.mjs','runtime/node/bin/node','config/.env.example','logs/.gitkeep','RELEASE-MANIFEST.json']) {
    if (archive.endsWith('.tar.gz') && !names.includes(root + '/' + required)) throw new Error(`${archive} missing ${required}`);
  }
  if (names.some(n => n.includes('node_modules/') || n.includes('.env') && !n.endsWith('.example'))) {
    throw new Error(`Development or secret content found in ${archive}`);
  }
  console.log(`✓ verified ${archive} (${statSync(archive).size} bytes)`);
}
function list(re) { return readdirSafe().filter(n => re.test(n)).map(n => join(dir,n)); }
function readdirSafe() { return readdirSync(dir); }
