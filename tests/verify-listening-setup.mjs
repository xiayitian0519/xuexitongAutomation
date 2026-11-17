import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { join, resolve, win32 } from 'node:path';
import { SETUP_ROOT } from '../automation/setup.mjs';
import { resolveListeningPaths } from '../listening/local-paths.mjs';
import { checkLocalAsr } from '../listening/preflight.mjs';
import { resolveListeningModelIdentity } from '../listening/pipeline.mjs';
import { runRawTranscriber } from '../listening/transcriber.mjs';

// Every model read and Python process below is injected. No local model, audio,
// Python interpreter, browser or network connection is needed for this suite.
const ROOT = resolve('.tmp', 'fake-listening-root 中文 空格');
const ENV_MODEL = join(ROOT, 'environment-model');
const OPTION_MODEL = join(ROOT, 'option-model');
const windowsPath = (volume, ...parts) => win32.join(String.fromCharCode(volume) + ':' + win32.sep, ...parts);
let groups = 0;
let fakePythonCalls = 0;

async function test(name, body) {
    await body(); groups++; console.log(`PASS ${groups}. ${name}`);
}

function fakeHealth(options = {}) {
    const files = [], executions = [];
    return {
        files, executions,
        options: {
            root: ROOT, env: {},
            stat: async file => {
                files.push(file);
                if (options.missing && file.endsWith(options.missing)) throw Object.assign(new Error('fake missing'), { code: 'ENOENT' });
                return { isFile: () => true, size: 100 };
            },
            execute: async (file, args, settings) => {
                fakePythonCalls++; executions.push({ file, args, settings });
                return { stdout: JSON.stringify({ version: options.version || '1.2.1', decoder: true }) };
            },
        },
    };
}

function fakeModelIo() {
    const reads = [], streams = [];
    return {
        reads, streams,
        io: {
            realpath: async file => { reads.push(['realpath', file]); return file; },
            stat: async file => { reads.push(['stat', file]); return { size: 42, mtimeMs: 7 }; },
            readFile: async file => { reads.push(['readFile', file]); return Buffer.from(file); },
            createReadStream(file) {
                streams.push(file);
                return (async function* () { yield Buffer.from('fake-model-bytes:' + file); })();
            },
        },
    };
}

function fakeSpawn() {
    const calls = [];
    return {
        calls,
        spawn(file, args, settings) {
            fakePythonCalls++; calls.push({ file, args, settings });
            const child = new EventEmitter();
            child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => true;
            queueMicrotask(() => {
                child.stdout.emit('data', Buffer.from('{"fake":true}'));
                child.emit('close', 0);
            });
            return child;
        },
    };
}

await test('setup与实际听力运行时使用相同项目默认目录', async () => {
    const current = resolveListeningPaths({ env: {} });
    assert.equal(current.root, SETUP_ROOT);
    assert.equal(current.model, join(SETUP_ROOT, '.tmp', 'listening-model-small'));
    assert.equal(current.dependencies, join(SETUP_ROOT, '.tmp', 'listening-python'));
    assert.equal(current.python, 'python'); assert.equal(current.modelSource, 'project-default');
});

await test('模型优先级为任务参数、环境变量、项目默认', async () => {
    const env = { LISTENING_MODEL: ENV_MODEL };
    assert.equal(resolveListeningPaths({ root: ROOT, env, model: OPTION_MODEL }).model, OPTION_MODEL);
    assert.equal(resolveListeningPaths({ root: ROOT, env, model: OPTION_MODEL }).modelSource, 'option');
    assert.equal(resolveListeningPaths({ root: ROOT, env }).model, ENV_MODEL);
    assert.equal(resolveListeningPaths({ root: ROOT, env }).modelSource, 'environment');
    assert.equal(resolveListeningPaths({ root: ROOT, env: {} }).model, join(ROOT, '.tmp', 'listening-model-small'));
});

await test('相对模型和依赖路径以项目根目录解析而不依赖当前任务目录', async () => {
    const paths = resolveListeningPaths({ root: ROOT, env: {}, model: 'models/small', dependencies: 'python packages' });
    assert.equal(paths.model, join(ROOT, 'models', 'small'));
    assert.equal(paths.dependencies, join(ROOT, 'python packages'));
});

await test('中文空格Windows路径和Python优先级保持完整', async () => {
    const localRoot = windowsPath(67, '新电脑 空格', '学习通');
    const python = windowsPath(68, '选用 Python', 'python.exe');
    const paths = resolveListeningPaths({ root: localRoot, platform: 'win32',
        env: { LISTENING_PYTHON: windowsPath(67, '环境 Python', 'python.exe'), LISTENING_DEPENDENCIES: windowsPath(68, '环境依赖') },
        python, dependencies: '依赖目录' });
    assert.equal(paths.model, win32.join(localRoot, '.tmp', 'listening-model-small'));
    assert.equal(paths.dependencies, win32.join(localRoot, '依赖目录'));
    assert.equal(paths.python, python);
    assert.equal(resolveListeningPaths({ root: ROOT, env: { LISTENING_PYTHON: 'env-python' } }).python, 'env-python');
});

await test('本地预检默认模型与安装依赖目录均传入fake检查器', async () => {
    const fake = fakeHealth();
    const result = await checkLocalAsr(fake.options);
    assert.deepEqual(fake.files, ['model.bin', 'config.json', 'tokenizer.json'].map(name => join(ROOT, '.tmp', 'listening-model-small', name)));
    assert.equal(fake.executions.length, 1); assert.equal(fake.executions[0].file, 'python');
    assert.equal(fake.executions[0].args.at(-1), join(ROOT, '.tmp', 'listening-python'));
    assert.equal(result.localModelReady, true); assert.equal(result.modelRequests, 0);
});

