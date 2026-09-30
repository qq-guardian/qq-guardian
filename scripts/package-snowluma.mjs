#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectArchiveEntries, writeDeterministicTarGzip, writeDeterministicZip, writeSha256Sidecar } from './lib/deterministic-zip.mjs';
import { isSnowLumaDeploymentReleaseFile, isSnowLumaRuntimeReleaseFile } from './lib/release-entry-policy.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const upstream = JSON.parse(readFileSync(join(ROOT, 'UPSTREAM-SNOWLUMA.json'), 'utf8'));
const platform = value('--platform') ?? detectHostPlatform();
const flavor = value('--flavor') ?? 'lite';
const outputDirectory = resolve(ROOT, value('--output-dir') ?? 'release');

if (!['win-x64', 'linux-x64', 'linux-arm64'].includes(platform)) throw new Error('Unsupported SnowLuma provider platform: ' + platform);
if (!['full', 'lite'].includes(flavor)) throw new Error('--flavor must be full or lite');
if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) throw new Error('Stable package version required, got ' + pkg.version);
if (!existsSync(join(ROOT, 'dist-snowluma', 'index.mjs'))) throw new Error('dist-snowluma/index.mjs is missing; run pnpm run build first');

const bundleRoot = 'qq-guardian-snowluma-v' + pkg.version;
const archiveBase = bundleRoot + '-' + platform + (flavor === 'lite' ? '-lite' : '');
const archivePath = join(outputDirectory, platform === 'win-x64' ? archiveBase + '.zip' : archiveBase + '.tar.gz');

const deploymentFiles = [
  'Dockerfile',
  'README.md',
  'compose.yaml',
  'native/guardian.env.example',
  'native/initialize-guardian-state.ps1',
  'native/start-guardian.ps1',
  'native/start-guardian.sh',
  'native/unattended-start.ps1',
  'native/unattended-start.sh',
];

const entries = collectArchiveEntries([
  {
    directory: join(ROOT, 'dist-snowluma'),
    prefix: bundleRoot + '/dist-snowluma',
    include: (absolutePath) => isSnowLumaRuntimeReleaseFile(join(ROOT, 'dist-snowluma'), absolutePath),
  },
  {
    directory: join(ROOT, 'deploy'),
    prefix: bundleRoot + '/deploy',
    include: (absolutePath) => {
      const rel = absolutePath.slice(join(ROOT, 'deploy').length + 1).replaceAll('\\', '/');
      if (!deploymentFiles.includes(rel)) return false;
      if (platform === 'win-x64' && rel.endsWith('.sh')) return false;
      if (platform !== 'win-x64' && rel.endsWith('.ps1')) return false;
      return isSnowLumaDeploymentReleaseFile(join(ROOT, 'deploy'), absolutePath);
    },
  },
  { file: join(ROOT, 'docs', 'deployment', 'snowluma.md'), name: bundleRoot + '/docs/deployment/snowluma.md' },
  { file: join(ROOT, 'docs', 'deployment', 'snowluma-upstream.md'), name: bundleRoot + '/docs/deployment/snowluma-upstream.md' },
  { file: join(ROOT, 'docs', 'security', 'super-admin-recovery.md'), name: bundleRoot + '/docs/security/super-admin-recovery.md' },
  { file: join(ROOT, 'UPSTREAM-SNOWLUMA.json'), name: bundleRoot + '/UPSTREAM-SNOWLUMA.json' },
]);

entries.push({
  name: bundleRoot + '/README.md',
  data: Buffer.from(providerReadme(pkg.version, platform, flavor, upstream.officialRelease), 'utf8'),
  mode: 0o644,
});
entries.push({
  name: bundleRoot + '/check-node-version.cjs',
  data: Buffer.from(checkNodeScript(), 'utf8'),
  mode: 0o644,
});
entries.push({
  name: bundleRoot + '/' + (platform === 'win-x64' ? 'launcher.bat' : 'launcher.sh'),
  data: Buffer.from(platform === 'win-x64' ? windowsLauncher() : linuxLauncher(), 'utf8'),
  mode: platform === 'win-x64' ? 0o644 : 0o755,
});

if (flavor === 'full') addBundledNode(entries, bundleRoot, platform);

entries.sort((a, b) => a.name.localeCompare(b.name));
if (platform === 'win-x64') writeDeterministicZip({ outputPath: archivePath, entries });
else writeDeterministicTarGzip({ outputPath: archivePath, entries});

const sidecar = writeSha256Sidecar(archivePath);
console.log('✓ ' + relative(ROOT, archivePath) + '  ' + (statSync(archivePath).size / 1024).toFixed(0) + ' KB  (' + entries.length + ' files, ' + platform + ', ' + flavor + ')');
console.log('✓ ' + relative(ROOT, sidecar.sidecarPath) + '  ' + sidecar.digest);

