param([Parameter(Mandatory=$true)][string]$ReleasePath)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path $ReleasePath)) { throw "Release path not found: $ReleasePath" }
Write-Host "Windows portable packages are rolled back by replacing the application directory with a previously verified archive."
Write-Host "Verify the replacement with verify.ps1 before starting launcher.bat."
