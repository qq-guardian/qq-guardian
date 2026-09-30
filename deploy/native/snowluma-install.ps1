[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$OfficialPackage,[string]$InstallRoot="$env:ProgramData\QQGuardian\SnowLuma",[switch]$AcceptEula,[switch]$AcceptPrivacy,[switch]$Unattended)
$ErrorActionPreference='Stop'
if($Unattended -and (-not $AcceptEula -or -not $AcceptPrivacy)){throw 'Unattended mode requires -AcceptEula and -AcceptPrivacy.'}
$manifest=Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot '..\..\UPSTREAM-SNOWLUMA.json')|ConvertFrom-Json
$a=$manifest.platforms.'win-x64'.full
$package=(Resolve-Path -LiteralPath $OfficialPackage -ErrorAction Stop).Path
if((Split-Path $package -Leaf)-ne$a.file){throw 'Official asset name mismatch.'}
if((Get-Item $package).Length -ne [int64]$a.size){throw 'Official SnowLuma size mismatch.'}
if((Get-FileHash -Algorithm SHA256 $package).Hash.ToLowerInvariant() -ne $a.sha256){throw 'Official SnowLuma SHA-256 mismatch.'}
$root=[IO.Path]::GetFullPath($InstallRoot);$tmp=Join-Path ([IO.Path]::GetTempPath())('qqg-'+[guid]::NewGuid().ToString('N'));New-Item -ItemType Directory -Force $root,$tmp|Out-Null
try{
Expand-Archive $package $tmp -Force
if(!(Test-Path (Join-Path $tmp 'launcher.bat'))-or !(Test-Path (Join-Path $tmp 'node.exe'))){throw 'Official full SnowLuma archive layout not recognized.'}
Get-ChildItem $tmp -Force|ForEach-Object{Copy-Item $_.FullName $root -Recurse -Force}
$bundle=(Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$guardian=Join-Path $root 'qq-guardian';New-Item -ItemType Directory -Force $guardian|Out-Null;Copy-Item (Join-Path $bundle 'dist-snowluma') $guardian -Recurse -Force
$envFile=Join-Path $guardian 'guardian.env';$lines=@('SNOWLUMA_WS_URL=ws://127.0.0.1:3001/');if($AcceptEula){$lines+='SNOWLUMA_ACCEPT_EULA=1'};if($AcceptPrivacy){$lines+='SNOWLUMA_ACCEPT_PRIVACY=1'};$lines|Set-Content $envFile -Encoding utf8
@{officialRelease=$manifest.officialRelease.tag;asset=$a.file;sha256=$a.sha256}|ConvertTo-Json|Set-Content (Join-Path $root 'qq-guardian-install.json') -Encoding utf8
if($Unattended){Start-Process powershell.exe -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $bundle 'deploy\native\start-snowluma-guardian.ps1'),'-SnowLumaRoot',$root,'-GuardianRoot',$guardian,'-EnvironmentFile',$envFile}
Write-Host "Installed official SnowLuma."
}finally{Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue}
