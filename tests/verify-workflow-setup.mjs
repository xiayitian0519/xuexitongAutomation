import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  OFFICIAL_CLI_VERSION, cleanSetupEnv, inspectSetup, main, nodeVersionSupported,
  parseSetupArgs, runSetup, setupPlan,
} from '../automation/setup.mjs';

// 所有文件、安装、登录与模型复制均使用内存替身；不连接真实用户目录或启动进程。
const p = path.win32;
const windowsPath = (volume, ...parts) => p.join(String.fromCharCode(volume) + ':' + p.sep, ...parts);
const ROOT = windowsPath(67, '新电脑 空格', '学习通自动化');
const NODE = windowsPath(67, '工具 空格', 'node', 'node.exe');
const NPM = p.join(p.dirname(NODE), 'node_modules', 'npm', 'bin', 'npm-cli.js');
const CLI = p.join(ROOT, '.tmp', 'cbcli', 'node_modules', '@tencent-ai', 'codebuddy-code', 'bin', 'codebuddy');
const EDGE = windowsPath(67, 'Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe');
const PYTHON = windowsPath(67, 'Python 中文', 'python.exe');
const SOURCE = windowsPath(68, '本地 模型', 'small');
const TARGET = p.join(ROOT, '.tmp', 'listening-model-small');
const audit = { newBrowsers: 0, networkRequests: 0, paidCalls: 0, commands: 0 };
let groups = 0;

function memoryFs() {
  const nodes = new Map();
  const reads = [];
  const writes = [];
  const key = value => p.normalize(value).toLowerCase();
  function putDirectory(file) {
    file = p.normalize(file);
    if (nodes.has(key(file))) return;
    const parent = p.dirname(file);
    if (parent !== file) putDirectory(parent);
    nodes.set(key(file), { type: 'directory', original: file });
  }
  function putFile(file, value = 'file') {
    putDirectory(p.dirname(file));
    nodes.set(key(file), { type: 'file', original: p.normalize(file), data: Buffer.from(value) });
  }
  function putJson(file, value) { putFile(file, JSON.stringify(value)); }
  function missing() { return Object.assign(new Error('memory-only missing'), { code: 'ENOENT' }); }
  const fs = {
    async lstat(file) {
      const node = nodes.get(key(file));
      if (!node) throw missing();
      return { size: node.data?.length || 0, isFile: () => node.type === 'file',
        isDirectory: () => node.type === 'directory', isSymbolicLink: () => node.type === 'symlink' };
    },
    async readFile(file, encoding) {
      reads.push(p.normalize(file));
      const node = nodes.get(key(file));
      if (!node || node.type !== 'file') throw missing();
      return encoding ? node.data.toString(encoding) : Buffer.from(node.data);
    },
    async realpath(file) {
      const node = nodes.get(key(file));
      if (!node) throw missing();
      return node.realpath || p.normalize(file);
    },
    async readdir(directory) {
      if (!nodes.has(key(directory))) throw missing();
      return [...nodes.values()].filter(node => key(p.dirname(node.original)) === key(directory)).map(node => p.basename(node.original));
    },
    async mkdir(directory) { writes.push({ op: 'mkdir', path: directory }); putDirectory(directory); },
    async copyFile(from, to, flag) {
      assert.equal(flag, 1, '导入必须使用 COPYFILE_EXCL 防覆盖');
      if (nodes.has(key(to))) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
      const node = nodes.get(key(from));
      if (!node || node.type !== 'file') throw missing();
      writes.push({ op: 'copy', from, to });
      putFile(to, node.data);
    },
  };
  return { fs, nodes, reads, writes, putFile, putJson, putDirectory,
    putLink(file, target, directory = false) {
      putDirectory(p.dirname(file));
      nodes.set(key(file), { type: 'symlink', original: p.normalize(file), realpath: target, directory });
    },
    hashFile: async file => {
      const node = nodes.get(key(file));
      if (!node || node.type !== 'file') throw missing();
      return createHash('sha256').update(node.data).digest('hex');
    },
    remove(file) { nodes.delete(key(file)); },
  };
}

