[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$SnowLumaRoot,
    [Parameter(Mandatory=$true)][string]$GuardianRoot,
    [Parameter(Mandatory=$true)][string]$EnvironmentFile
)
$ErrorActionPreference='Stop'

foreach($f in @('launcher.bat','node.exe')){
  if(!(Test-Path -LiteralPath (Join-Path $SnowLumaRoot $f) -PathType Leaf)){
    throw "$f not found; install the exact official SnowLuma full archive first."
  }
}
$guardianEntry=Join-Path $GuardianRoot 'dist-snowluma\index.mjs'
if(!(Test-Path -LiteralPath $guardianEntry -PathType Leaf)){throw "Guardian runtime not found: $guardianEntry"}

foreach($line in Get-Content -LiteralPath $EnvironmentFile){
  $trimmed=$line.Trim()
  if(!$trimmed -or $trimmed.StartsWith('#')){continue}
  $p=$trimmed.Split('=',2)
  if($p.Count -ne 2 -or [string]::IsNullOrWhiteSpace($p[0])){throw "Invalid environment line: $line"}
  $name=$p[0].Trim()
  if($name -notmatch '^[A-Za-z_][A-Za-z0-9_]*$'){throw "Invalid environment variable name: $name"}
  [Environment]::SetEnvironmentVariable($name,$p[1],'Process')
}

$snow=Start-Process -FilePath 'cmd.exe' -ArgumentList '/c','launcher.bat' -WorkingDirectory $SnowLumaRoot -PassThru
$guardian=Start-Process -FilePath (Join-Path $SnowLumaRoot 'node.exe') -ArgumentList @($guardianEntry) -WorkingDirectory $GuardianRoot -PassThru

try{
  while(!$snow.HasExited -and !$guardian.HasExited){Start-Sleep -Seconds 2}
  if($snow.HasExited -and !$guardian.HasExited){
    Write-Error "SnowLuma exited first with code $($snow.ExitCode). Stopping Guardian."
  }elseif($guardian.HasExited -and !$snow.HasExited){
    Write-Error "Guardian exited first with code $($guardian.ExitCode). Stopping SnowLuma."
  }
}finally{
  if(!$snow.HasExited){Stop-Process -Id $snow.Id -Force -ErrorAction SilentlyContinue}
  if(!$guardian.HasExited){Stop-Process -Id $guardian.Id -Force -ErrorAction SilentlyContinue}
}
exit 1
