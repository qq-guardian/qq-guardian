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

if (!['win-x64', 'linux-x64', 'linux-arm64'].includes(requested)) throw new Error(`Unsupported platform: ${requested}`);
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
  source: 'provided-runtime',
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

const install = requested.startsWith('linux-') ? linuxInstaller() : winInstaller();
if (requested.startsWith('linux-')) writeFileSync(join(stage, 'install.sh'), install, { mode: 0o755 });
else writeFileSync(join(stage, 'install.ps1'), install);

writeFileSync(join(stage, requested === 'win-x64' ? 'verify.ps1' : 'verify.sh'), requested === 'win-x64' ? winVerify() : linuxVerify(), { mode: requested === 'win-x64' ? 0o644 : 0o755 });
writeFileSync(join(stage, requested === 'win-x64' ? 'uninstall.ps1' : 'uninstall.sh'), requested === 'win-x64' ? winUninstall() : linuxUninstall(), { mode: requested === 'win-x64' ? 0o644 : 0o755 });
writeFileSync(join(stage, requested === 'win-x64' ? 'rollback.ps1' : 'rollback.sh'), requested === 'win-x64' ? winRollback() : linuxRollback(), { mode: requested === 'win-x64' ? 0o644 : 0o755 });
if (requested.startsWith('linux-')) {
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
  : `qq-guardian-v${pkg.version}-${requested}.tar.gz`);
if (requested === 'win-x64') writeDeterministicZip({ outputPath: archive, entries });
else writeDeterministicTarGzip({ outputPath: archive, entries });
const sidecar = writeSha256Sidecar(archive);
console.log(`✓ ${relative(ROOT, archive)} ${statSync(archive).size} bytes ${sidecar.digest}`);

