[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$ServiceIdentity,

    [string]$StateRoot = 'C:\ProgramData\QQGuardian',

    [string]$EnvironmentFile
)

$ErrorActionPreference = 'Stop'

$rootPath = [System.IO.Path]::GetFullPath($StateRoot)
if (-not $EnvironmentFile) {
    $EnvironmentFile = Join-Path $rootPath 'guardian.env'
}
$environmentPath = [System.IO.Path]::GetFullPath($EnvironmentFile)
$rootPrefix = "$rootPath$([System.IO.Path]::DirectorySeparatorChar)"
if (-not $environmentPath.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'EnvironmentFile must be located inside StateRoot so the same private ACL protects it.'
}

$dataPath = Join-Path $rootPath 'data'
$configPath = Join-Path $rootPath 'config'
foreach ($path in @($rootPath, $dataPath, $configPath)) {
    New-Item -ItemType Directory -Force -Path $path | Out-Null
}
if (-not (Test-Path -LiteralPath $environmentPath)) {
    New-Item -ItemType File -Force -Path $environmentPath | Out-Null
}

function Set-GuardianPrivateAcl {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,

        [switch]$Recursive
    )

    $aclArguments = @(
        $Path,
        '/inheritance:r',
        '/grant:r',
        "${ServiceIdentity}:(OI)(CI)F",
        '*S-1-5-18:(OI)(CI)F',
        '*S-1-5-32-544:(OI)(CI)F'
    )
    if ($Recursive) { $aclArguments += '/T' }
    $aclArguments += '/C'
    & icacls.exe @aclArguments | Out-Host
    if ($LASTEXITCODE -ne 0) {
        throw "icacls failed while securing $Path (exit $LASTEXITCODE)"
    }
}

# Disable inherited ProgramData access and grant only the identity that runs
# Guardian plus Windows recovery principals. /T also repairs ACLs on existing
# config, SQLite, journal, backup, and bootstrap files before an upgrade.
Set-GuardianPrivateAcl -Path $rootPath -Recursive

# A file does not need inheritance flags, and an explicit final pass ensures
# the environment file retains no broad inherited reader after a restore.
& icacls.exe $environmentPath /inheritance:r /grant:r "${ServiceIdentity}:F" '*S-1-5-18:F' '*S-1-5-32-544:F' /C | Out-Host
if ($LASTEXITCODE -ne 0) {
    throw "icacls failed while securing $environmentPath (exit $LASTEXITCODE)"
}

Write-Host "Guardian state and environment file are restricted to $ServiceIdentity, SYSTEM, and Administrators."