function fixture({ dependencies = true, cli = true, edge = true, python = true, npm = true } = {}) {
  const mem = memoryFs();
  mem.putDirectory(ROOT);
  mem.putJson(p.join(ROOT, 'package.json'), {
    private: true, dependencies: { 'playwright-core': '1.62.1' }, devDependencies: { jsdom: '31.0.1', jquery: '4.0.0' },
  });
  if (dependencies) for (const [name, version] of Object.entries({ 'playwright-core': '1.62.1', jsdom: '31.0.1', jquery: '4.0.0' })) {
    mem.putJson(p.join(ROOT, 'node_modules', name, 'package.json'), { name, version });
  }
  if (cli) {
    mem.putFile(CLI);
    mem.putJson(p.join(p.dirname(p.dirname(CLI)), 'package.json'), { name: '@tencent-ai/codebuddy-code', version: OFFICIAL_CLI_VERSION });
  }
  if (edge) mem.putFile(EDGE);
  if (python) mem.putFile(PYTHON);
  if (npm) mem.putFile(NPM);
  const env = {
    USERPROFILE: windowsPath(67, '用户', '本人'), PATH: `${p.dirname(NODE)};${p.dirname(PYTHON)}`,
    PROGRAMFILES: windowsPath(67, 'Program Files'), SYSTEMROOT: windowsPath(67, 'Windows'), TEMP: windowsPath(67, 'Temp'),
    CODEBUDDY_FORCE_LITE_WB_BUNDLE: '1', CODEBUDDY_FORCE_HEADLESS_BUNDLE: '1',
    CLAUDE_API_KEY: 'private-key-do-not-retain', WORKBUDDY_TOKEN: 'private-token',
    OPENAI_API_KEY: 'private-openai-key', HTTPS_PROXY: 'private-proxy',
  };
  const commands = [];
  const options = {
    root: ROOT, execPath: NODE, platform: 'win32', nodeVersion: 'v24.15.0', env,
    fs: mem.fs, hashFile: mem.hashFile,
    runner: async command => {
      commands.push(command); audit.commands++;
      assert.equal(command.shell, false);
      const serialized = JSON.stringify(command.args);
      assert.ok(!serialized.includes('remote-debugging-port'));
      assert.ok(!command.args.includes('-p') && !command.args.includes('--print') && !command.args.includes('--model'));
      assert.ok(!command.args.includes('--global') && !command.args.includes('-g'));
      // 命令替身不联网、不打开浏览器、不向模型发题。
      return { exitCode: 0 };
    },
  };
  return { mem, options, commands };
}

function addModel(mem, directory = SOURCE, suffix = '') {
  for (const name of ['model.bin', 'config.json', 'tokenizer.json', 'vocabulary.txt']) mem.putFile(p.join(directory, name), `${name}${suffix}`);
}

async function test(name, body) {
  await body();
  groups++;
  console.log(`PASS ${groups}. ${name}`);
}

await test('默认预检无命令、无写入、无浏览器或凭证读取', async () => {
  const { options, mem, commands } = fixture();
  mem.putFile(p.join(ROOT, '.env'), 'PRIVATE_ENV');
  mem.putFile(p.join(ROOT, '.automation.local', 'existing-browser.json'), 'PRIVATE_BROWSER');
  mem.putFile(p.join(options.env.USERPROFILE, '.codebuddy', 'settings.json'), 'PRIVATE_AUTH');
  const report = await runSetup(options);
  assert.equal(report.mode, 'check'); assert.equal(commands.length, 0); assert.equal(mem.writes.length, 0);
  assert.equal(report.inspection.staticPrerequisites, 'present');
  assert.equal(report.inspection.runtime, 'unverified');
  assert.equal(report.inspection.cli.authentication, 'unknown');
  assert.equal(report.inspection.edge.browserSession, 'unverified');
  assert.equal(report.inspection.listening.optional, true);
  assert.equal(report.inspection.credentialsRead, false);
  assert.ok(mem.reads.every(file => !file.includes('.automation.local') && !file.includes('.env') && !file.includes('settings.json')));
});

