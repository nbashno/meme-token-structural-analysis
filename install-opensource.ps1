# WAR ARENA - add open-source files (README, LICENSE, .gitignore, .env.example, guide).
# Reads opensource.b64 beside this script. Does NOT touch git or any existing code.
# Refuses to overwrite an existing README/LICENSE (rename yours first if needed).
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$b64  = Join-Path $here "opensource.b64"
$want = "b80305d94d0a9a98a8661544a9cba198f1c097af29ea482d788ab79f49cab580"
if (-not (Test-Path $b64)) { Write-Error "Missing opensource.b64 next to this script."; exit 1 }
foreach ($f in @("README.md","LICENSE")) {
  if (Test-Path $f) { Write-Error "$f already exists. Move it aside first, then re-run."; exit 1 }
}
$tgz = Join-Path $here "opensource.tgz"
[System.IO.File]::WriteAllBytes($tgz, [System.Convert]::FromBase64String((Get-Content -Raw $b64).Trim()))
$sha = (Get-FileHash $tgz -Algorithm SHA256).Hash.ToLower()
if ($sha -ne $want) { Remove-Item $tgz; Write-Error "Payload sha mismatch. Aborted."; exit 1 }
tar -xzf $tgz; Remove-Item $tgz
Write-Host "Added: README.md, LICENSE, .gitignore, .env.example, OPEN_SOURCE_SETUP.md" -ForegroundColor Green
Write-Host "Next: read OPEN_SOURCE_SETUP.md and follow steps 1-2 (revoke keys, clean git) before going public." -ForegroundColor Cyan
