@echo off
cd /d "%~dp0"
title Private Redactor
echo.
echo   Starting Private Redactor... a browser tab will open.
echo   Keep this window open while you work. Close it to stop.
echo.
REM One-time 183 MB model download (skipped when already present, so this
REM stays offline-friendly). The app still works without it (patterns only).
if not exist "%~dp0vendor\gliner\models\onnx-community\gliner_small-v2.1\onnx\model_quantized.onnx" (
  echo   AI model not found, downloading it now (one time, ~183 MB)...
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\fetch-model.ps1"
  if errorlevel 1 echo   Could not download the AI model. Continuing with pattern checks only.
  echo.
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0serve.ps1"
echo.
pause
