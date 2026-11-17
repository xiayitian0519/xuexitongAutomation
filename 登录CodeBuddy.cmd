@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
set "WORKFLOW_NODE=node"
where node >nul 2>nul
if errorlevel 1 set "WORKFLOW_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if not "%WORKFLOW_NODE%"=="node" if not exist "%WORKFLOW_NODE%" goto no_node
"%WORKFLOW_NODE%" "automation\setup.mjs" --login-cli
set "WORKFLOW_EXIT=%ERRORLEVEL%"
if not "%WORKFLOW_EXIT%"=="0" pause
exit /b %WORKFLOW_EXIT%
:no_node
echo 未找到 Node.js。请先完成安装与检查。
pause
exit /b 1