await test('Node支持范围包含明确下界且拒绝不支持的主版本', async () => {
  for (const version of ['22.22.2', 'v22.23.0', '24.15.0', '24.16.1', '26.0.0', '27.0.0']) assert.equal(nodeVersionSupported(version), true, version);
  for (const version of ['22.22.1', '22.21.9', '24.14.9', '23.9.0', '25.0.0', '20.99.0', '24.15.0-nightly', 'garbage']) assert.equal(nodeVersionSupported(version), false, version);
  const { options, commands } = fixture();
  await assert.rejects(runSetup({ ...options, install: true, nodeVersion: 'v22.22.1' }), { code: 'NODE_VERSION_UNSUPPORTED' });
  assert.equal(commands.length, 0);
});

await test('命令参数解析与只读模式冲突检查', async () => {
  assert.deepEqual(parseSetupArgs([]), {});
  assert.deepEqual(parseSetupArgs(['--check', '--listening', '--python', PYTHON]), { check: true, listening: true, python: PYTHON });
  assert.deepEqual(parseSetupArgs(['--install', '--login-cli']), { install: true, loginCli: true });
  for (const args of [['--check', '--install'], ['--check', '--login-cli'], ['--check', '--install-listening'], ['--check', '--import-model', SOURCE]]) {
    assert.throws(() => parseSetupArgs(args), { code: 'CHECK_IS_READ_ONLY' });
  }
  assert.throws(() => parseSetupArgs(['--python']), { code: 'ARGUMENT_VALUE_REQUIRED' });
  assert.throws(() => parseSetupArgs(['--unknown']), { code: 'UNKNOWN_ARGUMENT' });
  assert.throws(() => parseSetupArgs(['--model', SOURCE, '--import-model', SOURCE]), { code: 'MODEL_OPTIONS_CONFLICT' });
});

await test('安装计划固定官方版本、项目局部目录且不执行', async () => {
  const { options, commands } = fixture();
  const plan = await setupPlan({ ...options, install: true });
  assert.equal(commands.length, 0);
  const steps = plan.steps.filter(step => step.selected);
  assert.equal(steps.length, 2);
  assert.equal(steps[0].executable, NODE); assert.equal(steps[0].args[0], NPM);
  assert.ok(steps[0].args.includes('--include=dev'));
  assert.ok(steps[1].args.includes('@tencent-ai/codebuddy-code@2.184.0'));
  assert.ok(steps[1].args.includes(p.join(ROOT, '.tmp', 'cbcli')));
  assert.equal(plan.globalInstall, false); assert.equal(plan.modelDownload, false);
});

await test('新机缺依赖时显式安装两步，以参数数组保留中文与空格路径', async () => {
  const { options, commands, mem } = fixture({ dependencies: false, cli: false });
  mem.putFile(p.join(ROOT, '.env'), 'unchanged');
  const report = await runSetup({ ...options, install: true });
  assert.equal(commands.length, 2); assert.equal(report.actions.length, 2);
  for (const command of commands) {
    assert.equal(command.cwd, ROOT); assert.equal(command.executable, NODE); assert.equal(command.args[0], NPM);
    assert.equal(command.shell, false); assert.equal(command.stdio, 'pipe');
  }
  assert.equal(await mem.fs.readFile(p.join(ROOT, '.env'), 'utf8'), 'unchanged');
  assert.equal(report.inspection.cli.authentication, 'unknown');
});

