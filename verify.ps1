$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSCommandPath
foreach ($f in @('launcher.bat','runtime\node\node.exe','app\index.mjs','config\.env.example','logs\.gitkeep','RELEASE-MANIFEST.json')) {
  if (-not (Test-Path (Join-Path $Root $f))) { throw "Missing $f" }
}
Write-Host "QQ Guardian production package verified: $Root"
