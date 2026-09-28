#!/usr/bin/env node
/** Package the standalone runtime and its deployment assets into one ZIP. */
import { existsSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectArchiveEntries, writeDeterministicZip, writeSha256Sidecar } from './lib/deterministic-zip.mjs';
import { isSnowLumaDeploymentReleaseFile, isSnowLumaRuntimeReleaseFile } from './lib/release-entry-policy.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist-snowluma');
const DEPLOY = join(ROOT, 'deploy');
const OPERATIONS_GUIDE = join(ROOT, 'docs', 'deployment', 'snowluma.md');
const ADMIN_RECOVERY_GUIDE = join(ROOT, 'docs', 'security', 'super-admin-recovery.md');
const DOCKERIGNORE = join(ROOT, '.dockerignore');
const OUTPUT = join(ROOT, 'release', 'qq-guardian-snowluma.zip');

if (!existsSync(join(DIST, 'index.mjs'))) {
  console.error('✗ dist-snowluma/index.mjs not found — run `pnpm run build` first');
  process.exit(1);
}
if (!existsSync(join(DEPLOY, 'Dockerfile')) || !existsSync(join(DEPLOY, 'compose.yaml'))) {
  console.error('✗ deploy/Dockerfile and deploy/compose.yaml are required for the SnowLuma release bundle');
  process.exit(1);
}
if (!existsSync(OPERATIONS_GUIDE)) {
  console.error('✗ docs/deployment/snowluma.md is required for the self-contained SnowLuma release bundle');
  process.exit(1);
}
if (!existsSync(ADMIN_RECOVERY_GUIDE)) {
  console.error('✗ docs/security/super-admin-recovery.md is required for the self-contained SnowLuma release bundle');
  process.exit(1);
}
if (!existsSync(DOCKERIGNORE)) {
  console.error('鉁?A root .dockerignore is required so deployment secrets stay out of the Docker build context');
  process.exit(1);
}

const entries = collectArchiveEntries([
  {
    directory: DIST,
    prefix: 'dist-snowluma',
    include: (absolutePath) => isSnowLumaRuntimeReleaseFile(DIST, absolutePath),
  },
  {
    directory: DEPLOY,
    prefix: 'deploy',
    include: (absolutePath) => isSnowLumaDeploymentReleaseFile(DEPLOY, absolutePath),
  },
  { file: DOCKERIGNORE, name: '.dockerignore' },
  {
    directory: join(ROOT, 'docs'),
    prefix: 'docs',
    include: (absolutePath) =>
      absolutePath === OPERATIONS_GUIDE || absolutePath === ADMIN_RECOVERY_GUIDE,
  },
]);
writeDeterministicZip({ outputPath: OUTPUT, entries });
const { digest, sidecarPath } = writeSha256Sidecar(OUTPUT);

console.log(`✓ ${relative(ROOT, OUTPUT)}  ${(statSync(OUTPUT).size / 1024).toFixed(0)} KB  (${entries.length} files)`);
console.log(`✓ ${relative(ROOT, sidecarPath)}  ${digest}`);
