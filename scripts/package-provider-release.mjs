#!/usr/bin/env node
/** Build deterministic, versioned runtime archives for both provider targets. */
import { copyFileSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  collectArchiveEntries,
  writeDeterministicTarGzip,
  writeDeterministicZip,
  writeSha256Sidecar,
} from './lib/deterministic-zip.mjs';
import {
  isNapCatRuntimeReleaseFile,
  isSnowLumaDeploymentReleaseFile,
  isSnowLumaRuntimeReleaseFile,
} from './lib/release-entry-policy.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const outputDirectory = resolve(ROOT, option('--output-dir') ?? 'release');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) {
  throw new Error(`Provider archives require a stable SemVer version, got ${JSON.stringify(pkg.version)}`);
}

const napCatDirectory = join(ROOT, 'dist');
const snowLumaDirectory = join(ROOT, 'dist-snowluma');
const deployDirectory = join(ROOT, 'deploy');
const snowLumaGuide = join(ROOT, 'docs', 'deployment', 'snowluma.md');
const recoveryGuide = join(ROOT, 'docs', 'security', 'super-admin-recovery.md');

const targets = [
  {
    archive: `napcat-plugin-qq-guardian-v${pkg.version}`,
    compatibilityArchive: 'napcat-plugin-qq-guardian',
    requiredEntries: ['index.mjs', 'package.json', 'plugin.json'],
    sources: [{
      directory: napCatDirectory,
      include: (path) => isNapCatRuntimeReleaseFile(napCatDirectory, path),
    }],
  },
  {
    archive: `qq-guardian-snowluma-v${pkg.version}`,
    compatibilityArchive: 'qq-guardian-snowluma',
    requiredEntries: [
      'dist-snowluma/index.mjs',
      'deploy/Dockerfile',
      'deploy/compose.yaml',
      '.dockerignore',
      'docs/deployment/snowluma.md',
      'docs/security/super-admin-recovery.md',
    ],
    sources: [
      {
        directory: snowLumaDirectory,
        prefix: 'dist-snowluma',
        include: (path) => isSnowLumaRuntimeReleaseFile(snowLumaDirectory, path),
      },
      {
        directory: deployDirectory,
        prefix: 'deploy',
        include: (path) => isSnowLumaDeploymentReleaseFile(deployDirectory, path),
      },
      { file: join(ROOT, '.dockerignore'), name: '.dockerignore' },
      { file: snowLumaGuide, name: 'snowluma.md', prefix: 'docs/deployment' },
      { file: recoveryGuide, name: 'super-admin-recovery.md', prefix: 'docs/security' },
    ],
  },
];

for (const target of targets) {
  const entries = collectArchiveEntries(target.sources);
  if (entries.length === 0) throw new Error(`No reviewed runtime files found for ${target.archive}`);
  const entryNames = new Set(entries.map((entry) => entry.name));
  for (const required of target.requiredEntries) {
    if (!entryNames.has(required)) throw new Error(`${target.archive} is missing required entry ${required}`);
  }

  const zipPath = join(outputDirectory, `${target.archive}.zip`);
  const tarPath = join(outputDirectory, `${target.archive}.tar.gz`);
  writeDeterministicZip({ outputPath: zipPath, entries });
  writeDeterministicTarGzip({ outputPath: tarPath, entries });
  writeSha256Sidecar(zipPath);
  writeSha256Sidecar(tarPath);

  const compatibilityZipPath = join(outputDirectory, `${target.compatibilityArchive}.zip`);
  const compatibilityTarPath = join(outputDirectory, `${target.compatibilityArchive}.tar.gz`);
  copyFileSync(zipPath, compatibilityZipPath);
  copyFileSync(tarPath, compatibilityTarPath);
  writeSha256Sidecar(compatibilityZipPath);
  writeSha256Sidecar(compatibilityTarPath);

  console.log(`✓ ${relative(ROOT, zipPath)}  ${(statSync(zipPath).size / 1024).toFixed(0)} KB`);
  console.log(`✓ ${relative(ROOT, tarPath)}  ${(statSync(tarPath).size / 1024).toFixed(0)} KB`);
  console.log(`✓ compatibility aliases ${relative(ROOT, compatibilityZipPath)} and ${relative(ROOT, compatibilityTarPath)}`);
}

function option(name) {
  return process.argv.find((argument) => argument.startsWith(`${name}=`))?.slice(name.length + 1);
}
