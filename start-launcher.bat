@echo off
title BlackFox Launcher
echo Starting BlackFox Launcher...
if not exist "node_modules\.bin\electron.cmd" (
  if exist node_modules rmdir /s /q node_modules
  if exist package-lock.json del /q package-lock.json
  echo Installing dependencies...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo ERROR: npm install failed. Install Node.js 22 LTS from https://nodejs.org/
    pause
    exit /b 1
  )
)
call npm start
if errorlevel 1 (
  echo.
  echo Electron exited with error code %ERRORLEVEL%.
  echo Retrying automatically with Safe Graphics flags (--disable-gpu --no-sandbox)...
  call npx electron . --disable-gpu --no-sandbox
  if errorlevel 1 (
    echo ERROR: Launch failed even in Safe Graphics mode.
    pause
    exit /b 1
  )
)
