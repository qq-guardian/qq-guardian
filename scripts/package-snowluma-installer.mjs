#!/usr/bin/env node
/**
 * Build a QQ Guardian SnowLuma integration installer.
 *
 * This archive is intentionally NOT a SnowLuma distribution. The operator
 * supplies the exact official SnowLuma FULL archive separately. The native
 * SnowLuma components are never copied into this third-party archive.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  collectArchiveEntries,
  writeDeterministicTarGzip,
  writeDeterministicZip,
  writeSha256Sidecar,
} from './lib/deterministic-zip.mjs';
import { isSnowLumaRuntimeReleaseFile } from './lib/release-entry-policy.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(ROOT, 'UPSTREAM-SNOWLUMA.json'), 'utf8'));
const project = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const platform = arg('--platform') ?? detect();
const outputDir = resolve(ROOT, arg('--output-dir') ?? 'release');

if (!['win-x64', 'linux-x64', 'linux-arm64'].includes(platform)) {
  throw new Error(`Unsupported platform: ${platform}`);
}
if (!existsSync(join(ROOT, 'dist-snowluma', 'index.mjs'))) {
  throw new Error('Run pnpm run build first');
}

const official = manifest.platforms[platform].full;
const bundleRoot = `qq-guardian-snowluma-installer-v${project.version}`;
const archiveBase = `${bundleRoot}-${platform}`;
const archivePath = join(outputDir, platform === 'win-x64'
  ? `${archiveBase}.zip`
  : `${archiveBase}.tar.gz`);

const platformFiles = platform === 'win-x64'
  ? [
      'deploy/native/snowluma-install.ps1',
      'deploy/native/start-snowluma-guardian.ps1',
    ]
  : [
      'deploy/native/snowluma-install.sh',
      'deploy/native/start-snowluma-guardian.sh',
      'deploy/native/qq-guardian-snowluma.service',
    ];

const entries = collectArchiveEntries([{
  directory: join(ROOT, 'dist-snowluma'),
  prefix: `${bundleRoot}/dist-snowluma`,
  include: (absolutePath) => isSnowLumaRuntimeReleaseFile(join(ROOT, 'dist-snowluma'), absolutePath),
}]);

for (const file of platformFiles) {
  const absolutePath = join(ROOT, file);
  requireFile(absolutePath, file);
  entries.push({
    name: `${bundleRoot}/${file}`,
    data: readFileSync(absolutePath),
    mode: file.endsWith('.sh') ? 0o755 : 0o644,
  });
}

entries.push(
  { name: `${bundleRoot}/LICENSE`, data: readFileSync(join(ROOT, 'LICENSE')), mode: 0o644 },
  { name: `${bundleRoot}/UPSTREAM-SNOWLUMA.json`, data: readFileSync(join(ROOT, 'UPSTREAM-SNOWLUMA.json')), mode: 0o644 },
  { name: `${bundleRoot}/official-snowluma.sha256`, data: Buffer.from(`${official.sha256}  ${official.file}\\n`, 'utf8'), mode: 0o644 },
  { name: `${bundleRoot}/official-snowluma.size`, data: Buffer.from(`${official.size}\\n`, 'utf8'), mode: 0o644 },
  {
    name: `${bundleRoot}/SNOWLUMA-INTEGRATION-NOTICE.md`,
    data: Buffer.from(notice(official), 'utf8'),
    mode: 0o644,
  },
  {
    name: `${bundleRoot}/README.md`,
    data: Buffer.from(readme(project.version, platform, official), 'utf8'),
    mode: 0o644,
  },
);

entries.sort((left, right) => left.name.localeCompare(right.name));

if (platform === 'win-x64') {
  writeDeterministicZip({ outputPath: archivePath, entries });
} else {
  writeDeterministicTarGzip({ outputPath: archivePath, entries });
}

const sidecar = writeSha256Sidecar(archivePath);
console.log(`✓ ${relative(ROOT, archivePath)}  ${statSync(archivePath).size} bytes  ${sidecar.digest}`);

function arg(name) {
  const hit = process.argv.find((argument) => argument.startsWith(`${name}=`));
  return hit?.slice(name.length + 1);
}

function detect() {
  if (process.platform === 'win32' && process.arch === 'x64') return 'win-x64';
  if (process.platform === 'linux' && process.arch === 'x64') return 'linux-x64';
  if (process.platform === 'linux' && process.arch === 'arm64') return 'linux-arm64';
  throw new Error('Unsupported host platform');
}

function requireFile(path, label) {
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`Missing ${label}: ${path}`);
}

function readme(version, target, asset) {
  const command = target === 'win-x64'
    ? `powershell -ExecutionPolicy Bypass -File .\\deploy\\native\\snowluma-install.ps1 -OfficialPackage C:\\Packages\\${asset.file} -AcceptEula -AcceptPrivacy -Unattended`
    : `sudo sh ./deploy/native/snowluma-install.sh --package /srv/packages/${asset.file} --accept-eula --accept-privacy --unattended`;

  return [
    `QQ Guardian SnowLuma integration installer v${version}`,
    '',
    'This is NOT the official SnowLuma distribution.',
    `Upstream release: SnowLuma ${manifest.officialRelease.tag}`,
    `Required official asset: ${asset.file}`,
    `Required size: ${asset.size} bytes`,
    `Required SHA-256: ${asset.sha256}`,
    '',
    'Obtain the exact official FULL archive from the upstream SnowLuma Release and provide it to this installer.',
    'The installer verifies the archive filename, byte size, SHA-256, launcher, bundled Node.js runtime, and platform native files before installation.',
    '',
    'Unattended integration install:',
    command,
    '',
    'Unattended mode removes installer prompts and registers/starts the local supervisor. QQ login and any QR approval remain operator actions.',
  ].join('\\n') + '\\n';
}

function notice(asset) {
  return [
    '# SnowLuma integration boundary',
    '',
    `QQ Guardian integrates with official SnowLuma ${manifest.officialRelease.tag}.`,
    '',
    `- Official asset: \`${asset.file}\``,
    `- Official size: ${asset.size} bytes`,
    `- Official SHA-256: \`${asset.sha256}\``,
    '- The official SnowLuma binary archive is not embedded in this QQ Guardian release.',
    '- The operator must obtain the official archive separately and supply it to the installer.',
    '- The installer verifies the exact upstream artifact before extraction.',
    '',
    'SnowLuma native components remain subject to the upstream proprietary terms. This repository does not redistribute those binaries.',
    '',
  ].join('\\n');
}
