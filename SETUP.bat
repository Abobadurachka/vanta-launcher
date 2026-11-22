@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title Vanta Launcher - Windows Setup Builder
color 0B

echo.
echo  VANTA LAUNCHER ^| STABLE WINDOWS SETUP
 echo -----------------------------------

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js 22 or newer was not found.
  echo Install Node.js LTS from https://nodejs.org/ and run SETUP.bat again.
  pause
  exit /b 1
)
where npm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] npm was not found. Reinstall Node.js with npm included.
  pause
  exit /b 1
)

for /f "tokens=1 delims=v" %%v in ('node -v') do set NODE_VER=%%v
echo [1/3] Node.js: %NODE_VER%
node -e "const v=process.versions.node.split('.').map(Number); if (v[0] < 22) process.exit(1);"
if errorlevel 1 (
  echo [ERROR] Node.js 22 or newer is required. Current version: %NODE_VER%
  echo Install the latest LTS release from https://nodejs.org/
  pause
  exit /b 1
)
if not exist package-lock.json (
  echo [2/3] Installing project dependencies...
  call npm.cmd install --prefer-offline --no-audit --no-fund
) else (
  echo [2/3] Installing locked project dependencies...
  call npm.cmd ci --prefer-offline --no-audit --no-fund
)
if errorlevel 1 (
  echo [ERROR] Dependency installation failed.
  pause
  exit /b 1
)

echo [3/3] Building the Windows NSIS installer...
call npm.cmd run dist:win
if errorlevel 1 (
  echo [ERROR] Setup build failed. See the messages above.
  pause
  exit /b 1
)

echo.
echo Build completed. Opening the release folder...
if exist "%~dp0release" start "" explorer "%~dp0release"
for /f "delims=" %%v in ('node -p "require('"'"'./package.json'"'"').version"') do set APP_VERSION=%%v
echo The generated file is named Vanta-Launcher-Setup-%APP_VERSION%-x64.exe.
pause
