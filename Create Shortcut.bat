@echo off
rem One-time setup: adds a "Budget Buddy" shortcut to your Desktop and Start Menu.
rem Run it again if you ever move this folder.
cd /d "%~dp0"

if not exist "node_modules\electron\dist\electron.exe" (
  echo Installing the desktop window ^(first time only^)...
  call npm install
  if errorlevel 1 (
    echo.
    echo npm install failed. Make sure Node.js 22.13 or newer is installed: https://nodejs.org
    pause
    exit /b 1
  )
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\create-shortcut.ps1"
if errorlevel 1 (
  echo.
  echo Could not create the shortcuts.
  pause
  exit /b 1
)

echo.
echo Done! Open Budget Buddy from your Desktop or the Start Menu.
echo Tip: right-click the Desktop shortcut, choose "Show more options", then "Pin to taskbar".
timeout /t 8 >nul