await test('最小环境去掉桌面注入与所有未批准鉴权变量', async () => {
  const { options, commands } = fixture();
  const cleaned = cleanSetupEnv({ Path: 'literal', UserProfile: 'person', CODEBUDDY_FORCE_LITE_WB_BUNDLE: '1', CLAUDE_API_KEY: 'x', OPENAI_API_KEY: 'y' });
  assert.deepEqual(cleaned, { Path: 'literal', UserProfile: 'person' });
  await runSetup({ ...options, install: true });
  assert.deepEqual(Object.keys(commands[0].env).sort(), ['PATH', 'PROGRAMFILES', 'SYSTEMROOT', 'TEMP', 'USERPROFILE']);
});

await test('缺npm明确报错且不回退到shell或Codex专用依赖', async () => {
  const { options, commands } = fixture({ npm: false });
  const inspected = await inspectSetup(options);
  assert.equal(inspected.npm.status, 'missing');
  await assert.rejects(runSetup({ ...options, install: true }), { code: 'NPM_UNAVAILABLE' });
  assert.equal(commands.length, 0);
});

await test('可显式指定npm-cli.js，拒绝把npm.cmd当JS入口', async () => {
  const { options, mem, commands } = fixture({ npm: false });
  const explicit = windowsPath(68, '自定义 npm', 'npm-cli.js');
  mem.putFile(explicit);
  await runSetup({ ...options, install: true, npmCli: explicit });
  assert.equal(commands[0].args[0], explicit);
  const shim = windowsPath(68, '自定义 npm', 'npm.cmd'); mem.putFile(shim);
  await assert.rejects(runSetup({ ...options, install: true, npmCli: shim }), { code: 'NPM_UNAVAILABLE' });
});

await test('登录仅交互运行官方JS入口，无发题参数、登录状态始终未知', async () => {
  const { options, commands } = fixture();
  const report = await runSetup({ ...options, loginCli: true });
  assert.equal(commands.length, 1); assert.equal(commands[0].id, 'interactive-cli-login');
  assert.equal(commands[0].executable, NODE); assert.deepEqual(commands[0].args, [CLI]);
  assert.equal(commands[0].stdio, 'inherit'); assert.equal(commands[0].interactive, true);
  assert.equal(report.actions[0].authentication, 'unknown');
  assert.equal(report.inspection.cli.authentication, 'unknown');
});

await test('CLI存在与已登录分开，版本不同不宣称静态环境完整', async () => {
  const { options, mem } = fixture();
  mem.putJson(p.join(p.dirname(p.dirname(CLI)), 'package.json'), { version: '2.999.0' });
  const report = await inspectSetup(options);
  assert.equal(report.cli.status, 'present'); assert.equal(report.cli.authentication, 'unknown');
  assert.ok(report.blockers.includes('CLI_VERSION_UNVERIFIED'));
});

await test('登录拒绝冒充官方版本的其他JS包', async () => {
  const { options, mem, commands } = fixture();
  mem.putJson(p.join(p.dirname(p.dirname(CLI)), 'package.json'), { name: 'other-package', version: OFFICIAL_CLI_VERSION });
  await assert.rejects(runSetup({ ...options, loginCli: true }), { code: 'CLI_VERSION_UNVERIFIED' });
  assert.equal(commands.length, 0);
});

await test('缺CLI或.cmd入口均不启动登录进程', async () => {
  const absent = fixture({ cli: false });
  await assert.rejects(runSetup({ ...absent.options, loginCli: true }), { code: 'CLI_MISSING' });
  assert.equal(absent.commands.length, 0);
  const shim = fixture(); const shimPath = windowsPath(68, 'CLI', 'codebuddy.cmd'); shim.mem.putFile(shimPath);
  await assert.rejects(runSetup({ ...shim.options, loginCli: true, cliPath: shimPath }), { code: 'CLI_ENTRY_INVALID' });
  assert.equal(shim.commands.length, 0);
});

await test('登录Ctrl+C退出不推断登录成功', async () => {
  const { options } = fixture();
  const report = await runSetup({ ...options, loginCli: true, runner: async () => ({ exitCode: 130, signal: 'SIGINT' }) });
  assert.equal(report.actions[0].status, 'interaction-ended'); assert.equal(report.inspection.cli.authentication, 'unknown');
});

