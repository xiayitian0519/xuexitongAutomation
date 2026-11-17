// Pure local mocks: no browser, platform, model, credentials, or production-state writes.
import assert from 'node:assert/strict';
import { BrowserDriver, safeManagedProgress } from '../automation/browser-driver.mjs';

let passed = 0;
async function test(label, fn) { await fn(); passed++; console.log(`PASS ${label}`); }

function mockExecution({ state = { ready: true, injected: true, managed: { phase: 'submitted', message: '已观察到当前作业提交完成，等待作业列表复核' } },
    response, stopped = () => false, extraPages = [], stopBehavior = async () => {} } = {}) {
    const logs = [], events = [];
    const startedAt = Date.now();
    const page = {
        on(event, listener) { if (event === 'response' && response) listener(response); },
        off() {}, isClosed: () => false, mainFrame() { return this; },
        url: () => 'https://mooc1.chaoxing.com/mooc-ans/mooc2/work/dowork?workId=1',
        async evaluate(fn) {
            if (String(fn).includes('stopAuto')) {
                events.push({ event: 'stop', at: Date.now() - startedAt });
                return stopBehavior();
            }
            return state;
        },
        async close() { events.push({ event: 'close', at: Date.now() - startedAt }); },
    };
    const driver = new BrowserDriver({}, { stopped, log: (value) => logs.push(value), timeoutMs: 1000 });
    driver.openItem = async () => {
        driver.worker = page;
        driver.taskPages.set(page, () => {});
        for (const extra of extraPages) driver.taskPages.set(extra, () => {});
        return null;
    };
    driver.snapshots = async () => [{ frame: page, data: { kind: 'work' } }];
    const pending = driver.execute({ id: '1', kind: 'work', title: '模拟任务', courseTitle: '模拟课程' });
    return { pending, logs, events, driver, startedAt };
}

await test('固定phase和合法模型、校验、步骤切换进度保留', async () => {
    const valid = [
        ['ready', '作业执行器已就绪'], ['ready', '课程执行器已就绪'],
        ['running', '正在执行当前作业或章节任务'], ['running', '模型开始：1 题'],
        ['running', '模型开始：30 题'], ['running', '填写后校验通过：12 题'],
        ['running', '步骤切换成功：视频 0-1 → 视频 0-2'],
        ['running', '步骤切换成功：视频 1 → 章节测验 2'],
        ['running', '步骤切换成功：未知 0 → 视频 1'],
        ['running', '章节测验提交已确认'],
        ['stopped', '当前执行器已停止，未完成的模型请求已取消'], ['stopped', '自动任务已停止'],
        ['submitted', '已观察到当前作业提交完成，等待作业列表复核'],
        ['verify', '已离开当前小节，等待目录核实完成状态'],
        ['verify', '当前学习步骤结束，等待目录核实任务点是否完成'],
    ];
    for (const [phase, message] of valid) assert.equal(safeManagedProgress({ phase, message }), `[${phase}] ${message}`);
});

await test('任意phase、JSON token/答案/题干/签名地址和越界数字不进入进度日志', async () => {
    const payloads = [
        '{"token":"FIXTURE_TOKEN","answers":[{"id":1,"letters":["A"]}]}',
        '题干 FIXTURE_QUESTION 答案 FIXTURE_ANSWER',
        'https://mooc1.chaoxing.com/a?enc=FIXTURE_SIGNED_TOKEN&token=FIXTURE_TOKEN',
        '模型开始：31 题', '模型开始：0 题', '填写后校验通过：999 题',
        '模型开始：1 题\n{"token":"FIXTURE_TOKEN"}',
        '步骤切换成功：FIXTURE_SECRET 1 → 视频 2',
        '步骤切换成功：视频 1 → 视频 99999999999999999999',
    ];
    for (const message of payloads) {
        for (const phase of ['ready', 'running', 'submitted', 'verify', 'stopped', 'blocked']) {
            const safe = safeManagedProgress({ phase, message });
            assert.ok(safe && !safe.includes('FIXTURE') && !safe.includes('answers') && !safe.includes('https://') && !safe.includes('999'));
            if (phase !== 'blocked') assert.notEqual(safe, `[${phase}] ${message}`);
        }
    }
    for (const phase of ['secret-phase', 'running\nFIXTURE_TOKEN', '__proto__', 'constructor']) assert.equal(safeManagedProgress({ phase, message: 'FIXTURE_TOKEN' }), null);
    for (const value of [null, undefined, 'FIXTURE_TOKEN', {}, { phase: 1 }]) assert.equal(safeManagedProgress(value), null);
});

