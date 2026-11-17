@echo off
chcp 65001 >nul
setlocal
title WorkBuddy CLI Local Service
cd /d "%~dp0"
if errorlevel 1 (
  echo Cannot open script directory: %~dp0
  goto :failed
)

if not exist "deepseek-local.mjs" (
  echo Missing deepseek-local.mjs.
  goto :failed
)
if not exist "wb-cli-request.mjs" (
  echo Missing wb-cli-request.mjs.
  echo Keep this launcher, deepseek-local.mjs and wb-cli-request.mjs together.
  goto :failed
)
if not exist "xuexitong-console.js" (
  echo Missing xuexitong-console.js.
  goto :failed
)
if not exist "answer-contract.mjs" (
  echo Missing answer-contract.mjs. Keep all service modules in this folder.
  goto :failed
)

set "NODE_EXE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if not exist "%NODE_EXE%" (
  set "NODE_EXE="
  for /f "delims=" %%I in ('where node.exe 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%I"
)
if not defined NODE_EXE (
  echo Node.js was not found. Install Node.js and try again.
  goto :failed
)

echo Starting local service with WorkBuddy CLI (no DeepSeek API Key needed)...
"%NODE_EXE%" "deepseek-local.mjs" --workbuddy-cli
set "EXIT_CODE=%ERRORLEVEL%"
echo.
echo Local service exited with code %EXIT_CODE%.
echo If the CLI path is wrong, set WB_CLI_PATH to the Node JS bin/codebuddy entry, not a .cmd or .exe.
pause
exit /b %EXIT_CODE%

:failed
echo.
echo Startup failed. Please send me the exact message above.
pause
exit /b 1
