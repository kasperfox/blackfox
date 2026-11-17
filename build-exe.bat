@echo off
title BlackFox Launcher Build
set CSC_IDENTITY_AUTO_DISCOVERY=false
echo ====================================================
echo   Building BlackFox Launcher .exe for Windows 10/11
echo ====================================================
if not exist "node_modules\.bin\electron-builder.cmd" (
  if exist node_modules rmdir /s /q node_modules
  if exist package-lock.json del /q package-lock.json
  echo Installing Node.js packages...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo ERROR: npm install failed. Install Node.js 22 LTS from https://nodejs.org/
    pause
    exit /b 1
  )
)
echo Packaging Electron app into .exe...
call npm run dist
if errorlevel 1 (
  echo ERROR: Build failed! See error output above.
  pause
  exit /b 1
)
echo.
echo Done! Files created in dist\:
echo   - BlackFox-Launcher-Portable.exe (single file, no install needed)
echo   - BlackFox-Launcher-Setup.exe (installer)
pause
