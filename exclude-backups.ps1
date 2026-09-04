# Exclude _backup-* folders from vitest so only the live project is tested.
# Run from project root:  powershell -ExecutionPolicy Bypass -File .\exclude-backups.ps1
$ErrorActionPreference = "Stop"
$enc = New-Object System.Text.UTF8Encoding($false)

$cfg = "vitest.config.ts"
if (-not (Test-Path $cfg)) { $cfg = "vitest.config.js" }
if (-not (Test-Path $cfg)) { $cfg = "vite.config.ts" }

if (Test-Path $cfg) {
  $raw = Get-Content $cfg -Raw
  if ($raw -match "_backup") {
    Write-Host "  $cfg already excludes _backup — nothing to do" -ForegroundColor DarkGray
  } else {
    Write-Host "  Found $cfg. Please add this to test.exclude:  '**/_backup-*/**'" -ForegroundColor Yellow
    Write-Host "  (Auto-patch skipped to avoid corrupting a custom config.)" -ForegroundColor Yellow
  }
} else {
  # No config: create a minimal one that excludes backups + node_modules.
  $content = @"
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/_backup-*/**",
      "**/_backup*/**",
    ],
  },
});
"@
  [System.IO.File]::WriteAllText((Join-Path (Get-Location) "vitest.config.ts"), $content, $enc)
  Write-Host "  created vitest.config.ts excluding _backup-* folders" -ForegroundColor Green
}

Write-Host ""
Write-Host "Re-running only the live project tests..." -ForegroundColor Cyan
npx vitest run