await test('blocked只输出安全分类，不复制原始错误', async () => {
    for (const [message, category] of [
        ['Authentication required FIXTURE_TOKEN', '登录或鉴权未通过'],
        ['本地服务不可用 FIXTURE_TOKEN', '本地服务连接异常'],
        ['CodeBuddy CLI 报错 {"answers":"FIXTURE_ANSWER"}', '模型响应未通过检查'],
        ['题目识别失败 FIXTURE_QUESTION', '题目识别或一致性检查未通过'],
        ['填写后校验失败 FIXTURE_ANSWER', '填写结果校验未通过'],
        ['提交失败 FIXTURE_TOKEN', '提交状态需核实'],
        ['视频播放失败 FIXTURE_TOKEN', '视频播放未完成'],
        ['下一节没有加载 FIXTURE_TOKEN', '学习步骤需核实'],
        ['{"token":"FIXTURE_TOKEN"}', '任务执行受阻，需核实'],
    ]) assert.equal(safeManagedProgress({ phase: 'blocked', message }), `[blocked] ${category}`);
});

await test('实际driver日志不泄露managed原文，合法进度仍可观察', async () => {
    const poisoned = mockExecution({ state: { ready: true, injected: true, managed: {
        phase: 'blocked', message: 'CodeBuddy CLI 报错 {"token":"FIXTURE_TOKEN","answers":"FIXTURE_ANSWER"}',
    } } });
    assert.equal((await poisoned.pending).status, 'blocked');
    assert.ok(poisoned.logs.some((line) => line.includes('[blocked] 模型响应未通过检查')));
    assert.ok(poisoned.logs.every((line) => !/FIXTURE|answers|token/.test(line)));
    const valid = mockExecution();
    await valid.pending;
    assert.ok(valid.logs.some((line) => line.includes('[submitted] 已观察到当前作业提交完成')));
});

await test('已停止时先暂停全部页，挂起usageReads不再产生2秒延迟', async () => {
    let stopped = false, extraStoppedAt = null, extraClosedAt = null;
    const startedAt = Date.now();
    const extra = { off() {}, async evaluate() { extraStoppedAt = Date.now() - startedAt; }, async close() { extraClosedAt = Date.now() - startedAt; } };
    const response = { url: () => 'http://127.0.0.1:37841/answer', request: () => ({ method: () => 'POST' }), ok: () => true,
        json: () => { stopped = true; return new Promise(() => {}); } };
    const run = mockExecution({ response, stopped: () => stopped, extraPages: [extra] });
    await assert.rejects(run.pending, /任务已停止/);
    assert.ok(run.events.find((row) => row.event === 'stop').at < 500);
    assert.ok(run.events.find((row) => row.event === 'close').at < 500);
    assert.ok(extraStoppedAt < 500 && extraClosedAt < 500);
    assert.equal(run.driver.taskPages.size, 0);
});

await test('单页stopAuto异常不阻止其他页暂停与关闭', async () => {
    let extraStopped = false, extraClosed = false;
    const extra = { off() {}, async evaluate() { extraStopped = true; }, async close() { extraClosed = true; } };
    const run = mockExecution({ extraPages: [extra], stopBehavior: async () => { throw new Error('fixture evaluation failed'); } });
    await run.pending;
    assert.equal(extraStopped, true);
    assert.equal(extraClosed, true);
    assert.equal(run.events.filter((event) => event.event === 'close').length, 1);
});

await test('单页stopAuto挂起也不会无限阻止后续页关闭', async () => {
    let extraStopped = false, extraClosed = false;
    const extra = { off() {}, async evaluate() { extraStopped = true; }, async close() { extraClosed = true; } };
    const run = mockExecution({ extraPages: [extra], stopBehavior: () => new Promise(() => {}) });
    await run.pending;
    assert.equal(extraStopped, true);
    assert.equal(extraClosed, true);
    const close = run.events.find((event) => event.event === 'close');
    assert.ok(close.at >= 400 && close.at < 1200, `bounded page cleanup: ${close.at}ms`);
});

console.log(`${passed} driver stop/logging groups passed; no browser/model/platform requests or state writes`);
