@echo off
setlocal
cd /d "%~dp0"
title VANTA Launcher - Publish Pre-Release
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0PUBLISH-GITHUB.ps1"
if errorlevel 1 (
  echo.
  echo [ERROR] Publishing failed. Review the message above.
  pause
  exit /b 1
)
echo.
echo Publishing completed.
pause
