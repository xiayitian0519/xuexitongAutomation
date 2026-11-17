import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { requestAnswers, runCli, sanitizeUsageMeta } from '../deepseek-console/wb-cli-request.mjs';
import { createAnswerServer } from '../deepseek-console/deepseek-local.mjs';

const root = resolve(import.meta.dirname, '..');
const workRoot = resolve(root, 'work');
mkdirSync(workRoot, { recursive: true });
const fixtureDir = mkdtempSync(resolve(workRoot, 'request-cancel-'));
const fixturePath = resolve(fixtureDir, 'fake-cli.mjs');
const questions = [{ id: 1, type: '单选题', question: '1+1=?', options: [{ letter: 'A', text: '2' }, { letter: 'B', text: '3' }] }];
const answers = [{ id: 1, letters: ['A'] }];
const cliJson = JSON.stringify([
    { type: 'function_call', providerData: { model: 'deepseek-v4.1-flash', rawUsage: { credit: 0.0123 } } },
    { type: 'result', is_error: false, structured_output: { answers } },
]);
writeFileSync(fixturePath, `
import { writeFileSync } from 'node:fs';
const mode = process.argv[2];
if (mode === 'sleep') {
    writeFileSync(process.argv[3], String(process.pid));
    setInterval(() => {}, 1000);
} else if (mode === 'overflow') {
    process.stdout.write('x'.repeat(600));
    process.stderr.write('y'.repeat(600));
    setInterval(() => {}, 1000);
} else if (mode === 'utf8') {
    const text = Buffer.from('中文输出');
    process.stdout.write(text.subarray(0, 1));
    setTimeout(() => process.stdout.write(text.subarray(1)), 10);
} else {
    process.stdout.write(${JSON.stringify(cliJson)});
    if (mode === 'nonzero') process.exitCode = 7;
}
`, 'utf8');

let count = 0;
async function test(label, fn) {
    await fn();
    count++;
    console.log(`✓ ${label}`);
}
function deferred() {
    let resolvePromise;
    const promise = new Promise((resolve) => { resolvePromise = resolve; });
    return { promise, resolve: resolvePromise };
}
async function within(promise, label, timeoutMs = 3000) {
    let timer;
    try {
        return await Promise.race([promise, new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`等待超时：${label}`)), timeoutMs);
        })]);
    } finally { clearTimeout(timer); }
}
async function waitForFile(path) {
    await within((async () => { while (!existsSync(path)) await delay(10); })(), '模拟进程启动');
}
async function withServer(options, fn) {
    const server = createAnswerServer({ provider: 'workbuddy-cli', token: 'test-token', ...options });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    try { await fn(base); }
    finally {
        server.closeAllConnections();
        await new Promise((resolveClose) => server.close(resolveClose));
    }
}
const headers = { Origin: 'https://mooc1.chaoxing.com', 'Content-Type': 'application/json', 'X-Xuexitong-Token': 'test-token' };
const post = (base, extraHeaders = {}) => fetch(`${base}/answer`, { method: 'POST', headers: { ...headers, ...extraHeaders }, body: JSON.stringify({ questions }) });
function disconnectableRequest(base) {
    const client = httpRequest(`${base}/answer`, { method: 'POST', headers });
    client.on('error', () => {});
    client.end(JSON.stringify({ questions }));
    return client;
}

