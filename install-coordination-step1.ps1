# WAR — COORDINATION V1, Step 1: types + pure Detector + unit/breach tests + frozen spec.
# Reads coord-step1.b64 beside this script. No here-strings. Backs up nothing (new files),
# but refuses to overwrite if the target files already exist (prevents clobber).
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$b64  = Join-Path $here "coord-step1.b64"
$want = "f04eb57512f9b06d659e73f100ffa45cff96d308c2ab1d4393284686e0b16108"
if (-not (Test-Path $b64)) { Write-Error "Missing coord-step1.b64 next to this script."; exit 1 }
if (-not (Test-Path "src\structure")) { Write-Error "Run from repo root C:\work\telegram\GMGN\war (src\structure not found)."; exit 1 }

$targets = @(
  "src\structure\coordination\types.ts",
  "src\structure\coordination\detector.ts",
  "tests\coordination.test.ts"
)
foreach ($t in $targets) { if (Test-Path $t) { Write-Error "Refusing to overwrite existing $t. Move it aside first."; exit 1 } }

$tgz = Join-Path $here "coord-step1.tgz"
[System.IO.File]::WriteAllBytes($tgz, [System.Convert]::FromBase64String((Get-Content -Raw $b64).Trim()))
$sha = (Get-FileHash $tgz -Algorithm SHA256).Hash.ToLower()
if ($sha -ne $want) { Remove-Item $tgz; Write-Error "Payload sha mismatch. Aborted."; exit 1 }

tar -xzf $tgz
Remove-Item $tgz
Write-Host "Extracted:" -ForegroundColor Green
$targets | ForEach-Object { Write-Host "  $_" -ForegroundColor Green }
Write-Host "  COORDINATION_V1_SPEC.md" -ForegroundColor Green
Write-Host ""
Write-Host "Verify now:" -ForegroundColor Cyan
Write-Host "  npx tsc --noEmit" -ForegroundColor Cyan
Write-Host "  npx vitest run tests/coordination.test.ts" -ForegroundColor Cyan
Write-Host "Expected: typecheck clean, 12/12 tests pass. Core is untouched; gate stays OFF." -ForegroundColor DarkGray
