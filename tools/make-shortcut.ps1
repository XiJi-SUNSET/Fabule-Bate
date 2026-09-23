# Create Fabula shortcuts (Desktop + Start Menu) for pinning to taskbar.
# Usage: npm run shortcut
# NOTE: keep this file ASCII-only (Windows PowerShell 5.1 reads scripts with ANSI codepage).
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$exe  = Join-Path $root 'node_modules\electron\dist\electron.exe'
$ico  = Join-Path $root 'build\fabula.ico'

if (-not (Test-Path $exe)) { Write-Error "electron.exe not found: $exe (run npm install first)" }
if (-not (Test-Path $ico)) { Write-Host "WARN: icon missing, run: npm run icon" }

$shell = New-Object -ComObject WScript.Shell
$targets = @(
  (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Fabula.lnk'),
  (Join-Path ([Environment]::GetFolderPath('Programs')) 'Fabula.lnk')
)
foreach ($lnkPath in $targets) {
  $lnk = $shell.CreateShortcut($lnkPath)
  $lnk.TargetPath       = $exe
  $lnk.Arguments        = '"' + $root + '"'
  $lnk.WorkingDirectory = $root
  $lnk.Description      = 'Fabula Storyboard Workbench'
  if (Test-Path $ico) { $lnk.IconLocation = $ico }
  $lnk.Save()
  Write-Host "created: $lnkPath"
}
Write-Host 'Done. Right-click Fabula on Desktop -> Pin to taskbar.'