try {
    await test('已取消的请求不会调用执行器或启动子进程', async () => {
        const controller = new AbortController();
        controller.abort();
        let calls = 0;
        await assert.rejects(requestAnswers(questions, undefined, { signal: controller.signal, runner: async () => { calls++; } }), { name: 'AbortError' });
        assert.equal(calls, 0);
        assert.deepEqual(await runCli([], 1000, undefined, { signal: controller.signal, cliPath: fixturePath }), { error: 'aborted' });
    });
    await test('AbortSignal 传递到执行器，取消后的结果不会被接受', async () => {
        const controller = new AbortController();
        await assert.rejects(requestAnswers(questions, undefined, {
            signal: controller.signal,
            runner: async (_args, _timeout, _stdin, options) => {
                assert.equal(options.signal, controller.signal);
                controller.abort();
                return { stdout: cliJson };
            },
        }), { name: 'AbortError' });
    });
    await test('取消会终止真实模拟子进程，并等进程退出才返回', async () => {
        const ready = resolve(fixtureDir, 'abort.pid');
        const controller = new AbortController();
        const pending = runCli(['sleep', ready], 5000, undefined, { cliPath: fixturePath, signal: controller.signal });
        await waitForFile(ready);
        const pid = Number(readFileSync(ready, 'utf8'));
        controller.abort();
        assert.equal((await within(pending, '子进程取消')).error, 'aborted');
        assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    });
    await test('非零退出即使输出合法答案也判为失败', async () => {
        const raw = await runCli(['nonzero'], 3000, undefined, { cliPath: fixturePath });
        assert.equal(raw.error, 'exit-code');
        assert.match(raw.detail, /7/);
        await assert.rejects(requestAnswers(questions, undefined, { runner: async () => ({ stdout: cliJson, exitCode: 7 }) }), /进程失败/);
    });
    await test('stdout 和 stderr 共享输出上限，溢出后中止', async () => {
        const raw = await runCli(['overflow'], 3000, undefined, { cliPath: fixturePath, maxOutputBytes: 1000 });
        assert.equal(raw.error, 'output-limit');
        assert.equal(raw.stdout, undefined);
        await assert.rejects(requestAnswers(questions, undefined, { runner: async () => raw }), /输出超过 1000 字节/);
    });
    await test('超时仍会终止子进程且保留原错误口径', async () => {
        const ready = resolve(fixtureDir, 'timeout.pid');
        const raw = await runCli(['sleep', ready], 500, undefined, { cliPath: fixturePath });
        assert.equal(raw.error, 'timeout');
        if (existsSync(ready)) assert.throws(() => process.kill(Number(readFileSync(ready, 'utf8')), 0), { code: 'ESRCH' });
    });
    await test('分段 UTF-8 输出不损坏，正常 CLI 返回仍能解析', async () => {
        const utf8 = await runCli(['utf8'], 3000, undefined, { cliPath: fixturePath });
        assert.equal(utf8.stdout, '中文输出');
        const result = await requestAnswers(questions, undefined, {
            runner: (_args, timeout, stdin, options) => runCli(['normal'], timeout, stdin, { ...options, cliPath: fixturePath }),
        });
        assert.deepEqual(result, answers);
    });
    await test('用量只暴露合法模型名和有限非负积分', async () => {
        assert.deepEqual(sanitizeUsageMeta({ model: 'model-1', credit: 0.123456, token: 'secret' }), { model: 'model-1', credit: 0.1235 });
        for (const credit of [NaN, Infinity, -1, '0.2']) {
            assert.deepEqual(sanitizeUsageMeta({ model: 'model\nsecret', credit }), { model: null, credit: null });
        }
        let meta;
        const stdout = JSON.stringify([
            { providerData: { model: 'bad\nmodel', rawUsage: { credit: -2 } } },
            { providerData: { model: 'actual-model', rawUsage: { credit: 0.1 } } },
            { providerData: { rawUsage: { credit: 0.2 } } },
            { type: 'result', structured_output: { answers } },
        ]);
        await requestAnswers(questions, undefined, { runner: async () => ({ stdout }), onMeta: (value) => { meta = value; } });
        assert.deepEqual(meta, { model: 'actual-model', credit: 0.3 });
    });
    await test('健康探针报告协议和能力，两个来源均不调度模型', async () => {
        let cliCalls = 0, apiCalls = 0;
        for (const provider of ['workbuddy-cli', 'deepseek']) {
            await withServer({ provider, model: 'configured-model',
                cliRequest: async () => { cliCalls++; return answers; },
                apiRequest: async () => { apiCalls++; return answers; },
            }, async (base) => {
                const response = await fetch(`${base}/health`, { headers });
                assert.equal(response.status, 200);
                assert.deepEqual(await response.json(), {
                    ok: true, provider, model: provider === 'workbuddy-cli' ? 'configured-model' : 'deepseek-flash',
                    protocolVersion: 2, capabilities: ['request-cancel', 'usage-meta'],
                });
            });
        }
        assert.equal(cliCalls, 0);
        assert.equal(apiCalls, 0);
    });
    await test('HTTP 正常结束不误取消，答案与脱敏 meta 一起返回', async () => {
        await withServer({ cliRequest: async (_questions, _key, deps) => {
            await delay(20);
            assert.equal(deps.signal.aborted, false);
            deps.onMeta({ model: 'actual-model', credit: 0.04, credentials: 'secret' });
            return answers;
        } }, async (base) => {
            const response = await post(base);
            assert.equal(response.status, 200);
            assert.deepEqual(await response.json(), { answers, meta: { model: 'actual-model', credit: 0.04 } });
        });
    });
    await test('HTTP 鉴权和来源拦截发生在模型调度之前', async () => {
        let calls = 0;
        await withServer({ cliRequest: async () => { calls++; return answers; } }, async (base) => {
            assert.equal((await post(base, { 'X-Xuexitong-Token': 'wrong' })).status, 403);
            assert.equal((await post(base, { Origin: 'https://untrusted.example' })).status, 403);
            assert.equal(calls, 0);
        });
    });
    await test('HTTP 断连中止 CLI 请求，并释放繁忙锁供下一次调用', async () => {
        const started = deferred(), cancelled = deferred();
        let calls = 0;
        await withServer({ cliRequest: async (_questions, _key, deps) => {
            calls++;
            if (calls > 1) return answers;
            started.resolve();
            return new Promise((_, reject) => deps.signal.addEventListener('abort', () => {
                cancelled.resolve();
                reject(new Error('模拟取消'));
            }, { once: true }));
        } }, async (base) => {
            const client = disconnectableRequest(base);
            await within(started.promise, 'HTTP 调度');
            assert.equal((await post(base)).status, 429);
            client.destroy();
            await within(cancelled.promise, 'HTTP 取消');
            const response = await post(base);
            assert.equal(response.status, 200);
            assert.deepEqual(await response.json(), { answers });
        });
    });
    await test('HTTP 到 CLI 的完整取消链终止本地模拟进程后可继续答题', async () => {
        const ready = resolve(fixtureDir, 'http-abort.pid');
        const stopped = deferred();
        let calls = 0;
        await withServer({ cliRequest: (items, key, deps) => {
            const first = calls++ === 0;
            return requestAnswers(items, key, { ...deps, runner: async (_args, timeout, stdin, options) => {
                const raw = await runCli(first ? ['sleep', ready] : ['normal'], timeout, stdin, { ...options, cliPath: fixturePath });
                if (first) stopped.resolve();
                return raw;
            } });
        } }, async (base) => {
            const client = disconnectableRequest(base);
            await waitForFile(ready);
            const pid = Number(readFileSync(ready, 'utf8'));
            client.destroy();
            await within(stopped.promise, 'HTTP 模拟子进程取消');
            assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
            await delay(0);
            const response = await post(base);
            assert.equal(response.status, 200);
            assert.deepEqual(await response.json(), { answers, meta: { model: 'deepseek-v4.1-flash', credit: 0.0123 } });
        });
    });
    await test('上传中断不调用模型，下一次请求可继续', async () => {
        let calls = 0;
        await withServer({ cliRequest: async () => { calls++; return answers; } }, async (base) => {
            const client = httpRequest(`${base}/answer`, { method: 'POST', headers });
            client.on('error', () => {});
            client.write('{"questions":');
            await delay(30);
            client.destroy();
            await delay(30);
            assert.equal(calls, 0);
            assert.equal((await post(base)).status, 200);
        });
    });
    await test('原 DeepSeek API 路径通过注入 fetch 正常返回，未向外网发请求', async () => {
        let calls = 0;
        await withServer({ provider: 'deepseek', apiKey: 'test-only', fetchImpl: async (url, options) => {
            calls++;
            assert.equal(url, 'https://api.deepseek.com/chat/completions');
            assert.equal(options.headers.Authorization, 'Bearer test-only');
            assert.equal(options.signal.aborted, false);
            return { ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ answers }) } }] }) };
        } }, async (base) => {
            const response = await post(base);
            assert.equal(response.status, 200);
            assert.deepEqual(await response.json(), { answers });
            assert.equal(calls, 1);
        });
    });
    await test('HTTP 断连同样传递到原 DeepSeek API 的 fetch', async () => {
        const started = deferred(), cancelled = deferred();
        await withServer({ provider: 'deepseek', apiKey: 'test-only', fetchImpl: async (_url, options) => {
            started.resolve();
            return new Promise((_, reject) => options.signal.addEventListener('abort', () => {
                cancelled.resolve();
                reject(new Error('模拟取消'));
            }, { once: true }));
        } }, async (base) => {
            const client = disconnectableRequest(base);
            await within(started.promise, 'API 调度');
            client.destroy();
            await within(cancelled.promise, 'API 取消');
        });
    });
    await test('合并取消信号仍保留调用方已有的超时/取消来源', async () => {
        const source = new AbortController();
        const started = deferred(), cancelled = deferred();
        await withServer({ provider: 'deepseek', apiRequest: async (_questions, _key, fetchImpl) => {
            await fetchImpl('fake://local-only', { signal: source.signal });
            return answers;
        }, fetchImpl: async (_url, options) => {
            started.resolve();
            return new Promise((_, reject) => options.signal.addEventListener('abort', () => {
                cancelled.resolve(); reject(new Error('原超时信号已触发'));
            }, { once: true }));
        } }, async (base) => {
            const pending = post(base);
            await within(started.promise, '合并信号');
            source.abort();
            await within(cancelled.promise, '原信号取消');
            const response = await pending;
            assert.equal(response.status, 502);
            assert.match((await response.json()).error, /原超时信号/);
        });
    });
    console.log(`\n${count} 项取消与服务测试通过，全部使用本地模拟程序，未调用真实模型。`);
} finally {
    // 只清理本测试创建且确认位于项目 work 下的临时目录。
    if (!fixtureDir.startsWith(`${workRoot}${sep}`)) throw new Error('拒绝清理项目之外的路径');
    rmSync(fixtureDir, { recursive: true, force: true });
}
