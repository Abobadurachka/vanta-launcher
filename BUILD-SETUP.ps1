$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw 'Node.js 22+ is required. Install it from https://nodejs.org/ and rerun this script.'
}
$nodeMajor = [int]((node -p "process.versions.node.split('.')[0]").Trim())
if ($nodeMajor -lt 22) { throw 'Node.js 22+ is required. Update Node.js and rerun this script.' }
if (-not (Test-Path 'node_modules')) {
  npm.cmd install --prefer-offline --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw 'npm install failed.' }
}
npm.cmd run dist:win
if ($LASTEXITCODE -ne 0) { throw 'Windows installer build failed.' }
Write-Host "Installer output: $PSScriptRoot\release" -ForegroundColor Cyan
Start-Process explorer.exe (Join-Path $PSScriptRoot 'release')
