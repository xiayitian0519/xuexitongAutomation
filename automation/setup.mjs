import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, constants as fsConstants } from 'node:fs';
import * as defaultFs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SETUP_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const OFFICIAL_CLI_PACKAGE = '@tencent-ai/codebuddy-code';
export const OFFICIAL_CLI_VERSION = '2.184.0';
export const REQUIRED_MODEL_FILES = Object.freeze(['model.bin', 'config.json', 'tokenizer.json']);
export const MODEL_FILE_ALLOWLIST = Object.freeze([
  ...REQUIRED_MODEL_FILES, 'preprocessor_config.json', 'vocabulary.json', 'vocabulary.txt',
  'tokenizer_config.json', 'special_tokens_map.json', 'generation_config.json', 'added_tokens.json',
]);

const ENV_ALLOWLIST = new Set([
  'HOME', 'USERPROFILE', 'PATH', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'SYSTEMROOT',
  'SYSTEMDRIVE', 'COMSPEC', 'PATHEXT', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)',
  'USERNAME', 'USERDOMAIN', 'HOMEDRIVE', 'HOMEPATH', 'NUMBER_OF_PROCESSORS', 'OS',
  'PROCESSOR_ARCHITECTURE', 'LANG', 'LC_ALL',
]);

class SetupError extends Error {
  constructor(code, message) { super(message); this.name = 'SetupError'; this.code = code; }
}

function fail(code, message) { throw new SetupError(code, message); }

export function cleanSetupEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([key, value]) =>
    ENV_ALLOWLIST.has(key.toUpperCase()) && typeof value === 'string'));
}

export function nodeVersionSupported(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(version));
  if (!match) return false;
  const [major, minor, patch] = match.slice(1).map(Number);
  return major >= 26 || major === 24 && minor >= 15 ||
    major === 22 && (minor > 22 || minor === 22 && patch >= 2);
}

export function parseSetupArgs(args = []) {
  const result = {};
  const booleans = new Map([
    ['--check', 'check'], ['--install', 'install'], ['--login-cli', 'loginCli'],
    ['--install-listening', 'installListening'], ['--listening', 'listening'],
    ['--json', 'json'], ['--help', 'help'], ['-h', 'help'],
  ]);
  const values = new Map([
    ['--python', 'python'], ['--model', 'model'], ['--import-model', 'importModel'],
    ['--npm-cli', 'npmCli'], ['--edge', 'edgePath'],
  ]);
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (booleans.has(arg)) result[booleans.get(arg)] = true;
    else if (values.has(arg)) {
      const value = args[++index];
      if (!value || value.startsWith('--')) fail('ARGUMENT_VALUE_REQUIRED', '参数缺少路径值；请运行 --help。');
      result[values.get(arg)] = value;
    } else fail('UNKNOWN_ARGUMENT', '存在不支持的参数；请运行 --help。');
  }
  validateOptions(result);
  return result;
}

function validateOptions(options) {
  if (options.check && (options.install || options.loginCli || options.installListening || options.importModel)) {
    fail('CHECK_IS_READ_ONLY', '--check 只能检查，不能同时安装、登录或导入模型。');
  }
  if (options.model && options.importModel) fail('MODEL_OPTIONS_CONFLICT', '--model 与 --import-model 请分开使用。');
}

function context(options = {}) {
  validateOptions(options);
  const platform = options.platform || process.platform;
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const env = options.env || process.env;
  return {
    ...options, platform, paths, env, fs: options.fs || defaultFs,
    root: paths.resolve(options.root || SETUP_ROOT), execPath: options.execPath || process.execPath,
    nodeVersion: options.nodeVersion || process.version, runner: options.runner || executeCommand,
  };
}

async function stat(ctx, file) {
  try { return await ctx.fs.lstat(file); }
  catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
    fail('FILESYSTEM_UNAVAILABLE', '无法读取一个预检路径；请检查目录权限。');
  }
}

async function isFile(ctx, file) {
  const value = await stat(ctx, file);
  return Boolean(value?.isFile() && !value.isSymbolicLink());
}

