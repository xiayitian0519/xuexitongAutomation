# 可迁移的学习通工作流

这是本地Node工作流源码包，可由WorkBuddy读取、安装和运行；不是一键装入Skills目录的插件。支持Windows专用Edge、独立CodeBuddy CLI，以及可选本地英语听力转写。

上游项目为 `chaolucky18/xuexitongScript`；本包保留工作流相关源码及本地部署增强，不包含旧油猴视频脚本与个人运行资料。

## 第一次使用

1. 将压缩包完整解压到本机NTFS磁盘上的普通项目目录，不要直接在ZIP、网络盘或不支持硬链接的可移动磁盘里运行。连接状态使用同目录硬链接发布完整文件，不支持时会停止。让WorkBuddy以解压后包含本文件的目录作为工作目录。
2. 先读 `WORKBUDDY_START.md`，把其中安装提示发给WorkBuddy。需要系统Node和Edge；本包不静默安装系统软件。Node满足 `package.json` 的版本要求，建议使用满足要求的24.x版本。
3. `安装与检查.cmd` 默认只做只读检查；得到明确安装指令后执行 `安装与检查.cmd --install`，安装项目依赖和固定版本独立CLI，不启动浏览器或模型请求。
4. 运行 `登录CodeBuddy.cmd`，本人在真实终端完成账号认证。WorkBuddy桌面登录与CLI登录分别核实，不公开凭证。不在CLI里发送测试问题，避免无意消耗额度。
5. 本人明确允许首次建立专用Edge后，运行 `首次启动专用Edge.cmd`。默认打开空白页，本人在这个专用窗口打开学习通并登录。该终端是连接持有者，保持运行；已有健康连接时复用，不启动第二个。
6. `查看专用Edge状态.cmd` 检查实际连接。关闭持有进程后不能自动恢复；本人明确要求时运行 `恢复专用Edge.cmd`，重新打开本项目的独立资料目录，保留历史。
7. 需要听力再准备Python、`faster-whisper==1.2.1`与本地small模型，见 `listening/README.md`。没有听力时不强制安装这些大依赖。
8. 先做无浏览器离线验收，再由本人进入具体作业、完成安全验证并交接。CLI登录、新机真实Edge和任务端到端需要分别验证。

## 常用命令

从项目根目录执行：

```powershell
node automation/setup.mjs --check
node automation/setup.mjs --install
node automation/setup.mjs --login-cli
node automation/session-owner.mjs --status
node automation/session-owner.mjs --initialize --allow-new-browser
node tests/verify-workflow-portable.mjs
node tests/verify-exam-material-recovery.mjs
```

安装会从npm下载程序，依赖安装在项目内，不全局安装；安装器仍可能写入用户缓存和日志。CLI版本固定为项目已验证的2.184.0。模型是否可用、账号是否有权限、积分和登录状态仍以本机实际检查为准。

## 分享与边界

1. 源码包不携带账号、Cookie、真实题目、音频、原作者课程、旧连接PID或令牌。`.tmp/`、`.automation.local/`、`node_modules/`和旧个人报告均不打包。
2. 项目不得调用系统鼠标、键盘、窗口激活或焦点切换。连接失败停止并说明，不能换桌面工具补救。
3. 材料处理执行器与旧课程总控是不同入口；安装成功不意味着所有课程能批量无人干预运行。计算过程、手写上传、附件和论文等仍按规则暂缓。
4. 包内 `package-manifest.json` 列出文件SHA256；旁边ZIP校验文件用于核对传输。校验一致只证明文件未意外变化，不代替可信来源判断。
5. 不运行旧 `npm test` 来做默认预检，它含新建无界面Edge情景。迁移验收使用上面的两条明确离线入口。
