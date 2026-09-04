# Fix: remove BOM / re-normalize package.json that ConvertTo-Json wrote with a BOM.
# Run from project root:  powershell -ExecutionPolicy Bypass -File .\fix-packagejson-bom.ps1
$ErrorActionPreference = "Stop"
$enc = New-Object System.Text.UTF8Encoding($false)   # UTF-8 WITHOUT BOM

function Fix-JsonFile([string]$path){
  if (-not (Test-Path $path)) { return }
  $raw = Get-Content $path -Raw
  # strip any leading BOM or stray bytes before the first '{'
  $idx = $raw.IndexOf('{')
  if ($idx -gt 0) { $raw = $raw.Substring($idx) }
  # validate it parses, then rewrite clean without BOM
  $obj = $raw | ConvertFrom-Json
  $clean = $obj | ConvertTo-Json -Depth 30
  [System.IO.File]::WriteAllText((Resolve-Path $path), $clean, $enc)
  Write-Host "  fixed $path (no BOM)" -ForegroundColor Green
}

Write-Host "Repairing JSON files written with BOM..." -ForegroundColor Cyan
Fix-JsonFile "package.json"
Fix-JsonFile "tsconfig.json"
Fix-JsonFile "tsconfig.experience.json"

Write-Host ""
Write-Host "Re-running gate..." -ForegroundColor Cyan
npx tsc --noEmit; if ($LASTEXITCODE -ne 0){ throw "root typecheck failed" }
npx tsc -p tsconfig.experience.json; if ($LASTEXITCODE -ne 0){ throw "experience typecheck failed" }
npx vitest run
Write-Host ""
Write-Host "Done. Expected: 790 passed + 1 skipped, 367 guards." -ForegroundColor Yellow
