@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul || (echo Install Node.js 22+ first.& pause & exit /b 1)
if not exist node_modules call npm install --no-audit --no-fund
if errorlevel 1 exit /b 1
call npm run dev
