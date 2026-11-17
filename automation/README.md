# 工作流入口

本项目可由WorkBuddy读取和运行，本身是本地Node源码工作流，不依赖Codex账户。先读根目录AGENTS、README和WORKBUDDY_START。

1. 安装预检：`node automation/setup.mjs --check`。安装依赖须显式 `--install`，不启动浏览器或付费请求。
2. 独立CLI认证：`node automation/setup.mjs --login-cli`，本人在真实终端完成。不能使用WorkBuddy内置lite入口代替独立CLI。
3. 浏览器状态：`node automation/session-owner.mjs --status`。首次需明确 `--initialize --allow-new-browser`，显式恢复为 `--resume --allow-new-browser`，平时只复用已有健康连接。
4. 无浏览器验收：`node tests/verify-workflow-portable.mjs` 与 `node tests/verify-exam-material-recovery.mjs`。旧 `npm test` 包含新Edge情景，不作为默认预检。
5. 交接当前题页：见 `EXAM.md`；可选听力见 `../listening/README.md`。任务范围、额度、填写和提交分别核实，不自动扩展。
6. 旧课程总控 `control.mjs/run.mjs` 的直接login/scan/run启动仍被 `EXISTING_BROWSER_ONLY` 拦截。首次初始化采用新增session-owner入口，不删除旧保护；不要沿用旧README中的自动新窗命令。
7. 正常操作通过 `existing-session.mjs` 的稳定任务派发到持有进程；同一任务一次只允许一个写入者。连接损坏、失联或结果不明停止，不能改桌面控制或删除锁。
8. 打包：`node scripts/package-workflow.mjs`，只导出明确源码和通用模板，排除本机账号、课程名单、旧完成报告及运行资料。

安装成功、登录成功、连接可读、材料识别、填写保存、平台提交确认是不同证据。逐项报告，不用“已打开课程”代替完成任务。
