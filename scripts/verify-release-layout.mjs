#!/usr/bin/env node
import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTarGzipEntryNames, readZipEntryNames } from './lib/deterministic-zip.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REQUIRED = [
  '.dockerignore',
  'LICENSE',
  'README.md',
  'package.json',
  'plugin.json',
  'pnpm-lock.yaml',
  'src/index.ts',
  'src/snowluma.ts',
  'webui/index.html',
  'scripts/build.mjs',
  'dist/index.mjs',
  'dist/package.json',
  'dist/plugin.json',
  'dist-snowluma/index.mjs',
  'dist-snowluma/package.json',
  'deploy/.env.example',
  'deploy/Dockerfile',
  'deploy/compose.yaml',
  'deploy/native/guardian.env.example',
  'deploy/native/start-bundled-guardian.ps1',
  'deploy/native/start-bundled-guardian.sh',
  'docs/deployment/snowluma.md',
  'docs/security/super-admin-recovery.md',
];
const FULL_REQUIRED = [
  '.github/workflows/ci.yml',
  '.github/workflows/release.yml',
];
const archiveOption = option('--archive');
const directoryOption = option('--directory');
if (Boolean(archiveOption) === Boolean(directoryOption)) {
  throw new Error('Pass exactly one of --archive=<path> or --directory=<path>');
}

const archives = archiveOption
  ? [resolve(ROOT, archiveOption)]
  : readdirSync(resolve(ROOT, directoryOption))
    .filter((name) => /^qq-guardian-v\d+\.\d+\.\d+-(?:lite|full-[a-z0-9._-]+)\.(?:zip|tar\.gz)$/i.test(name)
      || name === 'releaseDownload.zip')
    .map((name) => resolve(ROOT, directoryOption, name))
    .sort();
if (archives.length === 0) throw new Error('No complete release archives found');

for (const archive of archives) verifyArchive(archive);
console.log(`✓ complete release layout verified (${archives.length} archive${archives.length === 1 ? '' : 's'})`);

function verifyArchive(archivePath) {
  if (!existsSync(archivePath) || !statSync(archivePath).isFile()) throw new Error(`Archive is missing: ${archivePath}`);
  const name = basename(archivePath);
  const names = name.endsWith('.tar.gz') ? readTarGzipEntryNames(archivePath) : readZipEntryNames(archivePath);
  if (names.length === 0) throw new Error(`${name} is empty`);
  const roots = new Set(names.map((entry) => entry.split('/')[0]));
  if (roots.size !== 1) throw new Error(`${name} must contain exactly one versioned root directory`);
  const [bundleRoot] = roots;
  if (!/^qq-guardian-v\d+\.\d+\.\d+$/.test(bundleRoot)) {
    throw new Error(`${name} has invalid root directory ${bundleRoot}`);
  }

  const relativeNames = names.map((entry) => {
    if (!entry.startsWith(`${bundleRoot}/`)) throw new Error(`${name} contains an entry outside ${bundleRoot}`);
    return entry.slice(bundleRoot.length + 1);
  });
  const set = new Set(relativeNames);
  const isFull = name === 'releaseDownload.zip' || name.includes('-full-');
  for (const required of [...REQUIRED, ...(isFull ? FULL_REQUIRED : [])]) {
    if (!set.has(required)) throw new Error(`${name} is missing ${required}`);
  }

  if (isFull) {
    if (!set.has('runtime/node/LICENSE') || !set.has('runtime/node/runtime.json')) {
      throw new Error(`${name} is missing bundled Node.js metadata/license`);
    }
    if (!set.has('runtime/node/node.exe') && !set.has('runtime/node/bin/node')) {
      throw new Error(`${name} is missing a bundled Node.js executable`);
    }
  } else if (relativeNames.some((entry) => entry.startsWith('runtime/node/'))) {
    throw new Error(`${name} lite archive unexpectedly contains a Node.js runtime`);
  }

  for (const entry of relativeNames) assertAllowedEntry(name, entry, isFull);
  console.log(`✓ ${name}: ${relativeNames.length} reviewed files`);
}

function assertAllowedEntry(archiveName, entry, isFull) {
  const segments = entry.split('/');
  if (['.git', 'coverage', 'node_modules', 'release'].includes(segments[0])
    || (!isFull && ['.github', 'test'].includes(segments[0]))) {
    throw new Error(`${archiveName} contains development-only path ${entry}`);
  }
  if (segments.includes('node_modules')) throw new Error(`${archiveName} contains dependency tree ${entry}`);
  const leaf = segments.at(-1) ?? '';
  if ((leaf === '.env' || leaf.startsWith('.env.')) && !leaf.endsWith('.example')) {
    throw new Error(`${archiveName} contains environment secret ${entry}`);
  }
  if (/^(?:config\.json|bootstrap-credentials\.json)$/i.test(leaf)
    || /\.(?:db|db-shm|db-wal|log|map)$/i.test(leaf)) {
    throw new Error(`${archiveName} contains local/generated state ${entry}`);
  }
}

function option(name) {
  return process.argv.find((argument) => argument.startsWith(`${name}=`))?.slice(name.length + 1);
}
