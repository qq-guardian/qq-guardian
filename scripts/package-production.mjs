#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, rmSync, cpSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectArchiveEntries, writeDeterministicZip, writeDeterministicTarGzip, writeSha256Sidecar } from './lib/deterministic-zip.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const requested = arg('--platform') ?? detectPlatform();
const runtime = arg('--runtime') ?? process.execPath;
const releaseDir = resolve(ROOT, arg('--output-dir') ?? 'release');
const stage = resolve(ROOT, '.release-stage', requested);

if (!['win-x64', 'linux-x64'].includes(requested)) throw new Error(`Unsupported platform: ${requested}`);
if (!existsSync(join(ROOT, 'dist-snowluma', 'index.mjs'))) throw new Error('Run pnpm run build before packaging');
if (!existsSync(runtime) || !statSync(runtime).isFile()) throw new Error(`Node runtime not found: ${runtime}`);

rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
mkdirSync(join(stage, 'app'), { recursive: true });
mkdirSync(join(stage, 'runtime', 'node'), { recursive: true });
mkdirSync(join(stage, 'config'), { recursive: true });
mkdirSync(join(stage, 'data'), { recursive: true });
mkdirSync(join(stage, 'logs'), { recursive: true });
mkdirSync(join(stage, 'docs'), { recursive: true });

cpSync(join(ROOT, 'dist-snowluma'), join(stage, 'app'), { recursive: true });
cpSync(join(ROOT, 'README.md'), join(stage, 'docs', 'README.md'));
cpSync(join(ROOT, 'DEPLOYMENT.md'), join(stage, 'docs', 'DEPLOYMENT.md'));
cpSync(join(ROOT, 'SECURITY.md'), join(stage, 'docs', 'SECURITY.md'));
cpSync(join(ROOT, 'deploy', '.env.example'), join(stage, 'config', '.env.example'));

const nodeName = requested === 'win-x64' ? 'node.exe' : 'bin/node';
const nodeTarget = join(stage, 'runtime', 'node', nodeName);
mkdirSync(dirname(nodeTarget), { recursive: true });
cpSync(runtime, nodeTarget);
writeFileSync(join(stage, 'runtime', 'node', 'runtime.json'), JSON.stringify({
  provider: 'nodejs.org',
  major: 22,
  source: 'GitHub Actions setup-node runner',
  executable: nodeName
}, null, 2) + '\n');
writeFileSync(join(stage, 'logs', '.gitkeep'), '');
writeFileSync(join(stage, 'data', '.gitkeep'), '');
writeFileSync(join(stage, 'config', '.gitkeep'), '');

const launcher = requested === 'win-x64'
  ? `@echo off
setlocal
set ROOT=%~dp0
set NODE=%ROOT%runtime\\node\\node.exe
if not exist "%NODE%" (echo Missing bundled Node.js runtime & exit /b 1)
if not exist "%ROOT%logs" mkdir "%ROOT%logs"
"%NODE%" "%ROOT%app\\index.mjs" >> "%ROOT%logs\\qq-guardian.log" 2>&1
`
  : `#!/bin/sh
set -eu
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
NODE="$ROOT/runtime/node/bin/node"
[ -x "$NODE" ] || { echo "Missing bundled Node.js runtime: $NODE" >&2; exit 1; }
mkdir -p "$ROOT/logs"
exec "$NODE" "$ROOT/app/index.mjs" >> "$ROOT/logs/qq-guardian.log" 2>&1
`;
writeFileSync(join(stage, requested === 'win-x64' ? 'launcher.bat' : 'launcher.sh'), launcher);

const update = requested === 'win-x64'
  ? `@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0updater\\update.ps1" %*
`
  : `#!/bin/sh
set -eu
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
exec "$ROOT/updater/update.sh" "$@"
`;
mkdirSync(join(stage, 'updater'), { recursive: true });
writeFileSync(join(stage, requested === 'win-x64' ? 'update.bat' : 'update.sh'), update);
if (requested === 'win-x64') writeFileSync(join(stage, 'updater', 'update.ps1'), winUpdater());
else writeFileSync(join(stage, 'updater', 'update.sh'), linuxUpdater(), { mode: 0o755 });

