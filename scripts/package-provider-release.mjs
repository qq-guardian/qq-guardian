#!/usr/bin/env node
/** Build the deterministic public NapCat provider archive. */
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
  throw new Error('Provider archives require a stable SemVer version');
}

const directory = join(ROOT, 'dist');
const archive = `napcat-plugin-qq-guardian-v${pkg.version}`;
const entries = collectArchiveEntries([{
  directory,
  include: (path) => isNapCatRuntimeReleaseFile(directory, path),
}]);

for (const required of ['index.mjs', 'package.json', 'plugin.json']) {
  if (!entries.some((entry) => entry.name === required)) throw new Error(`Missing NapCat provider entry: ${required}`);
}

const zipPath = join(outputDirectory, archive + '.zip');
const tarPath = join(outputDirectory, archive + '.tar.gz');
writeDeterministicZip({ outputPath: zipPath, entries });
writeDeterministicTarGzip({ outputPath: tarPath, entries });
writeSha256Sidecar(zipPath);
writeSha256Sidecar(tarPath);
console.log(`✓ ${relative(ROOT, zipPath)} ${statSync(zipPath).size} bytes`);
console.log(`✓ ${relative(ROOT, tarPath)} ${statSync(tarPath).size} bytes`);

function option(name) {
  return process.argv.find((argument) => argument.startsWith(`${name}=`))?.slice(name.length + 1);
}