async function metadata(ctx, file) {
  if (!await isFile(ctx, file)) return null;
  try { return JSON.parse(await ctx.fs.readFile(file, 'utf8')); }
  catch { return { invalid: true }; }
}

function envValue(env, name) {
  const key = Object.keys(env).find(value => value.toUpperCase() === name.toUpperCase());
  return key ? env[key] : undefined;
}

function pathDirectories(ctx) {
  return String(envValue(ctx.env, 'PATH') || '').split(ctx.platform === 'win32' ? ';' : ':').filter(Boolean);
}

async function findExecutable(ctx, selected, names) {
  if (selected && (ctx.paths.isAbsolute(selected) || /[\\/]/.test(selected))) {
    const candidate = ctx.paths.resolve(ctx.root, selected);
    return await isFile(ctx, candidate) ? candidate : null;
  }
  const candidates = selected ? [selected] : names;
  for (const directory of pathDirectories(ctx)) {
    for (const name of candidates) {
      const suffixes = ctx.platform === 'win32' && !ctx.paths.extname(name) ? ['.exe', ''] : [''];
      for (const suffix of suffixes) {
        const candidate = ctx.paths.join(directory, name + suffix);
        if (await isFile(ctx, candidate)) return candidate;
      }
    }
  }
  return null;
}

