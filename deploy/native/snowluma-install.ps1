[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$SnowLumaRoot,
  [string]$OfficialPackage,
  [string]$EnvironmentFile="$env:ProgramData\QQGuardian\guardian.env",
  [string]$RunAsUser="$env:USERNAME",
  [switch]$AcceptEula,
  [switch]$AcceptPrivacy,
  [switch]$Unattended,
  [switch]$Force
)

$ErrorActionPreference='Stop'
if($Unattended -and (-not $AcceptEula -or -not $AcceptPrivacy)){
  throw 'Unattended mode requires -AcceptEula and -AcceptPrivacy.'
}

$scriptDir=(Resolve-Path -LiteralPath $PSScriptRoot).Path
$bundleRoot=(Resolve-Path -LiteralPath (Join-Path $scriptDir '..\..')).Path
$snowRoot=(Resolve-Path -LiteralPath $SnowLumaRoot -ErrorAction Stop).Path

if($OfficialPackage){
  $checksumLine=(Get-Content -Raw -LiteralPath (Join-Path $scriptDir 'official-snowluma.sha256')).Trim()
  $expectedSha=($checksumLine -split '\s+')[0]
  $expectedFile=($checksumLine -split '\s+',2)[1]
  $expectedSize=[int64](Get-Content -Raw -LiteralPath (Join-Path $scriptDir 'official-snowluma.size')).Trim()
  $package=(Resolve-Path -LiteralPath $OfficialPackage -ErrorAction Stop).Path

  if((Split-Path -Leaf $package)-ne$expectedFile){throw "Official asset filename mismatch. Expected $expectedFile."}
  if((Get-Item -LiteralPath $package).Length-ne$expectedSize){throw 'Official SnowLuma size mismatch.'}
  if((Get-FileHash -Algorithm SHA256 -LiteralPath $package).Hash.ToLowerInvariant() -ne $expectedSha){throw 'Official SnowLuma SHA-256 mismatch.'}
  Write-Host '✓ official SnowLuma archive verified; installer will not extract or copy it.'
}

foreach($file in @(
  'launcher.bat',
  'node.exe',
  'index.mjs',
  'EULA.md',
  'PRIVACY.md',
  'native\snowluma-win32-x64.dll',
  'native\snowluma-win32-x64.node',
  'native\websocket-win32-x64.node',
  'native\ffmpeg\ffmpegAddon.win32.x64.node'
)){
  if(!(Test-Path -LiteralPath (Join-Path $snowRoot $file) -PathType Leaf)){
    throw "Official SnowLuma installation missing $file"
  }
}

$guardianRoot=Join-Path $snowRoot 'qq-guardian'
if((Test-Path -LiteralPath $guardianRoot) -and -not $Force){
  throw "Guardian overlay already exists: $guardianRoot. Use -Force to replace it."
}
New-Item -ItemType Directory -Force -Path $guardianRoot,(Split-Path $EnvironmentFile) | Out-Null
Remove-Item -LiteralPath (Join-Path $guardianRoot 'dist-snowluma') -Recurse -Force -ErrorAction SilentlyContinue
Copy-Item -LiteralPath (Join-Path $bundleRoot 'dist-snowluma') -Destination $guardianRoot -Recurse -Force
Copy-Item -LiteralPath (Join-Path $bundleRoot 'deploy\native\start-snowluma-guardian.ps1') -Destination (Join-Path $guardianRoot 'start-snowluma-guardian.ps1') -Force

$dataRoot=Join-Path $env:ProgramData 'QQGuardian\data'
$configRoot=Join-Path $env:ProgramData 'QQGuardian\config'
New-Item -ItemType Directory -Force -Path $dataRoot,$configRoot | Out-Null

if(!(Test-Path -LiteralPath $EnvironmentFile)){
  @(
    "SNOWLUMA_ACCEPT_EULA=$([int]$AcceptEula.IsPresent)",
    "SNOWLUMA_ACCEPT_PRIVACY=$([int]$AcceptPrivacy.IsPresent)",
    'SNOWLUMA_WS_URL=ws://127.0.0.1:3001/',
    'QQ_GUARDIAN_HTTP_HOST=127.0.0.1',
    'QQ_GUARDIAN_HTTP_PORT=6099',
    "QQ_GUARDIAN_DATA_DIR=$dataRoot",
    "QQ_GUARDIAN_CONFIG_DIR=$configRoot"
  ) | Set-Content -LiteralPath $EnvironmentFile -Encoding utf8
}

$taskName='QQ Guardian + SnowLuma'
$startScript=Join-Path $guardianRoot 'start-snowluma-guardian.ps1'
$actionArg='-NoProfile -ExecutionPolicy Bypass -File "'+$startScript+'" -SnowLumaRoot "'+$snowRoot+'" -GuardianRoot "'+$guardianRoot+'" -EnvironmentFile "'+$EnvironmentFile+'"'
$action=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $actionArg -WorkingDirectory $guardianRoot
$trigger=New-ScheduledTaskTrigger -AtLogOn -User $RunAsUser
$principal=New-ScheduledTaskPrincipal -UserId $RunAsUser -LogonType Interactive -RunLevel Highest
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Force | Out-Null

if($Unattended){
  Start-ScheduledTask -TaskName $taskName
  Write-Host 'Guardian integration installed and started against the existing official SnowLuma installation.'
}else{
  Write-Host "Guardian integration installed and registered '$taskName'."
  Write-Host "Start manually with: Start-ScheduledTask -TaskName '$taskName'"
}
