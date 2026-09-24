#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readZipEntryNames } from './lib/deterministic-zip.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const directory = resolve(ROOT, requiredOption('--directory'));
  const result = verifyDeploymentRelease({ directory, tag: requiredOption('--tag') });
  const output = option('--output');
  if (output) writeFileSync(resolve(ROOT, output), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  console.log(`✓ ${result.artifact.name} ${result.artifact.sha256} contains ${result.entryCount} reviewed files`);
}

export function verifyDeploymentRelease({ directory, tag }) {
  const versionMatch = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(tag);
  if (!versionMatch) throw new Error('Deployment release tag must be vX.Y.Z');
  const version = versionMatch.slice(1).join('.');
  const archivePath = resolve(directory, 'releaseDownload.zip');
  const sidecarPath = `${archivePath}.sha256`;
  const aggregatePath = resolve(directory, 'SHA256SUMS');
  for (const path of [archivePath, sidecarPath, aggregatePath]) {
    if (!existsSync(path)) throw new Error(`Required deployment release asset is missing: ${basename(path)}`);
  }

  const digest = createHash('sha256').update(readFileSync(archivePath)).digest('hex');
  const sidecar = readFileSync(sidecarPath, 'utf8');
  if (sidecar !== `${digest}  releaseDownload.zip\n`) {
    throw new Error('releaseDownload.zip SHA-256 sidecar does not match');
  }
  const checksums = parseChecksums(readFileSync(aggregatePath, 'utf8'));
  if (checksums.get('releaseDownload.zip') !== digest) {
    throw new Error('SHA256SUMS does not authenticate releaseDownload.zip');
  }

  const entries = readZipEntryNames(archivePath);
  if (entries.length === 0) throw new Error('releaseDownload.zip is empty');
  const bundleRoot = `qq-guardian-v${version}`;
  const normalized = entries.map((entry) => {
    assertSafeEntry(entry);
    if (!entry.startsWith(`${bundleRoot}/`)) {
      throw new Error(`Archive entry is outside the expected ${bundleRoot} root: ${entry}`);
    }
    return entry.slice(bundleRoot.length + 1);
  });
  const names = new Set(normalized);
  for (const required of [
    'package.json',
    'pnpm-lock.yaml',
    'dist/index.mjs',
    'dist/plugin.json',
    'dist-snowluma/index.mjs',
    'deploy/.env.example',
    'deploy/Dockerfile',
    'deploy/compose.yaml',
    'deploy/native/guardian.env.example',
    'runtime/node/LICENSE',
    'runtime/node/runtime.json',
    'src/index.ts',
    'src/snowluma.ts',
    '.github/workflows/ci.yml',
    '.github/workflows/release.yml',
    '.github/workflows/deploy.yml',
    '.github/workflows/rollback.yml',
    'config/ci-environments.json',
    'test/tooling/deployment-control-plane.test.mjs',
  ]) {
    if (!names.has(required)) throw new Error(`releaseDownload.zip is missing ${required}`);
  }
  if (!names.has('runtime/node/node.exe') && !names.has('runtime/node/bin/node')) {
    throw new Error('releaseDownload.zip is missing its platform Node.js executable');
  }

  return {
    schemaVersion: 1,
    version: tag,
    bundleRoot,
    artifact: { name: 'releaseDownload.zip', sha256: digest },
    entryCount: entries.length,
  };
}

function parseChecksums(source) {
  const values = new Map();
  const lines = source.trim().split(/\r?\n/);
  if (lines.length === 0) throw new Error('SHA256SUMS is empty');
  for (const line of lines) {
    const match = /^([a-f0-9]{64})  ([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(line);
    if (!match) throw new Error(`Invalid SHA256SUMS line: ${line}`);
    if (values.has(match[2])) throw new Error(`Duplicate SHA256SUMS entry: ${match[2]}`);
    values.set(match[2], match[1]);
  }
  return values;
}

function assertSafeEntry(entry) {
  if (typeof entry !== 'string' || !entry || entry.includes('\\') || entry.startsWith('/')
    || entry.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`Unsafe archive entry: ${String(entry)}`);
  }
  const lower = entry.toLowerCase();
  if (lower.includes('/.git/') || lower.includes('/node_modules/')
    || /(?:^|\/)\.env(?:\.|$)/.test(lower) && !lower.endsWith('.example')) {
    throw new Error(`Forbidden deployment archive entry: ${entry}`);
  }
}

function option(name) {
  return process.argv.find((argument) => argument.startsWith(`${name}=`))?.slice(name.length + 1);
}

function requiredOption(name) {
  const value = option(name);
  if (!value) throw new Error(`${name}=... is required`);
  return value;
}
