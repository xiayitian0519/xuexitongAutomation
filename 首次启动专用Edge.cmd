@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
set "WORKFLOW_NODE=node"
where node >nul 2>nul
if errorlevel 1 set "WORKFLOW_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if not "%WORKFLOW_NODE%"=="node" if not exist "%WORKFLOW_NODE%" goto no_node
echo 此入口明确初始化一个本项目专用 Edge。请保持此终端运行。
echo 默认打开空白页，请本人在此专用窗口打开学习通并登录。不开始任务或付费请求。
"%WORKFLOW_NODE%" "automation\session-owner.mjs" --initialize --allow-new-browser
set "WORKFLOW_EXIT=%ERRORLEVEL%"
if not "%WORKFLOW_EXIT%"=="0" pause
exit /b %WORKFLOW_EXIT%
:no_node
echo 未找到 Node.js。请先完成安装与检查。
pause
exit /b 1
