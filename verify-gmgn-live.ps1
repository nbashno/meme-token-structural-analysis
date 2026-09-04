# WAR ARENA - Live GMGN verification.
# Runs a REAL gmgn-cli call through the new GmgnCliExecutor + verifyLiveCli, and
# reports honestly whether GMGN_LIVE_VERIFIED can flip from BLOCKED to verified.
# Run from project root AFTER install-gmgn-live.ps1 and after setting GMGN_API_KEY:
#   $env:GMGN_API_KEY="your_key"; powershell -ExecutionPolicy Bypass -File .\verify-gmgn-live.ps1
$ErrorActionPreference = "Stop"

if (-not $env:GMGN_API_KEY) {
  Write-Host "GMGN_API_KEY is not set. Set it first, e.g.:" -ForegroundColor Red
  Write-Host '  $env:GMGN_API_KEY="gmgn_solbscbaseethmonadtron"' -ForegroundColor Yellow
  exit 1
}

# 1) Direct CLI reachability (fast, honest).
Write-Host "1) Probing gmgn-cli directly ..." -ForegroundColor Cyan
$raw = gmgn-cli market trending --chain sol --interval 1h --limit 1 --raw 2>&1
if ($LASTEXITCODE -ne 0) {
  Write-Host "   CLI call failed:" -ForegroundColor Red
  Write-Host "   $raw" -ForegroundColor DarkGray
  Write-Host "   (If 401/403 with a valid key, disable IPv6 - GMGN is IPv4-only.)" -ForegroundColor Yellow
  exit 1
}
try { $null = $raw | ConvertFrom-Json; Write-Host "   OK - CLI returned valid JSON." -ForegroundColor Green }
catch { Write-Host "   CLI output was not valid JSON." -ForegroundColor Red; exit 1 }

# 2) Through the project's own executor (proves the wired path works end-to-end).
Write-Host "2) Probing through GmgnCliExecutor (project path) ..." -ForegroundColor Cyan
$probe = @'
import { GmgnCliExecutor, verifyLiveCli } from "./src/integration/GmgnCliExecutor.js";
const r = await verifyLiveCli(new GmgnCliExecutor());
if (r.ok) { console.log("VERIFIED bytes=" + r.sampleBytes); process.exit(0); }
console.error("FAILED reason=" + r.reason); process.exit(1);
'@
$probe | Out-File -FilePath ".gmgn-probe.mts" -Encoding utf8
try {
  npx tsx .gmgn-probe.mts
  $code = $LASTEXITCODE
} finally {
  Remove-Item ".gmgn-probe.mts" -ErrorAction SilentlyContinue
}

if ($code -eq 0) {
  Write-Host ""
  Write-Host "GMGN_LIVE_VERIFIED: the live path works end-to-end." -ForegroundColor Green
  Write-Host "BLOCKED_BY_GMGN_CLI is resolved." -ForegroundColor Green
} else {
  Write-Host ""
  Write-Host "Executor path failed. The direct CLI worked, so this is a wiring/tsx issue." -ForegroundColor Yellow
  Write-Host "If 'npx tsx' is missing: npm i -D tsx" -ForegroundColor Yellow
}