await test('可选听力缺失不阻断默认文字静态预检，显式检查则列出缺口', async () => {
  const { options, commands } = fixture({ python: false });
  const plain = await inspectSetup(options);
  assert.equal(plain.staticPrerequisites, 'present'); assert.equal(plain.listening.optional, true);
  const listening = await inspectSetup({ ...options, listening: true });
  assert.ok(listening.blockers.includes('LISTENING_PREREQUISITES_INCOMPLETE'));
  assert.equal(listening.listening.python.status, 'missing'); assert.equal(commands.length, 0);
});

await test('听力安装仅pip --target与项目requirements，不下载模型', async () => {
  const { options, commands } = fixture();
  const report = await runSetup({ ...options, installListening: true, python: PYTHON });
  assert.equal(commands.length, 1); assert.equal(commands[0].executable, PYTHON);
  assert.deepEqual(commands[0].args, ['-m', 'pip', 'install', '--target', p.join(ROOT, '.tmp', 'listening-python'), '-r', p.join(ROOT, 'listening', 'requirements.txt'), '--disable-pip-version-check']);
  assert.equal(report.plan.modelDownload, false); assert.equal(report.inspection.listening.modelDownloaded, false);
});

await test('缺Python不运行安装，也不调用系统桌面工具', async () => {
  const { options, commands } = fixture({ python: false });
  await assert.rejects(runSetup({ ...options, installListening: true }), { code: 'PYTHON_UNAVAILABLE' });
  assert.equal(commands.length, 0);
});

await test('缺Edge只报告路径缺口，不创建或重启任何浏览器', async () => {
  const { options, commands } = fixture({ edge: false });
  const report = await runSetup(options);
  assert.ok(report.inspection.blockers.includes('EDGE_NOT_FOUND'));
  assert.equal(report.inspection.edge.launched, false); assert.equal(commands.length, 0);
});

await test('本地模型检查只核对文件，不加载引擎或下载', async () => {
  const { options, mem, commands } = fixture(); addModel(mem);
  mem.putFile(p.join(ROOT, '.tmp', 'listening-python', 'faster_whisper', '__init__.py'));
  mem.putFile(p.join(ROOT, '.tmp', 'listening-python', 'av', '__init__.py'));
  const report = await runSetup({ ...options, check: true, listening: true, model: SOURCE });
  assert.equal(report.inspection.listening.model.status, 'present');
  assert.equal(report.inspection.listening.runtime, 'unverified');
  assert.equal(report.inspection.listening.python.execution, 'not-tested'); assert.equal(commands.length, 0);
});

await test('模型导入仅复制白名单顶层文件，不带入其他文件或子目录', async () => {
  const { options, mem, commands } = fixture(); addModel(mem);
  mem.putFile(p.join(SOURCE, 'README.md'), 'skip'); mem.putFile(p.join(SOURCE, 'nested', 'anything'), 'skip');
  const report = await runSetup({ ...options, importModel: SOURCE });
  assert.equal(commands.length, 0);
  const action = report.actions[0]; assert.equal(action.id, 'import-local-model');
  assert.equal(action.copied.length, 4); assert.equal(action.overwritten, false);
  assert.equal(await mem.fs.readFile(p.join(TARGET, 'model.bin'), 'utf8'), 'model.bin');
  assert.ok(!mem.nodes.has(p.join(TARGET, 'README.md').toLowerCase()));
});

await test('相同模型以哈希复用，无重复复制或覆盖', async () => {
  const { options, mem } = fixture(); addModel(mem); addModel(mem, TARGET);
  const report = await runSetup({ ...options, importModel: SOURCE });
  assert.equal(report.actions[0].copied.length, 0); assert.equal(report.actions[0].reused.length, 4);
  assert.equal(mem.writes.length, 0);
});

