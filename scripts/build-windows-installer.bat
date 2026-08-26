@echo off
rem One-command Windows installer build.
rem Produces dist\installer\BESSForge-Setup-<version>.exe
setlocal
cd /d "%~dp0.."

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js is required to build the installer.
  echo Install the current LTS from https://nodejs.org and run this again.
  pause
  exit /b 1
)

where makensis >nul 2>&1
if errorlevel 1 (
  if not exist "%ProgramFiles(x86)%\NSIS\makensis.exe" (
    echo NSIS is required to build the installer.
    echo Install it with:  winget install NSIS.NSIS
    echo or download from: https://nsis.sourceforge.io
    pause
    exit /b 1
  )
)

if not exist node_modules (
  echo Installing build dependencies...
  call npm ci || exit /b 1
)

node scripts\build-windows-installer.mjs %*
set CODE=%ERRORLEVEL%
if not "%CODE%"=="0" (
  echo.
  echo Build failed with code %CODE%.
  pause
)
endlocal & exit /b %CODE%
