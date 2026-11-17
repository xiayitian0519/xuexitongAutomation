@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0.."
set "NODE_EXE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node"
"%NODE_EXE%" "automation\control.mjs" %*
if errorlevel 1 pause