await test('目标不同模型先完整核查再拒绝，零写入且不删除', async () => {
  const { options, mem } = fixture(); addModel(mem); addModel(mem, TARGET, '-different');
  await assert.rejects(runSetup({ ...options, importModel: SOURCE }), { code: 'MODEL_TARGET_CONFLICT' });
  assert.equal(mem.writes.length, 0);
  assert.equal(await mem.fs.readFile(p.join(TARGET, 'model.bin'), 'utf8'), 'model.bin-different');
});

await test('模型源符号链接、链接文件、父目录跳转和网络路径均拒绝', async () => {
  for (const mode of ['root-link', 'file-link', 'parent-link']) {
    const { options, mem } = fixture(); addModel(mem);
    if (mode === 'root-link') mem.putLink(SOURCE, windowsPath(68, 'another'), true);
    if (mode === 'file-link') mem.putLink(p.join(SOURCE, 'model.bin'), windowsPath(68, 'secret'));
    if (mode === 'parent-link') mem.nodes.get(SOURCE.toLowerCase()).realpath = windowsPath(68, 'other', 'small');
    await assert.rejects(runSetup({ ...options, importModel: SOURCE }), error => ['MODEL_DIRECTORY_UNSAFE', 'MODEL_ENTRY_UNSAFE'].includes(error.code));
    assert.equal(mem.writes.length, 0);
  }
  for (const source of ['..\\small', 'https://example.test/model', '\\\\server\\share\\model']) {
    const { options, mem } = fixture();
    await assert.rejects(runSetup({ ...options, importModel: source }), { code: 'LOCAL_MODEL_PATH_REQUIRED' });
    assert.equal(mem.writes.length, 0);
  }
});

await test('模型缺必需文件时不创建目标目录', async () => {
  const { options, mem } = fixture(); addModel(mem); mem.remove(p.join(SOURCE, 'tokenizer.json'));
  await assert.rejects(runSetup({ ...options, importModel: SOURCE }), { code: 'MODEL_FILES_MISSING' });
  assert.equal(mem.writes.length, 0);
});

await test('模型目标或项目临时目录的符号链接被拒绝', async () => {
  for (const directory of [p.join(ROOT, '.tmp'), TARGET]) {
    const { options, mem } = fixture(); addModel(mem);
    mem.putLink(directory, windowsPath(68, 'other'), true);
    await assert.rejects(runSetup({ ...options, importModel: SOURCE }), { code: 'MODEL_DIRECTORY_UNSAFE' });
    assert.equal(mem.writes.length, 0);
  }
});

await test('命令失败和抛错仅输出安全摘要，不泄漏stdout/stderr或异常正文', async () => {
  const { options } = fixture();
  const logs = [];
  const secret = 'Bearer private signed https://host/path?token=SECRET';
  const failed = await main(['--install'], { ...options, print: value => logs.push(value), runner: async () => ({ exitCode: 1, stdout: secret, stderr: secret }) });
  assert.equal(failed.ok, false); assert.equal(failed.error.code, 'COMMAND_FAILED');
  const thrown = await main(['--install'], { ...options, print: value => logs.push(value), runner: async () => { throw new Error(secret); } });
  assert.equal(thrown.ok, false); assert.equal(thrown.error.code, 'COMMAND_START_FAILED');
  assert.ok(!JSON.stringify(logs).includes('SECRET'));
});

await test('帮助和JSON检查均不执行安装，报告不输出环境密钥', async () => {
  const { options, commands } = fixture(); const logs = [];
  await main(['--help'], { ...options, print: value => logs.push(value) });
  assert.equal(commands.length, 0);
  const report = await main(['--check', '--json'], { ...options, print: value => logs.push(value) });
  assert.equal(report.ok, true); assert.equal(commands.length, 0);
  assert.ok(!JSON.stringify(logs).includes('private-key')); assert.ok(!JSON.stringify(logs).includes('private-token'));
});

console.log(JSON.stringify({ passed: true, groups, newBrowsers: audit.newBrowsers, networkRequests: audit.networkRequests, paidCalls: audit.paidCalls }));