const install = requested === 'linux-x64' ? linuxInstaller() : winInstaller();
if (requested === 'linux-x64') writeFileSync(join(stage, 'install.sh'), install, { mode: 0o755 });
else writeFileSync(join(stage, 'install.ps1'), install);

writeFileSync(join(stage, requested === 'win-x64' ? 'verify.ps1' : 'verify.sh'), requested === 'win-x64' ? winVerify() : linuxVerify(), { mode: requested === 'win-x64' ? 0o644 : 0o755 });
writeFileSync(join(stage, requested === 'win-x64' ? 'uninstall.ps1' : 'uninstall.sh'), requested === 'win-x64' ? winUninstall() : linuxUninstall(), { mode: requested === 'win-x64' ? 0o644 : 0o755 });
writeFileSync(join(stage, requested === 'win-x64' ? 'rollback.ps1' : 'rollback.sh'), requested === 'win-x64' ? winRollback() : linuxRollback(), { mode: requested === 'win-x64' ? 0o644 : 0o755 });
if (requested === 'linux-x64') {
  mkdirSync(join(stage, 'service'), { recursive: true });
  writeFileSync(join(stage, 'service', 'qq-guardian.service'), systemdUnit());
}
writeFileSync(join(stage, 'RELEASE-MANIFEST.json'), JSON.stringify({
  name: 'qq-guardian',
  version: pkg.version,
  platform: requested,
  entrypoint: 'app/index.mjs',
  dataDirectory: 'data',
  logDirectory: 'logs',
  configDirectory: 'config',
  updatePolicy: 'versioned-install-preserves-data-config-logs'
}, null, 2) + '\n');

const root = `qq-guardian-v${pkg.version}-${requested}`;
const entries = collectArchiveEntries([{ directory: stage, prefix: root }]);
mkdirSync(releaseDir, { recursive: true });
const archive = join(releaseDir, requested === 'win-x64'
  ? `qq-guardian-v${pkg.version}-win-x64.zip`
  : `qq-guardian-v${pkg.version}-linux-x64.tar.gz`);
if (requested === 'win-x64') writeDeterministicZip({ outputPath: archive, entries });
else writeDeterministicTarGzip({ outputPath: archive, entries });
const sidecar = writeSha256Sidecar(archive);
console.log(`✓ ${relative(ROOT, archive)} ${statSync(archive).size} bytes ${sidecar.digest}`);