async function discoverNpm(ctx) {
  const candidates = [];
  if (ctx.npmCli) candidates.push(ctx.paths.resolve(ctx.root, ctx.npmCli));
  else {
    const fromEnv = envValue(ctx.env, 'npm_execpath');
    if (fromEnv && ctx.paths.basename(fromEnv).toLowerCase() === 'npm-cli.js') candidates.push(fromEnv);
    for (const directory of [ctx.paths.dirname(ctx.execPath), ...pathDirectories(ctx)]) {
      candidates.push(ctx.paths.join(directory, 'node_modules', 'npm', 'bin', 'npm-cli.js'));
      candidates.push(ctx.paths.join(directory, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
      candidates.push(ctx.paths.join(directory, '..', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
    }
  }
  for (const candidate of [...new Set(candidates)]) {
    if (ctx.paths.basename(candidate).toLowerCase() === 'npm-cli.js' && await isFile(ctx, candidate)) return candidate;
  }
  return null;
}

async function discoverEdge(ctx) {
  const candidates = [ctx.edgePath || envValue(ctx.env, 'XUEXITONG_EDGE_PATH') || envValue(ctx.env, 'EDGE_PATH')];
  if (ctx.platform === 'win32') {
    for (const key of ['PROGRAMFILES(X86)', 'PROGRAMFILES', 'LOCALAPPDATA']) {
      const base = envValue(ctx.env, key);
      if (base) candidates.push(ctx.paths.join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    }
  } else if (ctx.platform === 'darwin') candidates.push('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
  else candidates.push('/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable', '/opt/microsoft/msedge/msedge');
  for (const candidate of candidates.filter(Boolean)) {
    const resolved = ctx.paths.resolve(ctx.root, candidate);
    if (await isFile(ctx, resolved)) return resolved;
  }
  return null;
}

function cliEntry(ctx) {
  const selected = ctx.cliPath || envValue(ctx.env, 'WB_CLI_PATH');
  const entry = selected ? ctx.paths.resolve(ctx.root, selected) : ctx.paths.join(ctx.root, '.tmp', 'cbcli', 'node_modules', '@tencent-ai', 'codebuddy-code', 'bin', 'codebuddy');
  if (/\.(?:cmd|bat|exe|ps1)$/i.test(entry)) return { entry, invalid: true, selected: Boolean(selected) };
  return { entry, selected: Boolean(selected) };
}

function localPath(ctx, value) {
  if (typeof value !== 'string' || !value.trim() || /^[a-z][a-z\d+.-]*:\/\//i.test(value) ||
    /^[/\\]{2}/.test(value) || value.split(/[\\/]/).includes('..') || value.includes('\0')) {
    fail('LOCAL_MODEL_PATH_REQUIRED', '模型路径须为本地目录，不能含网络地址、父目录跳转或空字符。');
  }
  return ctx.paths.resolve(ctx.root, value);
}

function pathEqual(ctx, left, right) {
  const normalize = value => ctx.paths.normalize(value).replace(/[\\/]$/, '');
  return ctx.platform === 'win32' ? normalize(left).toLowerCase() === normalize(right).toLowerCase() : normalize(left) === normalize(right);
}

async function assertPhysicalDirectory(ctx, directory, optional = false) {
  const value = await stat(ctx, directory);
  if (!value && optional) return false;
  if (!value?.isDirectory() || value.isSymbolicLink()) fail('MODEL_DIRECTORY_UNSAFE', '模型目录不存在、不是目录或包含符号链接。');
  let actual;
  try { actual = await ctx.fs.realpath(directory); }
  catch { fail('MODEL_DIRECTORY_UNSAFE', '无法验证模型目录的真实路径。'); }
  if (!pathEqual(ctx, actual, directory)) fail('MODEL_DIRECTORY_UNSAFE', '模型目录路径经过了符号链接，已拒绝处理。');
  return true;
}

async function inspectModel(ctx, directory) {
  const missing = [];
  let unsafe = false;
  try {
    if (!await assertPhysicalDirectory(ctx, directory, true)) return { directory, status: 'missing', missing: [...REQUIRED_MODEL_FILES] };
    for (const name of REQUIRED_MODEL_FILES) {
      const value = await stat(ctx, ctx.paths.join(directory, name));
      if (value?.isSymbolicLink()) unsafe = true;
      if (!value?.isFile() || !value.size) missing.push(name);
    }
  } catch (error) {
    if (error instanceof SetupError) unsafe = true;
    else throw error;
  }
  return { directory, status: unsafe ? 'unsafe' : missing.length ? 'missing' : 'present', missing };
}

async function inspect(ctx) {
  const packageFile = ctx.paths.join(ctx.root, 'package.json');
  const packageInfo = await metadata(ctx, packageFile);
  const requirements = packageInfo && !packageInfo.invalid ? { ...packageInfo.dependencies, ...packageInfo.devDependencies } : {};
  const dependencies = [];
  for (const name of ['playwright-core', 'jsdom', 'jquery']) {
    const wanted = requirements[name];
    const installed = await metadata(ctx, ctx.paths.join(ctx.root, 'node_modules', name, 'package.json'));
    const installedVersion = typeof installed?.version === 'string' ? installed.version : null;
    const exactWanted = typeof wanted === 'string' && /^\d+\.\d+\.\d+$/.test(wanted);
    dependencies.push({ name, required: wanted || null, installed: installedVersion,
      status: !wanted ? 'undeclared' : !installedVersion ? 'missing' : exactWanted && wanted !== installedVersion ? 'different-version' : 'present' });
  }
  const npmCli = await discoverNpm(ctx);
  const cli = cliEntry(ctx);
  const cliExists = !cli.invalid && await isFile(ctx, cli.entry);
  const cliInfo = cliExists ? await metadata(ctx, ctx.paths.join(ctx.paths.dirname(ctx.paths.dirname(cli.entry)), 'package.json')) : null;
  const edge = await discoverEdge(ctx);
  const python = await findExecutable(ctx, ctx.python || envValue(ctx.env, 'LISTENING_PYTHON'), ctx.platform === 'win32' ? ['python.exe', 'python3.exe'] : ['python3', 'python']);
  const dependencyDir = ctx.paths.join(ctx.root, '.tmp', 'listening-python');
  const listeningDependencies = await isFile(ctx, ctx.paths.join(dependencyDir, 'faster_whisper', '__init__.py')) &&
    await isFile(ctx, ctx.paths.join(dependencyDir, 'av', '__init__.py'));
  const modelDir = localPath(ctx, ctx.model || (ctx.importModel ? ctx.paths.join(ctx.root, '.tmp', 'listening-model-small') : envValue(ctx.env, 'LISTENING_MODEL')) || ctx.paths.join(ctx.root, '.tmp', 'listening-model-small'));
  const model = await inspectModel(ctx, modelDir);
  const nodeSupported = nodeVersionSupported(ctx.nodeVersion);
  const blockers = [];
  if (!packageInfo || packageInfo.invalid) blockers.push('PROJECT_PACKAGE_UNAVAILABLE');
  if (!nodeSupported) blockers.push('NODE_VERSION_UNSUPPORTED');
  if (dependencies.some(item => item.status !== 'present')) blockers.push('PROJECT_DEPENDENCIES_INCOMPLETE');
  if (!cliExists) blockers.push(cli.invalid ? 'CLI_ENTRY_INVALID' : 'CLI_MISSING');
  if (cliExists && (cliInfo?.version !== OFFICIAL_CLI_VERSION || cliInfo?.name !== OFFICIAL_CLI_PACKAGE)) blockers.push('CLI_VERSION_UNVERIFIED');
  if (!edge) blockers.push('EDGE_NOT_FOUND');
  const listeningRequested = Boolean(ctx.listening || ctx.installListening || ctx.model || ctx.importModel);
  const listeningMissing = !python || !listeningDependencies || model.status !== 'present';
  if (listeningRequested && listeningMissing) blockers.push('LISTENING_PREREQUISITES_INCOMPLETE');
  return {
    root: ctx.root, project: { status: packageInfo && !packageInfo.invalid ? 'present' : 'missing' },
    node: { version: ctx.nodeVersion, supported: nodeSupported, recommended: 'Node.js 24.15.0 或更新的 24.x；也支持 22.22.2+ 的 22.x 和 26+' },
    npm: { status: npmCli ? 'present' : 'missing', cli: npmCli }, dependencies,
    cli: { path: cli.entry, status: cli.invalid ? 'invalid-entry' : cliExists ? 'present' : 'missing',
      version: typeof cliInfo?.version === 'string' ? cliInfo.version : null,
      package: cliInfo?.name === OFFICIAL_CLI_PACKAGE ? OFFICIAL_CLI_PACKAGE : null, expectedVersion: OFFICIAL_CLI_VERSION,
      authentication: 'unknown', accountPermission: 'unknown' },
    edge: { path: edge, status: edge ? 'present' : 'missing', browserSession: 'unverified', launched: false },
    listening: { requested: listeningRequested, optional: !listeningRequested,
      python: { path: python, status: python ? 'present' : 'missing', execution: 'not-tested' },
      dependencies: { directory: dependencyDir, status: listeningDependencies ? 'present' : 'missing', runtime: 'unverified' },
      model, runtime: 'unverified', modelDownloaded: false },
    staticPrerequisites: blockers.length ? 'incomplete' : 'present', blockers,
    runtime: 'unverified', credentialsRead: false, browserLaunched: false, modelRequests: 0,
  };
}

export async function inspectSetup(options = {}) { return inspect(context(options)); }

function buildPlan(ctx, inspection) {
  const npm = inspection.npm.cli;
  const npmPrefix = npm ? [npm] : ['<npm-cli.js>'];
  const cliPrefix = ctx.paths.join(ctx.root, '.tmp', 'cbcli');
  const common = ['--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false'];
  const command = (id, selected, executable, args, extra = {}) => ({
    id, selected: Boolean(selected), executable, args, cwd: ctx.root, shell: false, ...extra,
  });
  const steps = [
    command('project-dependencies', ctx.install, ctx.execPath,
      [...npmPrefix, 'install', '--include=dev', ...common], { requires: npm ? [] : ['npm-cli.js'] }),
    command('official-cli', ctx.install, ctx.execPath,
      [...npmPrefix, 'install', '--prefix', cliPrefix, '--no-save', ...common, `${OFFICIAL_CLI_PACKAGE}@${OFFICIAL_CLI_VERSION}`], { requires: npm ? [] : ['npm-cli.js'] }),
    command('listening-dependencies', ctx.installListening, inspection.listening.python.path || '<python>',
      ['-m', 'pip', 'install', '--target', inspection.listening.dependencies.directory, '-r', ctx.paths.join(ctx.root, 'listening', 'requirements.txt'), '--disable-pip-version-check'],
      { optional: true, requires: inspection.listening.python.path ? [] : ['python'] }),
  ];
  if (ctx.importModel) steps.push({ id: 'import-local-model', selected: true, source: localPath(ctx, ctx.importModel),
    target: ctx.paths.join(ctx.root, '.tmp', 'listening-model-small'), allowlist: [...MODEL_FILE_ALLOWLIST], overwrite: false });
  steps.push(command('interactive-cli-login', ctx.loginCli, ctx.execPath, [inspection.cli.path],
    { interactive: true, authenticationAfterExit: 'unknown', modelRequest: false }));
  return { steps, cliVersion: OFFICIAL_CLI_VERSION, globalInstall: false, modelDownload: false,
    notices: ['安装不会验证账号登录，也不会发送模型请求。',
      '登录命令需要本人在真实终端操作；认证链接由本人确认后授权。',
      '听力模型须使用已有本地来源，安装 Python 依赖不会隐式下载模型。',
      '预检只检查静态文件；账号权限、专用 Edge 连接及实际转写仍待运行验证。'] };
}

export async function setupPlan(options = {}) {
  const ctx = context(options);
  return buildPlan(ctx, await inspect(ctx));
}

async function executeCommand(command) {
  return new Promise(resolve => {
    let child;
    let timer;
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    try {
      child = spawn(command.executable, command.args, {
        cwd: command.cwd, env: command.env, shell: false,
        windowsHide: !command.interactive, stdio: command.interactive ? 'inherit' : ['ignore', 'pipe', 'pipe'],
      });
      child.stdout?.resume();
      child.stderr?.resume();
      child.once('error', () => finish({ exitCode: null, errorCode: 'SPAWN_FAILED' }));
      child.once('close', (exitCode, signal) => finish({ exitCode, signal: signal || null }));
      timer = setTimeout(() => { child.kill(); finish({ exitCode: null, errorCode: 'TIMEOUT' }); }, command.timeoutMs || 900_000);
    } catch { finish({ exitCode: null, errorCode: 'SPAWN_FAILED' }); }
  });
}

async function digest(ctx, file) {
  if (ctx.hashFile) return ctx.hashFile(file);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function importModel(ctx, sourceInput) {
  const source = localPath(ctx, sourceInput);
  const target = ctx.paths.join(ctx.root, '.tmp', 'listening-model-small');
  await assertPhysicalDirectory(ctx, source);
  await assertPhysicalDirectory(ctx, ctx.root);
  const tempRoot = ctx.paths.join(ctx.root, '.tmp');
  await assertPhysicalDirectory(ctx, tempRoot, true);
  await assertPhysicalDirectory(ctx, target, true);
  const sourceNames = await ctx.fs.readdir(source);
  const sourceFiles = new Map();
  for (const name of sourceNames) {
    if (typeof name !== 'string' || name === '.' || name === '..' || /[\\/]/.test(name)) fail('MODEL_ENTRY_UNSAFE', '模型目录包含不安全的条目名。');
    const value = await stat(ctx, ctx.paths.join(source, name));
    if (value?.isSymbolicLink()) fail('MODEL_ENTRY_UNSAFE', '模型目录包含符号链接，已拒绝导入。');
    if (MODEL_FILE_ALLOWLIST.includes(name) && value?.isFile() && value.size > 0) sourceFiles.set(name, value);
  }
  if (REQUIRED_MODEL_FILES.some(name => !sourceFiles.has(name))) fail('MODEL_FILES_MISSING', '模型目录缺少非空的 model.bin、config.json 或 tokenizer.json。');
  const pending = [];
  const reused = [];
  for (const name of sourceFiles.keys()) {
    const from = ctx.paths.join(source, name);
    const to = ctx.paths.join(target, name);
    const existing = await stat(ctx, to);
    const hash = await digest(ctx, from);
    if (existing) {
      if (!existing.isFile() || existing.isSymbolicLink() || await digest(ctx, to) !== hash) {
        fail('MODEL_TARGET_CONFLICT', '目标已有不同模型或不安全条目；未覆盖、未删除。请另设 LISTENING_MODEL。');
      }
      reused.push(name);
    } else pending.push({ from, to, name, hash });
  }
  if (pending.length) {
    await ctx.fs.mkdir(target, { recursive: true });
    await assertPhysicalDirectory(ctx, target);
    for (const file of pending) {
      const sourceStat = await stat(ctx, file.from);
      if (!sourceStat?.isFile() || sourceStat.isSymbolicLink() ||
        !pathEqual(ctx, await ctx.fs.realpath(file.from), file.from)) {
        fail('MODEL_ENTRY_UNSAFE', '复制前模型源文件发生变化或经过符号链接，已停止导入。');
      }
      try { await ctx.fs.copyFile(file.from, file.to, fsConstants.COPYFILE_EXCL); }
      catch { fail('MODEL_COPY_FAILED', '模型文件复制未完成；未覆盖已有文件。请检查本地目录后重新预检。'); }
      if (await digest(ctx, file.to) !== file.hash) fail('MODEL_COPY_HASH_MISMATCH', '复制后的模型内容校验未通过；未删除文件，请手动核查。');
    }
  }
  return { target, copied: pending.map(item => item.name), reused, omitted: sourceNames.filter(name => !sourceFiles.has(name)), overwritten: false };
}

export async function runSetup(options = {}) {
  const ctx = context(options);
  const initial = await inspect(ctx);
  const plan = buildPlan(ctx, initial);
  const actions = [];
  const selected = plan.steps.filter(step => step.selected);
  if (selected.length && !initial.node.supported) fail('NODE_VERSION_UNSUPPORTED', '当前 Node.js 不满足依赖要求。建议先安装 24.15.0 或更新的 24.x。');
  if ((ctx.install || ctx.installListening) && initial.project.status !== 'present') fail('PROJECT_PACKAGE_UNAVAILABLE', '项目 package.json 缺失或不可读，未执行安装。');
  if (ctx.install && !initial.npm.cli) fail('NPM_UNAVAILABLE', '找不到 npm-cli.js；请使用包含 npm 的 Node.js，或通过 --npm-cli 指定 npm 的 JS 入口。');
  if (ctx.installListening && !initial.listening.python.path) fail('PYTHON_UNAVAILABLE', '找不到 Python；请使用 --python 指定本地解释器。');
  for (const step of selected) {
    if (step.id === 'import-local-model') {
      actions.push({ id: step.id, status: 'completed', ...await importModel(ctx, ctx.importModel) });
      continue;
    }
    if (step.id === 'interactive-cli-login' && !await isFile(ctx, initial.cli.path)) fail('CLI_MISSING', 'CLI JS 入口不存在，请先执行 --install。');
    if (step.id === 'interactive-cli-login' && initial.cli.status === 'invalid-entry') fail('CLI_ENTRY_INVALID', 'WB_CLI_PATH 必须指向官方 CLI 的 Node.js 入口，不能指向 .cmd、.exe 或脚本宿主。');
    if (step.id === 'interactive-cli-login') {
      const info = await metadata(ctx, ctx.paths.join(ctx.paths.dirname(ctx.paths.dirname(initial.cli.path)), 'package.json'));
      if (info?.name !== OFFICIAL_CLI_PACKAGE || info?.version !== OFFICIAL_CLI_VERSION) {
        fail('CLI_VERSION_UNVERIFIED', '登录入口不是已验证的官方 CLI 2.184.0；请先执行 --install 并核对 WB_CLI_PATH。');
      }
    }
    let result;
    try { result = await ctx.runner({ ...step, env: cleanSetupEnv(ctx.env), stdio: step.interactive ? 'inherit' : 'pipe' }); }
    catch { fail('COMMAND_START_FAILED', '安装或登录进程无法启动；原始输出未写入报告，请检查本地程序路径。'); }
    const exitCode = Number.isInteger(result?.exitCode) ? result.exitCode : null;
    const interruptedLogin = step.interactive && (exitCode === 130 || result?.signal === 'SIGINT');
    if (exitCode !== 0 && !interruptedLogin) fail('COMMAND_FAILED', `${step.interactive ? '登录进程' : '安装步骤'}未成功结束（退出码 ${exitCode ?? '未知'}）；原始输出未写入报告。`);
    actions.push({ id: step.id, status: step.interactive ? 'interaction-ended' : 'completed', exitCode,
      ...(step.interactive ? { authentication: 'unknown' } : {}) });
  }
  const inspection = selected.length ? await inspect(ctx) : initial;
  return { ok: true, kind: 'workflow-setup', mode: selected.length ? 'explicit-actions' : 'check', root: ctx.root,
    inspection, plan, actions, exitCode: inspection.blockers.length ? 2 : 0 };
}

export function formatSetupReport(report) {
  const value = report.inspection;
  const lines = [
    '学习通工作流安装与预检', `项目：${report.root}`,
    `Node.js：${value.node.version}（${value.node.supported ? '符合依赖要求' : '不符合依赖要求'}）`,
    ...value.dependencies.map(item => `项目依赖 ${item.name}：${item.status}${item.installed ? `，版本 ${item.installed}` : ''}`),
    `官方 CLI：${value.cli.status}${value.cli.version ? `，版本 ${value.cli.version}` : ''}；实际登录状态未知`,
    `Edge 程序：${value.edge.status}；专用浏览器连接未验证，未启动浏览器`,
    `听力${value.listening.optional ? '（可选）' : ''}：Python ${value.listening.python.status}，依赖 ${value.listening.dependencies.status}，本地模型 ${value.listening.model.status}；实际转写未验证`,
    `静态依赖：${value.staticPrerequisites}；这不代表账号、页面连接或完整流程已可运行`,
    '未读取登录凭证，未下载模型，未发送模型请求。',
    '安装计划（仅带显式选项的步骤才执行）：',
    ...report.plan.steps.map(step => `${step.selected ? '[已选择]' : '[未选择]'} ${step.id}：${step.executable ? JSON.stringify([step.executable, ...step.args]) : '仅复制本地白名单模型文件，不覆盖现有不同内容'}`),
    ...report.plan.notices,
  ];
  if (report.actions.length) lines.push(`本次已执行：${report.actions.map(item => item.id).join('、')}`);
  return lines.join('\n');
}

export const SETUP_HELP = `使用：node automation/setup.mjs [选项]
  无参数 / --check      只读静态预检，不安装、不登录、不启动浏览器
  --listening          同时检查可选听力的 Python、依赖和本地模型
  --install            安装项目依赖和官方独立 CLI ${OFFICIAL_CLI_VERSION} 到项目内
  --login-cli          在当前终端交互启动官方 CLI，由本人完成登录；不发送模型请求
  --install-listening  只安装 Python requirements 到 .tmp/listening-python，不下载模型
  --python <path>      指定本地 Python 解释器
  --model <dir>        检查已有本地模型，也可设置 LISTENING_MODEL
  --import-model <dir> 将已有本地模型白名单文件复制到 .tmp/listening-model-small
  --npm-cli <path>     指定 npm-cli.js（不是 npm.cmd）
  --edge <path>        指定 Edge 可执行文件，仅检查存在
  --json               输出安全的结构化报告
  --help               显示帮助
安装不会覆盖 .env、账号设置或账本，不全局安装；安装与登录均不验证实际账号额度。
--check 不能与安装、登录或模型导入同时使用。`;

export async function main(args = process.argv.slice(2), dependencies = {}) {
  const print = dependencies.print || (message => console.log(message));
  try {
    const options = parseSetupArgs(args);
    if (options.help) { print(SETUP_HELP); return { ok: true, exitCode: 0 }; }
    const report = await runSetup({ ...options, ...dependencies });
    print(options.json ? JSON.stringify(report, null, 2) : formatSetupReport(report));
    return report;
  } catch (error) {
    const safeError = error instanceof SetupError ? { code: error.code, message: error.message } :
      { code: 'SETUP_FAILED', message: '安装或预检未完成；原始错误未写入报告，请检查本地路径和权限。' };
    print(JSON.stringify({ ok: false, error: safeError }));
    return { ok: false, error: safeError, exitCode: 1 };
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await main();
  process.exitCode = result.exitCode;
}
