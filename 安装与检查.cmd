@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
set "WORKFLOW_NODE=node"
where node >nul 2>nul
if errorlevel 1 set "WORKFLOW_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if not "%WORKFLOW_NODE%"=="node" if not exist "%WORKFLOW_NODE%" goto no_node
"%WORKFLOW_NODE%" "automation\setup.mjs" %*
set "WORKFLOW_EXIT=%ERRORLEVEL%"
if "%~1"=="" pause
if not "%WORKFLOW_EXIT%"=="0" if not "%~1"=="" pause
exit /b %WORKFLOW_EXIT%
:no_node
echo 未找到 Node.js。请先安装 package.json 要求的版本，再运行本入口。
pause
exit /b 1
