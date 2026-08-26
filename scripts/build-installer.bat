@echo off
rem BESSForge — one-command complete Windows release build.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-installer.ps1"
pause
