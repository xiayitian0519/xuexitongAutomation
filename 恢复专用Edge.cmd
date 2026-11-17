@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
set "WORKFLOW_NODE=node"
where node >nul 2>nul
if errorlevel 1 set "WORKFLOW_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if not "%WORKFLOW_NODE%"=="node" if not exist "%WORKFLOW_NODE%" goto no_node
echo 此入口仅在旧持有进程确认退出后，显式恢复本项目专用 Edge。
echo 保留登录与任务历史；归属不明时停止。请保持此终端运行。
"%WORKFLOW_NODE%" "automation\session-owner.mjs" --resume --allow-new-browser
set "WORKFLOW_EXIT=%ERRORLEVEL%"
if not "%WORKFLOW_EXIT%"=="0" pause
exit /b %WORKFLOW_EXIT%
:no_node
echo 未找到 Node.js。请先完成安装与检查。
pause
exit /b 1
