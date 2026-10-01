$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSCommandPath
& (Join-Path $Root 'verify.ps1')
Write-Host 'Portable Windows package is ready. Run launcher.bat.'
