[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$EnvironmentFile,

    [Parameter(Mandatory = $true)]
    [string]$RuntimeFile
)

$ErrorActionPreference = 'Stop'

$node = Get-Command node -ErrorAction SilentlyContinue
if ($null -eq $node) {
    throw 'Node.js >=22.6.0 is required on PATH for Guardian. Install it for the service account, then retry.'
}

foreach ($line in Get-Content -LiteralPath $EnvironmentFile) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith('#')) { continue }
    $parts = $trimmed.Split('=', 2)
    if ($parts.Count -ne 2 -or -not $parts[0]) {
        throw "Invalid environment line: $line"
    }
    $name = $parts[0].Trim()
    if ($name -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') {
        throw "Invalid environment variable name: $name"
    }
    [Environment]::SetEnvironmentVariable($name, $parts[1], 'Process')
}

& $node.Source -- $RuntimeFile
exit $LASTEXITCODE
