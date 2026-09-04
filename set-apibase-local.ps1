# WAR ARENA - Point the Mini App at the local server (API_BASE) - Installer
# Run from project root:  powershell -ExecutionPolicy Bypass -File .\set-apibase-local.ps1
$ErrorActionPreference = "Stop"
$path = "miniapp\index.html"
$text = Get-Content -Raw -Path $path
$old = 'const API_BASE = "";'
$new = 'const API_BASE = "http://localhost:8080";'
if ($text.Contains($old)) {
  $text = $text.Replace($old, $new)
  Set-Content -Path $path -Value $text -NoNewline
  Write-Host "API_BASE set to http://localhost:8080" -ForegroundColor Green
} else {
  Write-Host "Could not find the exact API_BASE line. Current value:" -ForegroundColor Yellow
  Select-String -Path $path -Pattern "const API_BASE"
}