function addBundledNode(target, root, targetPlatform) {
  const binaryPath = resolve(ROOT, value('--node-binary') ?? process.execPath);
  if (!existsSync(binaryPath)) throw new Error('Node.js runtime executable not found: ' + binaryPath);
  const licenseArgument = value('--node-license');
  const candidates = licenseArgument
    ? [resolve(ROOT, licenseArgument)]
    : [join(dirname(binaryPath), 'LICENSE'), join(dirname(dirname(binaryPath)), 'LICENSE')];
  const licensePath = candidates.find((candidate) => existsSync(candidate));
  if (!licensePath) throw new Error('Node.js LICENSE not found; pass --node-license=<path>');
  const windows = targetPlatform === 'win-x64';
  target.push(
    { name: root + '/runtime/node/' + (windows ? 'node.exe' : 'bin/node'), data: readFileSync(binaryPath), mode: windows ? 0o644 : 0o755 },
    { name: root + '/runtime/node/LICENSE', data: readFileSync(licensePath), mode: 0o644 },
    { name: root + '/runtime/node/runtime.json', data: Buffer.from(JSON.stringify({node: process.version, platform: targetPlatform}) + '\n', 'utf8'), mode: 0o644 },
  );
}

function providerReadme(version, targetPlatform, targetFlavor, upstreamVersion) {
  return [
    '# QQ Guardian SnowLuma Provider v' + version,
    '',
    'Platform: ' + targetPlatform,
    'Flavor: ' + targetFlavor,
    '',
    'This is the QQ Guardian SnowLuma provider, not the official SnowLuma distribution.',
    'It does not redistribute SnowLuma proprietary native components.',
    '',
    'Install the matching official SnowLuma ' + upstreamVersion + ' release separately.',
    'Configure SNOWLUMA_WS_URL and SNOWLUMA_ACCESS_TOKEN for Guardian.',
    'For unattended operation, use deploy/native/unattended-start.ps1 on Windows or deploy/native/unattended-start.sh on Linux.',
    'The official consent variables are SNOWLUMA_ACCEPT_EULA=1 and SNOWLUMA_ACCEPT_PRIVACY=1.',
    '',
  ].join('\n');
}

function checkNodeScript() {
  return [
    "'use strict';",
    '',
    "const SUPPORTED_NODE_RANGE = '^22.13.0 || >=23.4.0';",
    'function parseNodeVersion(version) {',
    "  const match = /^(\\d+)\\.(\\d+)\\.(\\d+)(?:[-+].*)?$/.exec(version);",
    '  return match ? match.slice(1, 4).map(Number) : null;',
    '}',
    'function isSupportedNodeVersion(version) {',
    '  const actual = parseNodeVersion(version);',
    '  if (!actual) return false;',
    '  const [major, minor] = actual;',
    '  if (major === 22) return minor >= 13;',
    '  if (major === 23) return minor >= 4;',
    '  return major > 23;',
    '}',
    'if (require.main === module && !isSupportedNodeVersion(process.versions.node)) {',
    '  console.error("error: QQ Guardian SnowLuma provider requires Node.js " + SUPPORTED_NODE_RANGE + "; found " + process.versions.node + ".");',
    '  process.exitCode = 1;',
    '}',
    'module.exports = { SUPPORTED_NODE_RANGE, isSupportedNodeVersion };',
    '',
  ].join('\n');
}

function windowsLauncher() {
  return [
    '@echo off',
    'setlocal',
    'set "ROOT=%~dp0"',
    'if exist "%ROOT%runtime\\node\\node.exe" (',
    '  set "NODE=%ROOT%runtime\\node\\node.exe"',
    ') else (',
    '  set "NODE=node"',
    ')',
    '%NODE% "%ROOT%check-node-version.cjs" || exit /b %errorlevel%',
    '%NODE% "%ROOT%dist-snowluma\\index.mjs" %*',
    'exit /b %errorlevel%',
    '',
  ].join('\n');
}

function linuxLauncher() {
  return [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'cd "$(dirname "$0")"',
    'if [[ -x "./runtime/node/bin/node" ]]; then',
    '  NODE_BIN="./runtime/node/bin/node"',
    'else',
    '  NODE_BIN="$(command -v node || true)"',
    '  if [[ -z "$NODE_BIN" ]]; then',
    '    echo "error: Node.js >=22.13.0 is required and no bundled ./runtime/node/bin/node was found." >&2',
    '    exit 127',
    '  fi',
    'fi',
    '"$NODE_BIN" ./check-node-version.cjs',
    'exec "$NODE_BIN" ./dist-snowluma/index.mjs "$@"',
    '',
  ].join('\n');
}

function detectHostPlatform() {
  if (process.platform === 'win32' && process.arch === 'x64') return 'win-x64';
  if (process.platform === 'linux' && process.arch === 'x64') return 'linux-x64';
  if (process.platform === 'linux' && process.arch === 'arm64') return 'linux-arm64';
  throw new Error('Unsupported host for automatic provider packaging: ' + process.platform + '-' + process.arch);
}

function value(name) {
  return process.argv.find((argument) => argument.startsWith(name + '='))?.slice(name.length + 1);
}
