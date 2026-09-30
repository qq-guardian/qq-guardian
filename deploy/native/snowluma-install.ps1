[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$OfficialPackage,
  [string]$InstallRoot="$env:ProgramData\QQGuardian\SnowLuma",
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
$checksumLine=(Get-Content -Raw -LiteralPath (Join-Path $scriptDir 'official-snowluma.sha256')).Trim()
$expectedSha=($checksumLine -split '\s+')[0]
$expectedFile=($checksumLine -split '\s+',2)[1]
$expectedSize=[int64](Get-Content -Raw -LiteralPath (Join-Path $scriptDir 'official-snowluma.size')).Trim()
$package=(Resolve-Path -LiteralPath $OfficialPackage -ErrorAction Stop).Path

if((Split-Path -Leaf $package)-ne$expectedFile){throw "Official asset filename mismatch. Expected $expectedFile."}
if((Get-Item -LiteralPath $package).Length-ne$expectedSize){throw 'Official SnowLuma size mismatch.'}
if((Get-FileHash -Algorithm SHA256 -LiteralPath $package).Hash.ToLowerInvariant() -ne $expectedSha){throw 'Official SnowLuma SHA-256 mismatch.'}

$install=(Join-Path ([IO.Path]::GetFullPath($InstallRoot)) '')
$guardianRoot=Join-Path $install 'qq-guardian'
$tmp=Join-Path ([IO.Path]::GetTempPath()) ('qqg-'+[guid]::NewGuid().ToString('N'))

if((Test-Path -LiteralPath $install) -and -not $Force){
  $existing=Get-ChildItem -LiteralPath $install -Force -ErrorAction SilentlyContinue
  if($existing){throw "Install root is not empty: $install. Use -Force to replace it."}
}

New-Item -ItemType Directory -Force -Path $install,$tmp,$guardianRoot,(Split-Path $EnvironmentFile) | Out-Null

try{
  Expand-Archive -LiteralPath $package -DestinationPath $tmp -Force

  foreach($file in @(
    'launcher.bat',
    'node.exe',
    'index.mjs',
    'package.json',
    'EULA.md',
    'PRIVACY.md',
    'native\snowluma-win32-x64.dll',
    'native\snowluma-win32-x64.node',
    'native\websocket-win32-x64.node',
    'native\ffmpeg\ffmpegAddon.win32.x64.node'
  )){
    if(!(Test-Path -LiteralPath (Join-Path $tmp $file) -PathType Leaf)){
      throw "Official SnowLuma archive missing $file"
    }
  }

  Get-ChildItem -LiteralPath $tmp -Force | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination $install -Recurse -Force
  }

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
  $actionArg='-NoProfile -ExecutionPolicy Bypass -File "'+$startScript+'" -SnowLumaRoot "'+$install+'" -GuardianRoot "'+$guardianRoot+'" -EnvironmentFile "'+$EnvironmentFile+'"'
  $action=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $actionArg -WorkingDirectory $guardianRoot
  $trigger=New-ScheduledTaskTrigger -AtLogOn -User $RunAsUser
  $principal=New-ScheduledTaskPrincipal -UserId $RunAsUser -LogonType Interactive -RunLevel Highest
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Force | Out-Null

  if($Unattended){
    Start-ScheduledTask -TaskName $taskName
    Write-Host "Installed official SnowLuma $expectedFile and started '$taskName'."
  }else{
    Write-Host "Installed official SnowLuma $expectedFile and registered '$taskName'."
    Write-Host "Start manually with: Start-ScheduledTask -TaskName '$taskName'"
  }
}finally{
  Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
