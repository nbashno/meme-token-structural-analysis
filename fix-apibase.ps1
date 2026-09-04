# WAR ARENA - Set API_BASE to local server (run from PROJECT ROOT)
# Usage:  powershell -ExecutionPolicy Bypass -File .\fix-apibase.ps1
$ErrorActionPreference = "Stop"
$path = "miniapp\index.html"
if (-not (Test-Path $path)) {
  Write-Host "ERROR: run this from the project root (C:\work\telegram\GMGN\war), not inside miniapp." -ForegroundColor Red
  exit 1
}
$text = Get-Content -Raw -Path $path
$old  = 'const API_BASE = "";'
$new  = 'const API_BASE = "http://localhost:8080";'
if ($text.Contains($old)) {
  $text = $text.Replace($old, $new)
  Set-Content -Path $path -Value $text -NoNewline
  Write-Host "OK: API_BASE set to http://localhost:8080" -ForegroundColor Green
} elseif ($text.Contains($new)) {
  Write-Host "Already set to http://localhost:8080 (nothing to do)." -ForegroundColor Yellow
} else {
  Write-Host "Could not find the API_BASE line. Current value:" -ForegroundColor Yellow
  Select-String -Path $path -Pattern "const API_BASE ="
}
