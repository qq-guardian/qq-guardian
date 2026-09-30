[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$SnowLumaRoot,[Parameter(Mandatory=$true)][string]$GuardianRoot,[Parameter(Mandatory=$true)][string]$EnvironmentFile)
$ErrorActionPreference='Stop'
foreach($f in @('launcher.bat','node.exe')){if(!(Test-Path (Join-Path $SnowLumaRoot $f))){throw "$f not found; use the official full SnowLuma package."}}
foreach($line in Get-Content $EnvironmentFile){$t=$line.Trim();if(!$t -or $t.StartsWith('#')){continue};$p=$t.Split('=',2);if($p.Count -ne 2){throw "Invalid environment line: $line"};[Environment]::SetEnvironmentVariable($p[0].Trim(),$p[1],'Process')}
$snow=Start-Process cmd.exe -ArgumentList '/c','launcher.bat' -WorkingDirectory $SnowLumaRoot -PassThru;Start-Sleep 3
try{& (Join-Path $SnowLumaRoot 'node.exe') (Join-Path $GuardianRoot 'dist-snowluma\index.mjs');exit $LASTEXITCODE}finally{if(!$snow.HasExited){Stop-Process $snow.Id -Force -ErrorAction SilentlyContinue}}
