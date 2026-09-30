#!/usr/bin/env node
/** Build the versioned NapCat provider archives used by GitHub Releases. */
import { readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  collectArchiveEntries,
  writeDeterministicTarGzip,
  writeDeterministicZip,
  writeSha256Sidecar,
} from './lib/deterministic-zip.mjs';
import { isNapCatRuntimeReleaseFile } from './lib/release-entry-policy.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const outputDirectory = resolve(ROOT, option('--output-dir') ?? 'release');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) {
  throw new Error('Provider archives require a stable SemVer version, got ' + JSON.stringify(pkg.version));
}

const directory = join(ROOT, 'dist');
const archive = 'napcat-plugin-qq-guardian-v' + pkg.version;

const entries = collectArchiveEntries([{
  directory,
  include: (path) => isNapCatRuntimeReleaseFile(directory, path),
}]);

const required = new Set(['index.mjs', 'package.json', 'plugin.json']);
const names = new Set(entries.map((entry) => entry.name));
for (const item of required) {
  if (!names.has(item)) throw new Error(archive + ' is missing required entry ' + item);
}

const zipPath = join(outputDirectory, archive + '.zip');
const tarPath = join(outputDirectory, archive + '.tar.gz');

writeDeterministicZip({ outputPath: zipPath, entries });
writeDeterministicTarGzip({ outputPath: tarPath, entries });
writeSha256Sidecar(zipPath);
writeSha256Sidecar(tarPath);

console.log('✓ ' + relative(ROOT, zipPath) + '  ' + (statSync(zipPath).size / 1024).toFixed(0) + ' KB');
console.log('✓ ' + relative(ROOT, tarPath) + '  ' + (statSync(tarPath).size / 1024).toFixed(0) + ' KB');

function option(name) {
  return process.argv.find((argument) => argument.startsWith(name + '='))?.slice(name.length + 1);
}
