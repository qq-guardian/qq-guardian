[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$SnowLumaRoot,

  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$GuardianRuntime,

  [string]$EnvironmentFile = ''
)

$ErrorActionPreference = 'Stop'
$snowRoot = (Resolve-Path -LiteralPath $SnowLumaRoot -ErrorAction Stop).Path
$guardianRuntimePath = (Resolve-Path -LiteralPath $GuardianRuntime -ErrorAction Stop).Path

foreach ($required in @('launcher.bat', 'index.mjs')) {
  if (-not (Test-Path -LiteralPath (Join-Path $snowRoot $required) -PathType Leaf)) {
    throw "Official SnowLuma $required was not found under $snowRoot"
  }
}
if (-not (Test-Path -LiteralPath $guardianRuntimePath -PathType Leaf)) {
  throw "Guardian runtime was not found: $guardianRuntimePath"
}

function Import-GuardianEnvironment {
  param([string]$Path)
  if (-not $Path) { return }
  foreach ($line in Get-Content -LiteralPath $Path) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith('#')) { continue }
    $separator = $line.IndexOf('=')
    if ($separator -le 0) { throw "Invalid environment line in $Path" }
    $name = $line.Substring(0, $separator).Trim()
    if ($name -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') {
      throw "Invalid environment variable name: $name"
    }
    [Environment]::SetEnvironmentVariable($name, $line.Substring($separator + 1), 'Process')
  }
}

Import-GuardianEnvironment -Path $EnvironmentFile

if (-not $env:SNOWLUMA_ACCEPT_EULA) { $env:SNOWLUMA_ACCEPT_EULA = '1' }
if (-not $env:SNOWLUMA_ACCEPT_PRIVACY) { $env:SNOWLUMA_ACCEPT_PRIVACY = '1' }

$node = Get-Command node -ErrorAction SilentlyContinue
if ($null -eq $node) {
  throw 'Node.js >=22.13.0 is required for Guardian lite mode.'
}

$snowProcess = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', 'launcher.bat' -WorkingDirectory $snowRoot -PassThru
try {
  & $node.Source -- $guardianRuntimePath
  $guardianExit = $LASTEXITCODE
}
finally {
  if (-not $snowProcess.HasExited) {
    Stop-Process -Id $snowProcess.Id -Force -ErrorAction SilentlyContinue
  }
}
exit $guardianExit
