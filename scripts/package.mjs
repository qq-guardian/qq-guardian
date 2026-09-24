#!/usr/bin/env node
/** Package the built NapCat target into a deterministic drop-in ZIP archive. */
import { existsSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectArchiveEntries, writeDeterministicZip, writeSha256Sidecar } from './lib/deterministic-zip.mjs';
import { isNapCatRuntimeReleaseFile } from './lib/release-entry-policy.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const OUTPUT = join(ROOT, 'release', 'napcat-plugin-qq-guardian.zip');

if (!existsSync(join(DIST, 'index.mjs'))) {
  console.error('✗ dist/index.mjs not found — run `pnpm run build` first');
  process.exit(1);
}

const entries = collectArchiveEntries([{
  directory: DIST,
  include: (absolutePath) => isNapCatRuntimeReleaseFile(DIST, absolutePath),
}]);
writeDeterministicZip({ outputPath: OUTPUT, entries });
const { digest, sidecarPath } = writeSha256Sidecar(OUTPUT);

console.log(`✓ ${relative(ROOT, OUTPUT)}  ${(statSync(OUTPUT).size / 1024).toFixed(0)} KB  (${entries.length} files)`);
console.log(`✓ ${relative(ROOT, sidecarPath)}  ${digest}`);