function arg(name) { return process.argv.find(a => a.startsWith(name + '='))?.slice(name.length + 1); }
function detectPlatform() {
  if (process.platform === 'win32' && process.arch === 'x64') return 'win-x64';
  if (process.platform === 'linux' && process.arch === 'x64') return 'linux-x64';
  if (process.platform === 'linux' && process.arch === 'arm64') return 'linux-arm64';
  throw new Error('Supported hosts: Windows x64, Linux x64, or Linux arm64');
}
function linuxUpdater() {
  return String.raw`#!/bin/sh
set -eu
PREFIX="\${QQ_GUARDIAN_PREFIX:-$HOME/.local/opt/qq-guardian}"
ARCHIVE="\${1:-}"
[ -n "$ARCHIVE" ] || { echo "Usage: ./update.sh /path/to/qq-guardian-vX.Y.Z-linux-x64.tar.gz" >&2; exit 2; }
[ -f "$ARCHIVE" ] || { echo "Archive not found: $ARCHIVE" >&2; exit 1; }
command -v tar >/dev/null 2>&1 || { echo "tar is required" >&2; exit 1; }
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
tar -xzf "$ARCHIVE" -C "$TMP"
NEW="$(find "$TMP" -maxdepth 1 -type d -name 'qq-guardian-v*' | head -n1)"
[ -n "$NEW" ] || { echo "Invalid update archive" >&2; exit 1; }
MANIFEST_VERSION="$(sed -n 's/.*"version": "([^"]*)".*/\\1/p' "$NEW/RELEASE-MANIFEST.json" | head -n1)"
[ -n "$MANIFEST_VERSION" ] || { echo "Missing release version" >&2; exit 1; }
VERSION="v$MANIFEST_VERSION"
TARGET="$PREFIX/releases/$VERSION"
mkdir -p "$PREFIX/releases" "$PREFIX/data" "$PREFIX/config" "$PREFIX/logs"
rm -rf "$TARGET"
cp -a "$NEW"/. "$TARGET"/
rm -rf "$TARGET/data" "$TARGET/config" "$TARGET/logs"
ln -s "$PREFIX/data" "$TARGET/data"
ln -s "$PREFIX/config" "$TARGET/config"
ln -s "$PREFIX/logs" "$TARGET/logs"
ln -sfn "$TARGET" "$PREFIX/current"
"$PREFIX/current/verify.sh"
echo "Updated qq-guardian to $VERSION at $PREFIX/current"
`;
}
function linuxInstaller() {
  return String.raw`#!/bin/sh
set -eu
PREFIX="\${PREFIX:-$HOME/.local/opt/qq-guardian}"
YES=0
[ "\${1:-}" = "--yes" ] && YES=1
[ "\${QQ_GUARDIAN_NON_INTERACTIVE:-0}" = "1" ] && YES=1
BASE="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
VERSION="$(sed -n 's/.*"version": "([^"]*)".*/\\1/p' "$BASE/RELEASE-MANIFEST.json" | head -n1)"
[ -n "$VERSION" ] || { echo "Missing release version" >&2; exit 1; }
VERSION="v$VERSION"
if [ "$YES" -ne 1 ] && [ -t 0 ]; then
  printf 'Install qq-guardian %s at %s? [y/N] ' "$VERSION" "$PREFIX"
  read -r answer
  case "$answer" in y|Y|yes|YES) ;; *) echo "Installation cancelled."; exit 1;; esac
elif [ "$YES" -ne 1 ]; then
  echo "Non-interactive install requires --yes or QQ_GUARDIAN_NON_INTERACTIVE=1." >&2
  exit 2
fi
mkdir -p "$PREFIX/releases" "$PREFIX/data" "$PREFIX/config" "$PREFIX/logs"
TARGET="$PREFIX/releases/$VERSION"
rm -rf "$TARGET"
cp -a "$BASE"/. "$TARGET"/
rm -rf "$TARGET/data" "$TARGET/config" "$TARGET/logs"
ln -s "$PREFIX/data" "$TARGET/data"
ln -s "$PREFIX/config" "$TARGET/config"
ln -s "$PREFIX/logs" "$TARGET/logs"
ln -sfn "$TARGET" "$PREFIX/current"
"$PREFIX/current/verify.sh"
echo "Installed qq-guardian $VERSION at $PREFIX/current"
echo "Run: $PREFIX/current/launcher.sh"
`;
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
function linuxUninstall() {
  return String.raw`#!/bin/sh
set -eu
PREFIX="\${PREFIX:-$HOME/.local/opt/qq-guardian}"
if [ "\${1:-}" = "--purge" ]; then rm -rf "$PREFIX"; echo "Removed application and persistent data."; exit 0; fi
rm -rf "$PREFIX/releases" "$PREFIX/current" "$PREFIX/.update-tmp"
echo "Removed application versions. Persistent data/config/logs were retained at $PREFIX/data, $PREFIX/config, and $PREFIX/logs."
`;
}
function linuxRollback() {
  return String.raw`#!/bin/sh
set -eu
PREFIX="\${QQ_GUARDIAN_PREFIX:-$HOME/.local/opt/qq-guardian}"
RELEASES="$PREFIX/releases"
[ -d "$RELEASES" ] || { echo "No versioned releases found." >&2; exit 1; }
CURRENT="$(readlink -f "$PREFIX/current" 2>/dev/null || true)"
PREVIOUS="$(find "$RELEASES" -mindepth 1 -maxdepth 1 -type d | sort -Vr | while read -r candidate; do
  [ "$candidate" = "$CURRENT" ] || { echo "$candidate"; break; }
done)"
[ -n "$PREVIOUS" ] || { echo "No previous package is available." >&2; exit 1; }
ln -sfn "$PREVIOUS" "$PREFIX/current"
"$PREFIX/current/verify.sh"
echo "Rolled back to $(basename "$PREVIOUS")."
`;
}
function winRollback() {
  return String.raw`param([string]$Prefix="$env:LOCALAPPDATA\\QQGuardian")
$ErrorActionPreference='Stop'
$releases=Join-Path $Prefix 'releases'
if(-not(Test-Path $releases)){throw 'No versioned releases found.'}
$current=Join-Path $Prefix 'current'
$currentTarget=''
if(Test-Path $current){
  $currentTarget=(Get-Item $current).Target
}
$previous=Get-ChildItem $releases -Directory |
  Sort-Object { [version]$_.Name.TrimStart('v') } -Descending |
  Where-Object { $_.FullName -ne $currentTarget } |
  Select-Object -First 1
if(-not $previous){throw 'No previous package is available.'}
if(Test-Path $current){Remove-Item $current -Force}
New-Item -ItemType Junction -Path $current -Target $previous.FullName | Out-Null
& (Join-Path $current 'verify.ps1')
Write-Host "Rolled back to $($previous.Name)."
`;
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
  return String.raw`param([Parameter(Mandatory=$true)][string]$Archive,[string]$Prefix="$env:LOCALAPPDATA\\QQGuardian")
$ErrorActionPreference='Stop'
if(-not(Test-Path $Archive)){throw "Archive not found: $Archive"}
$tmp=Join-Path $env:TEMP ("qq-guardian-update-"+[guid]::NewGuid())
New-Item -ItemType Directory -Path $tmp | Out-Null
try{
  Expand-Archive -LiteralPath $Archive -DestinationPath $tmp -Force
  $new=Get-ChildItem $tmp -Directory | Select-Object -First 1
  if(-not $new){throw 'Invalid update archive'}
  $manifest=Get-Content (Join-Path $new.FullName 'RELEASE-MANIFEST.json') -Raw | ConvertFrom-Json
  $version='v'+$manifest.version
  $releases=Join-Path $Prefix 'releases'
  $target=Join-Path $releases $version
  New-Item -ItemType Directory -Force -Path $releases,(Join-Path $Prefix 'data'),(Join-Path $Prefix 'config'),(Join-Path $Prefix 'logs') | Out-Null
  if(Test-Path $target){Remove-Item $target -Recurse -Force}
  Copy-Item $new.FullName $target -Recurse -Force
  foreach($name in @('data','config','logs')){
    $dest=Join-Path $target $name
    if(Test-Path $dest){Remove-Item $dest -Recurse -Force}
    New-Item -ItemType Junction -Path $dest -Target (Join-Path $Prefix $name) | Out-Null
  }
  $current=Join-Path $Prefix 'current'
  if(Test-Path $current){Remove-Item $current -Force}
  New-Item -ItemType Junction -Path $current -Target $target | Out-Null
  & (Join-Path $current 'verify.ps1')
  Write-Host "Updated QQ Guardian to $version at $current"
}finally{
  if(Test-Path $tmp){Remove-Item $tmp -Recurse -Force}
}
`;
}
function winInstaller() {
  return String.raw`param([switch]$Yes,[string]$Prefix="$env:LOCALAPPDATA\\QQGuardian")
$ErrorActionPreference='Stop'
if(-not $Yes -and $env:QQ_GUARDIAN_NON_INTERACTIVE -ne '1'){throw 'Non-interactive install requires -Yes or QQ_GUARDIAN_NON_INTERACTIVE=1.'}
$base=Split-Path -Parent $PSCommandPath
$manifest=Get-Content (Join-Path $base 'RELEASE-MANIFEST.json') -Raw | ConvertFrom-Json
$version='v'+$manifest.version
$releases=Join-Path $Prefix 'releases'
$target=Join-Path $releases $version
New-Item -ItemType Directory -Force -Path $releases,(Join-Path $Prefix 'data'),(Join-Path $Prefix 'config'),(Join-Path $Prefix 'logs') | Out-Null
if(Test-Path $target){Remove-Item $target -Recurse -Force}
Copy-Item $base $target -Recurse -Force
foreach($name in @('data','config','logs')){
  $dest=Join-Path $target $name
  if(Test-Path $dest){Remove-Item $dest -Recurse -Force}
  New-Item -ItemType Junction -Path $dest -Target (Join-Path $Prefix $name) | Out-Null
}
$current=Join-Path $Prefix 'current'
if(Test-Path $current){Remove-Item $current -Force}
New-Item -ItemType Junction -Path $current -Target $target | Out-Null
if($env:QQ_GUARDIAN_AUTO_START -ne 'false'){
  $taskName='QQ Guardian'
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  $action=New-ScheduledTaskAction -Execute 'cmd.exe' -Argument ('/c ""'+(Join-Path $current 'launcher.bat')+'""')
  $trigger=New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $principal=New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal | Out-Null
}
& (Join-Path $current 'verify.ps1')
Write-Host "Installed QQ Guardian $version at $current"
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
  return String.raw`param([switch]$Purge,[string]$Prefix="$env:LOCALAPPDATA\\QQGuardian")
$ErrorActionPreference='Stop'
Unregister-ScheduledTask -TaskName 'QQ Guardian' -Confirm:$false -ErrorAction SilentlyContinue
if($Purge){
  if(Test-Path $Prefix){Remove-Item $Prefix -Recurse -Force}
  Write-Host 'Removed QQ Guardian, configuration, logs, and data.'
  exit 0
}
$releases=Join-Path $Prefix 'releases'
$current=Join-Path $Prefix 'current'
if(Test-Path $current){Remove-Item $current -Force}
if(Test-Path $releases){Remove-Item $releases -Recurse -Force}
Write-Host "Removed QQ Guardian application versions. Preserved: $(Join-Path $Prefix 'data'), $(Join-Path $Prefix 'config'), $(Join-Path $Prefix 'logs')"
`;
}

