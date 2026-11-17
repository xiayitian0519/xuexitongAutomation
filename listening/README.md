# 可选英语听力

文字任务不需要安装本节依赖。听力采用本地Python、faster-whisper 1.2.1与完整的本地small模型，不提供口语录制或音频上传。

1. 本机安装Python后，执行 `node automation/setup.mjs --install-listening --python "本机Python路径"`，将Python依赖安装到项目 `.tmp/listening-python`，不全局改包，不隐式下载模型。`--python`只用于本次命令，不保存解释器选择；Python不在PATH时，后续运行也须设置 `LISTENING_PYTHON`，或在具体任务的listening配置中提供 `python` 路径。npm/pip可能写用户缓存。
2. 准备可信来源的本地faster-whisper模型目录，至少包含非空 `model.bin`、`config.json`、`tokenizer.json`。可执行 `node automation/setup.mjs --import-model "本地模型目录"` 将允许的纯模型文件复制到项目 `.tmp/listening-model-small`；已有相同内容则复用，不覆盖不同内容。安装预检、听力预检及转写器默认使用这个项目目录；不需要再设置模型环境变量。其他模型路径按任务配置的 `model`、环境变量 `LISTENING_MODEL`、项目默认目录的顺序选择。
3. 从其他机器复制纯模型文件是可选方式，不复制真实音频、转写或用户凭证。系统Python和包含本机原生依赖的Python包在新机重新安装。
4. `node automation/setup.mjs --check --listening` 只读检查可选材料，不执行Python。安装后可按下面的显式本地预检命令检查引擎及解码器能否导入、模型文件是否完整；它不转写音频、不下载、不调用付费模型，也不能代替真实材料的速度和质量验证。
5. 新机器默认保守单并发；旧电脑的双并发性能结果不能直接套用。用有权使用的合成或练习材料实测后才调整，不在真实任务计时中临时换模型。
6. 首次完整转写保留原始记录、时间戳和疑点；局部问题仅重转相应区间，不能通过降低质量阈值或只核对题号宣称内容完整。
7. 长材料走标准输入。真实材料和转写留在私有目录，只有在明确允许发送给已配置模型时才消耗额度。

在项目根目录的PowerShell执行，路径替换为本机实际值：

```powershell
$env:LISTENING_PYTHON = (Get-Command python).Source
node automation/setup.mjs --install-listening --python "$env:LISTENING_PYTHON"
node automation/setup.mjs --import-model '<已有模型目录>'
node automation/setup.mjs --check --listening
node --input-type=module -e "const {checkLocalAsr}=await import('./listening/preflight.mjs'); console.log(JSON.stringify(await checkLocalAsr()));"
```

`Get-Command python`要求Python已在PATH中；否则将该表达式替换为本人解释器完整路径的引号字符串。`<已有模型目录>`是待替换的本机目录占位符。上述环境变量只对当前终端及由它启动的子进程有效。若由另一终端、WorkBuddy或原有长驻进程运行任务，须在那里设置同样环境，或在任务listening配置中传入解释器路径；安装不会替你修改系统环境或账号设置。模型已导入后直接使用项目默认目录；想保留模型原位置，可改为设置 `$env:LISTENING_MODEL = '<已有模型目录>'`，不执行导入。

离线路径接线测试：`node tests/verify-listening-setup.mjs`；离线管线测试：`node tests/verify-listening-pipeline.mjs`。这些测试使用模拟接口，不证明新电脑真实转写质量和速度。
