param([switch]$Purge)
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSCommandPath
if ($Purge) { Remove-Item $Root -Recurse -Force; Write-Host 'Removed application and persistent state.' }
else { Write-Host 'Portable Windows package: application files may be removed manually; data/config/logs are preserved until explicitly deleted.' }