function arg(name) { return process.argv.find(a => a.startsWith(name + '='))?.slice(name.length + 1); }
function detectPlatform() {
  if (process.platform === 'win32' && process.arch === 'x64') return 'win-x64';
  if (process.platform === 'linux' && process.arch === 'x64') return 'linux-x64';
  throw new Error('Supported hosts: Windows x64 or Linux x64');
}
function linuxUpdater() {
  return String.raw\`#!/bin/sh
set -eu
REPO="\${QQ_GUARDIAN_REPOSITORY:-qq-guardian/qq-guardian}"
PREFIX="\${QQ_GUARDIAN_PREFIX:-$HOME/.local/opt/qq-guardian}"
VERSION="\${1:-}"
ARCHIVE="\${2:-}"
[ -n "$VERSION" ] || { echo "Usage: ./update.sh vX.Y.Z [archive-path]" >&2; exit 2; }
case "$VERSION" in v*) ;; *) VERSION="v$VERSION";; esac
command -v tar >/dev/null 2>&1 || { echo "tar is required" >&2; exit 1; }
TMP="\$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
if [ -n "$ARCHIVE" ]; then
  [ -f "$ARCHIVE" ] || { echo "Archive not found: $ARCHIVE" >&2; exit 1; }
else
  command -v curl >/dev/null 2>&1 || { echo "curl is required" >&2; exit 1; }
  NAME="qq-guardian-\${VERSION}-linux-x64.tar.gz"
  BASE="https://github.com/\$REPO/releases/download/\$VERSION"
  curl -fsSL "\$BASE/\$NAME" -o "\$TMP/\$NAME"
  curl -fsSL "\$BASE/\$NAME.sha256" -o "\$TMP/\$NAME.sha256"
  (cd "\$TMP" && sha256sum -c "\$NAME.sha256")
  ARCHIVE="\$TMP/\$NAME"
fi
tar -xzf "\$ARCHIVE" -C "\$TMP"
NEW="\$(find "\$TMP" -maxdepth 1 -type d -name 'qq-guardian-v*' | head -n1)"
[ -n "\$NEW" ] || { echo "Invalid update archive" >&2; exit 1; }
MANIFEST_VERSION="\$(sed -n 's/.*"version": "([^"]*)".*/\\1/p' "\$NEW/RELEASE-MANIFEST.json" | head -n1)"
[ -n "\$MANIFEST_VERSION" ] || { echo "Missing release version" >&2; exit 1; }
TARGET="\$PREFIX/releases/v\$MANIFEST_VERSION"
mkdir -p "\$PREFIX/releases" "\$PREFIX/data" "\$PREFIX/config" "\$PREFIX/logs"
rm -rf "\$TARGET"
cp -a "\$NEW" "\$TARGET"
rm -rf "\$TARGET/data" "\$TARGET/config" "\$TARGET/logs"
ln -s "\$PREFIX/data" "\$TARGET/data"
ln -s "\$PREFIX/config" "\$TARGET/config"
ln -s "\$PREFIX/logs" "\$TARGET/logs"
ln -sfn "\$TARGET" "\$PREFIX/current"
"\$PREFIX/current/verify.sh"
echo "Updated qq-guardian to \$VERSION at \$PREFIX/current"
\`;
}
function linuxInstaller() {
  return String.raw\`#!/bin/sh
set -eu
PREFIX="\${PREFIX:-$HOME/.local/opt/qq-guardian}"
YES=0
[ "\${1:-}" = "--yes" ] && YES=1
[ "\${QQ_GUARDIAN_NON_INTERACTIVE:-0}" = "1" ] && YES=1
BASE="\$(CDPATH= cd -- "\$(dirname -- "\$0")" && pwd)"
VERSION="\$(sed -n 's/.*"version": "([^"]*)".*/\\1/p' "\$BASE/RELEASE-MANIFEST.json" | head -n1)"
[ -n "\$VERSION" ] || { echo "Missing release version" >&2; exit 1; }
VERSION="v\$VERSION"
if [ "\$YES" -ne 1 ] && [ -t 0 ]; then
  printf 'Install qq-guardian %s at %s? [y/N] ' "\$VERSION" "\$PREFIX"
  read -r answer
  case "\$answer" in y|Y|yes|YES) ;; *) echo "Installation cancelled."; exit 1;; esac
elif [ "\$YES" -ne 1 ]; then
  echo "Non-interactive install requires --yes or QQ_GUARDIAN_NON_INTERACTIVE=1." >&2
  exit 2
fi
mkdir -p "\$PREFIX/releases" "\$PREFIX/data" "\$PREFIX/config" "\$PREFIX/logs"
TARGET="\$PREFIX/releases/\$VERSION"
rm -rf "\$TARGET"
cp -a "\$BASE"/. "\$TARGET"/
rm -rf "\$TARGET/data" "\$TARGET/config" "\$TARGET/logs"
ln -s "\$PREFIX/data" "\$TARGET/data"
ln -s "\$PREFIX/config" "\$TARGET/config"
ln -s "\$PREFIX/logs" "\$TARGET/logs"
ln -sfn "\$TARGET" "\$PREFIX/current"
"\$PREFIX/current/verify.sh"
echo "Installed qq-guardian \$VERSION at \$PREFIX/current"
echo "Start: \$PREFIX/current/launcher.sh"
\`;
}
function linuxVerify() {
  return String.raw`#!/bin/sh
set -eu
ROOT="\${1:-$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)}"
for f in launcher.sh app/index.mjs runtime/node/bin/node RELEASE-MANIFEST.json; do [ -e "$ROOT/$f" ] || { echo "Missing $f" >&2; exit 1; }; done
"$ROOT/runtime/node/bin/node" "$ROOT/app/index.mjs" --version >/dev/null 2>&1 || true
echo "qq-guardian package layout verified: $ROOT"
`;
}
function linuxRollback() {
  return String.raw\`#!/bin/sh
set -eu
PREFIX="\${QQ_GUARDIAN_PREFIX:-$HOME/.local/opt/qq-guardian}"
RELEASES="\$PREFIX/releases"
[ -d "\$RELEASES" ] || { echo "No versioned releases found." >&2; exit 1; }
CURRENT="\$(readlink -f "\$PREFIX/current" 2>/dev/null || true)"
PREVIOUS="\$(find "\$RELEASES" -mindepth 1 -maxdepth 1 -type d | sort | while read -r candidate; do
  [ "\$candidate" = "\$CURRENT" ] || { echo "\$candidate"; break; }
done)"
[ -n "\$PREVIOUS" ] || { echo "No previous package is available." >&2; exit 1; }
ln -sfn "\$PREVIOUS" "\$PREFIX/current"
"\$PREFIX/current/verify.sh"
echo "Rolled back to \$(basename "\$PREVIOUS")."
\`;
}
function systemdUnit() {
  return String.raw`[Unit]
Description=QQ Guardian
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
ExecStart=%h/.local/opt/qq-guardian/current/launcher.sh
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=%h/.local/opt/qq-guardian/data %h/.local/opt/qq-guardian/config %h/.local/opt/qq-guardian/logs
[Install]
WantedBy=default.target
`;
}
function winUpdater() {
  return String.raw`param([Parameter(Mandatory=$true)][string]$Archive)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$tmp = Join-Path $root '.update-tmp'
if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
Expand-Archive -LiteralPath $Archive -DestinationPath $tmp -Force
$new = Get-ChildItem $tmp -Directory | Select-Object -First 1
if (-not $new) { throw 'Invalid update archive' }
foreach ($name in @('data','config','logs')) {
  $old = Join-Path $root $name; $dest = Join-Path $new.FullName $name
  if (Test-Path $old) { Remove-Item $dest -Recurse -Force -ErrorAction SilentlyContinue; Copy-Item $old $dest -Recurse -Force }
}
$previous = "$root.previous"
if (Test-Path $previous) { Remove-Item $previous -Recurse -Force }
Copy-Item $root $previous -Recurse -Force
Get-ChildItem $new.FullName | ForEach-Object { Copy-Item $_.FullName $root -Recurse -Force }
Remove-Item $tmp -Recurse -Force
Write-Host 'Update completed; data, configuration, and logs were preserved.'
`;
}
function winInstaller() {
  return String.raw`$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSCommandPath
Write-Host "QQ Guardian package is self-contained. Run launcher.bat to start."
Write-Host "Persistent state is stored in data, configuration in config, logs in logs."
`;
}
function winVerify() {
  return String.raw`$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSCommandPath
foreach ($f in @('launcher.bat','app\\index.mjs','runtime\\node\\node.exe','RELEASE-MANIFEST.json')) { if (-not (Test-Path (Join-Path $root $f))) { throw "Missing $f" } }
Write-Host "qq-guardian package layout verified: $root"
`;
}
function winUninstall() {
  return String.raw`param([switch]$Purge)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSCommandPath
if ($Purge) { Remove-Item $root -Recurse -Force; Write-Host 'Removed application and persistent state.' }
else { Write-Host 'Windows portable package: delete application files to uninstall. Data/config/logs are not removed automatically.' }
`;
}
