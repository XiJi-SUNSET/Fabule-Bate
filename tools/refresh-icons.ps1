# Force-refresh Windows icon cache (desktop will flicker once while explorer restarts).
# Usage: npm run refresh-icons
$ErrorActionPreference = 'Stop'
Write-Host 'Restarting explorer to drop icon cache...'
taskkill /f /im explorer.exe 2>$null | Out-Null
Start-Sleep -Milliseconds 900

$db = Join-Path $env:LOCALAPPDATA 'IconCache.db'
if (Test-Path $db) { Remove-Item $db -Force -ErrorAction SilentlyContinue }
$expCache = Join-Path $env:LOCALAPPDATA 'Microsoft\Windows\Explorer'
Get-ChildItem $expCache -Filter 'iconcache*' -ErrorAction SilentlyContinue |
  Remove-Item -Force -ErrorAction SilentlyContinue

Start-Process explorer.exe
Write-Host 'Done. Icons reloaded from disk (taskbar pins may need re-pinning).'
