# WAR - GMGN referral deep-linking: every token/wallet address opens GMGN via WAR's
# referral code (Vz638Ow5). Token addresses -> GMGN Telegram bot; wallets -> GMGN web
# address page. Copy still works (separate icon). One-time referral disclosure shown
# (GMGN ToS compliance). Replaces miniapp\index.html with a pre-verified build.
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$b64  = Join-Path $here "gmgn-referral.b64"
$file = Join-Path (Get-Location) "miniapp\index.html"
$want = "b8d840be3418c1cc08ce6dcd5b42b49d4f767194cd21cce61fadd89781052700"
if (-not (Test-Path $b64))  { Write-Error "Missing gmgn-referral.b64 next to this script."; exit 1 }
if (-not (Test-Path $file)) { Write-Error "Not found: $file  (run from repo root C:\work\telegram\GMGN\war)"; exit 1 }

$stamp  = Get-Date -Format "yyyyMMdd-HHmmss"
$backup = "$file.$stamp.bak"
Copy-Item $file $backup
Write-Host "Backup: $backup" -ForegroundColor DarkGray

$bytes = [System.Convert]::FromBase64String((Get-Content -Raw $b64).Trim())
[System.IO.File]::WriteAllBytes($file, $bytes)

$txt = Get-Content -Raw -Encoding UTF8 $file
$okFn  = $txt -match "function gmgnUrl\("
$okRef = $txt -match "Vz638Ow5"
$sha   = (Get-FileHash $file -Algorithm SHA256).Hash.ToLower()
if ($okFn -and $okRef -and $sha -eq $want) {
  Write-Host "OK - GMGN referral linking applied and verified." -ForegroundColor Green
  Write-Host "Every token/wallet address now opens GMGN via your referral code." -ForegroundColor Green
  Write-Host "Redeploy war-arena-app (static) or hard-refresh the Mini App." -ForegroundColor Green
} else {
  Copy-Item $backup $file -Force
  Write-Error "Verify failed (fn=$okFn ref=$okRef shaMatch=$($sha -eq $want)). Restored backup; no changes kept."
  exit 1
}
