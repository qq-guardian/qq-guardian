[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string]$EnvironmentFile
)

$ErrorActionPreference = 'Stop'

$rootPath = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$nodePath = Join-Path $rootPath 'runtime\node\node.exe'
$entryPath = Join-Path $rootPath 'dist-snowluma\index.mjs'
$environmentRequired = $PSBoundParameters.ContainsKey('EnvironmentFile')

if (-not $environmentRequired -and -not [string]::IsNullOrWhiteSpace($env:QQ_GUARDIAN_ENV_FILE)) {
    $EnvironmentFile = $env:QQ_GUARDIAN_ENV_FILE
    $environmentRequired = $true
}
if ([string]::IsNullOrWhiteSpace($EnvironmentFile)) {
    $EnvironmentFile = Join-Path $PSScriptRoot 'guardian.env'
}

if (Test-Path -LiteralPath $EnvironmentFile -PathType Leaf) {
    foreach ($line in Get-Content -LiteralPath $EnvironmentFile) {
        $trimmed = $line.Trim()
        if (-not $trimmed -or $trimmed.StartsWith('#')) { continue }
        $separator = $line.IndexOf('=')
        if ($separator -le 0) {
            throw "Invalid environment line in ${EnvironmentFile}: $line"
        }
        $name = $line.Substring(0, $separator).Trim()
        if ($name -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') {
            throw "Invalid environment variable name in ${EnvironmentFile}: $name"
        }
        [Environment]::SetEnvironmentVariable($name, $line.Substring($separator + 1), 'Process')
    }
} elseif ($environmentRequired) {
    throw "Guardian environment file not found: $EnvironmentFile"
}

if (-not (Test-Path -LiteralPath $nodePath -PathType Leaf)) {
  throw "Bundled Node.js runtime not found for this platform: $nodePath. Use the matching full archive, or run start-guardian.ps1 with an installed Node.js runtime."
}

& $nodePath -- $entryPath
exit $LASTEXITCODE