await test('显式预检路径和解释器覆盖环境且不丢失空格', async () => {
    const fake = fakeHealth();
    await checkLocalAsr({ ...fake.options, env: { LISTENING_MODEL: ENV_MODEL, LISTENING_PYTHON: 'environment-python' },
        model: OPTION_MODEL, python: windowsPath(67, 'Python 空格', 'python.exe'), dependencies: join(ROOT, 'custom dependencies') });
    assert.equal(fake.files[0], join(OPTION_MODEL, 'model.bin'));
    assert.equal(fake.executions[0].file, windowsPath(67, 'Python 空格', 'python.exe'));
    assert.equal(fake.executions[0].args.at(-1), join(ROOT, 'custom dependencies'));
});

await test('默认目录缺模型时先报缺失，不启动Python', async () => {
    const fake = fakeHealth({ missing: 'tokenizer.json' });
    await assert.rejects(checkLocalAsr(fake.options), /LISTENING_LOCAL_MODEL_INCOMPLETE/);
    assert.equal(fake.executions.length, 0);
});

await test('导入版本错误不能以文件存在视为引擎通过', async () => {
    const fake = fakeHealth({ version: '9.0.0' });
    await assert.rejects(checkLocalAsr(fake.options), /LISTENING_ENGINE_VERSION_UNVERIFIED/);
});

await test('注入离线转写器且未显式指定模型时不读取项目默认模型', async () => {
    const noReads = new Proxy({}, { get() { return () => { throw new Error('MODEL_READ_NOT_ALLOWED'); }; } });
    const result = await resolveListeningModelIdentity({ root: ROOT, env: {}, transcriber: async () => ({}), modelIo: noReads });
    assert.match(result, /^injected:[a-f0-9]+$/);
});

await test('显式identity优先，完全绕过真实模型与Python', async () => {
    const result = await resolveListeningModelIdentity({ modelIdentity: 'offline-identity', model: OPTION_MODEL,
        modelIo: { realpath: () => { throw new Error('MODEL_READ_NOT_ALLOWED'); } } });
    assert.equal(result, 'offline-identity');
});

await test('实际模型identity默认指向导入目录，但全部内容由fake IO提供', async () => {
    const fake = fakeModelIo();
    const result = await resolveListeningModelIdentity({ root: join(ROOT, 'identity-default'), env: {}, modelIo: fake.io });
    assert.match(result, /^[a-f0-9]{64}$/);
    assert.equal(fake.streams[0], join(ROOT, 'identity-default', '.tmp', 'listening-model-small', 'model.bin'));
});

await test('注入转写器仍保留显式模型或环境模型的内容identity语义', async () => {
    for (const selection of [{ model: OPTION_MODEL }, { env: { LISTENING_MODEL: ENV_MODEL } }]) {
        const fake = fakeModelIo();
        const result = await resolveListeningModelIdentity({ root: ROOT, env: {}, ...selection, transcriber: async () => ({}), modelIo: fake.io });
        assert.match(result, /^[a-f0-9]{64}$/);
        assert.equal(fake.reads[0][1], join(selection.model || ENV_MODEL, 'model.bin'));
    }
});

await test('转写进程默认模型及依赖与预检一致，进程完全由fake替代', async () => {
    const fake = fakeSpawn();
    assert.deepEqual(await runRawTranscriber('fake audio.wav', { root: ROOT, env: {}, spawn: fake.spawn }), { fake: true });
    assert.equal(fake.calls.length, 1);
    const call = fake.calls[0];
    assert.equal(call.file, 'python'); assert.equal(call.settings.shell, false);
    assert.equal(call.args[call.args.indexOf('--model') + 1], join(ROOT, '.tmp', 'listening-model-small'));
    assert.equal(call.args[call.args.indexOf('--dependencies') + 1], join(ROOT, '.tmp', 'listening-python'));
    assert.ok(!call.args.includes('--answer') && !call.args.some(value => /^https?:/.test(value)));
});

await test('转写器显式路径覆盖环境、区间参数和取消校验仍保留', async () => {
    const fake = fakeSpawn();
    await runRawTranscriber('fake.wav', { root: ROOT, env: { LISTENING_MODEL: ENV_MODEL, LISTENING_PYTHON: 'env-python' },
        model: OPTION_MODEL, python: 'option-python', spawn: fake.spawn, range: { start: 2, end: 5 } });
    assert.equal(fake.calls[0].file, 'option-python');
    assert.equal(fake.calls[0].args[fake.calls[0].args.indexOf('--model') + 1], OPTION_MODEL);
    assert.deepEqual(fake.calls[0].args.slice(-4), ['--start-seconds', '2', '--end-seconds', '5']);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(runRawTranscriber('fake.wav', { spawn: fake.spawn, signal: controller.signal }), /ABORTED/);
    await assert.rejects(runRawTranscriber('fake.wav', { spawn: fake.spawn, range: { start: 5, end: 2 } }), /INVALID_REPAIR_RANGE/);
    assert.equal(fake.calls.length, 1);
});

assert.ok(fakePythonCalls > 0, '预检与转写命令替身应实际被测试调用');
console.log(JSON.stringify({ passed: true, groups }));
