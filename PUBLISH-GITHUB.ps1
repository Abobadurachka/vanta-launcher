$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

Write-Host ''
Write-Host 'VANTA LAUNCHER | PUBLISH STABLE RELEASE' -ForegroundColor Cyan
Write-Host '------------------------------------'
Write-Host 'GitHub repository must be PUBLIC and use the format owner/repository.'
Write-Host 'The build embeds this repository into app-update.yml, so installed clients can update automatically.'
$repository = (Read-Host 'GitHub repository').Trim()
if ([string]::IsNullOrWhiteSpace($repository)) { throw 'Repository is required.' }

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js 22+ is required.' }
$nodeMajor = [int]((node -p "process.versions.node.split('.')[0]").Trim())
if ($nodeMajor -lt 22) { throw 'Node.js 22+ is required.' }
if (-not (Test-Path 'node_modules')) {
  Write-Host '[1/2] Installing project dependencies…' -ForegroundColor Yellow
  npm.cmd install --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw 'npm install failed.' }
} else {
  Write-Host '[1/2] Dependencies are already installed.' -ForegroundColor Green
}

Write-Host ''
Write-Host 'Create a fine-grained GitHub token with Contents: Read and write for this repository.' -ForegroundColor Yellow
Write-Host 'The token is kept only in this PowerShell process and is not written into project files.' -ForegroundColor Yellow
$secureToken = Read-Host 'GitHub token (hidden input)' -AsSecureString
if ($secureToken.Length -lt 20) { throw 'Token is empty or too short.' }
$tokenPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
try {
  $env:GH_TOKEN = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($tokenPointer)
  $env:VANTA_GITHUB_REPOSITORY = $repository
  $env:EP_PRE_RELEASE = 'false'
  $env:EP_DRAFT = 'false'
  Write-Host '[2/2] Building and publishing GitHub Stable Release…' -ForegroundColor Cyan
  npm.cmd run release:github
  if ($LASTEXITCODE -ne 0) { throw 'Release build/publish failed. Review the output above.' }
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($tokenPointer)
  Remove-Item Env:GH_TOKEN -ErrorAction SilentlyContinue
  Remove-Item Env:VANTA_GITHUB_REPOSITORY -ErrorAction SilentlyContinue
  Remove-Item Env:EP_PRE_RELEASE -ErrorAction SilentlyContinue
  Remove-Item Env:EP_DRAFT -ErrorAction SilentlyContinue
}

Write-Host ''
Write-Host 'Release published. Install this first update-enabled build once; later Stable Releases will be detected automatically.' -ForegroundColor Green
