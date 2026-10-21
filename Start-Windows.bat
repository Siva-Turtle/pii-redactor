@echo off
cd /d "%~dp0"
title Private Redactor
echo.
echo   Starting Private Redactor... a browser tab will open.
echo   Keep this window open while you work. Close it to stop.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0serve.ps1"
echo.
pause
