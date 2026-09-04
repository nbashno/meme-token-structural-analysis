# install-complete.ps1
# WAR ARENA — full verified src/ + tests/ (all phases through Arena)
# Replaces src/ and tests/ with the complete tested state (671 tests passing).
#
# Run from the project root (where package.json lives):
#   powershell -ExecutionPolicy Bypass -File .\install-complete.ps1
#
# It backs up your current src/ and tests/ first, then extracts the verified tree.

$ErrorActionPreference = 'Stop'
Write-Host 'WAR ARENA — complete installer' -ForegroundColor Cyan

$zip = Join-Path $PSScriptRoot 'war-complete-src-tests.zip'
if (-not (Test-Path $zip)) {
  Write-Host "ERROR: war-complete-src-tests.zip not found next to this script." -ForegroundColor Red
  Write-Host "Place both files in the project root and re-run." -ForegroundColor Red
  exit 1
}

# 1. Back up existing src/ and tests/
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = Join-Path $PSScriptRoot "_backup-$stamp"
New-Item -ItemType Directory -Force -Path $backup | Out-Null
foreach ($d in @('src','tests')) {
  if (Test-Path $d) {
    Write-Host "  backing up $d -> _backup-$stamp\$d" -ForegroundColor DarkGray
    Copy-Item -Recurse -Force $d (Join-Path $backup $d)
  }
}

# 2. Extract the verified tree (overwrites src/ and tests/)
Write-Host '  extracting verified src/ + tests/ ...' -ForegroundColor DarkGray
Add-Type -AssemblyName System.IO.Compression.FileSystem
$tmp = Join-Path $env:TEMP "war-extract-$stamp"
[System.IO.Compression.ZipFile]::ExtractToDirectory($zip, $tmp)

foreach ($item in Get-ChildItem -Path $tmp) {
  # copy src/, tests/, and optionally package.json/tsconfig.json
  if ($item.PSIsContainer -and @('src','tests') -contains $item.Name) {
    if (Test-Path $item.Name) { Remove-Item -Recurse -Force $item.Name }
    Copy-Item -Recurse -Force $item.FullName $item.Name
    Write-Host "  installed $($item.Name)/" -ForegroundColor Green
  }
}
Remove-Item -Recurse -Force $tmp

Write-Host ''
Write-Host "Backup saved to: _backup-$stamp" -ForegroundColor Yellow
Write-Host 'Now run:' -ForegroundColor Green
Write-Host '  npx tsc --noEmit' -ForegroundColor White
Write-Host '  npm test' -ForegroundColor White
Write-Host 'Expected: 671 passing + 1 skipped, typecheck clean.' -ForegroundColor White
