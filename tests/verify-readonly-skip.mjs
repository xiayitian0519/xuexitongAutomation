// Pure offline queue tests. No state files, browser, production console, or model are read.
import assert from 'node:assert/strict';
import { executeQueue } from '../automation/task-queue.mjs';

const item = Object.freeze({ key: 'course:100:200:chapter:300', kind: 'chapter',
    title: '离线模拟章节', courseTitle: '离线模拟课程', status: 'pending' });
const skipReason = '离线测试：按只读策略跳过';
const failures = [];
let passed = 0;

async function test(label, fn) {
    try { await fn(); passed++; console.log(`PASS ${label}`); }
    catch { failures.push(label); console.error(`FAIL ${label}`); }
}

async function runFixture({ items = [item], previous = [], outcome = { status: 'blocked', reason: skipReason, readonlySkip: true },
    evidence = { complete: true }, initiallyStopped = false, onExecute, onVerify, onCheckpoint } = {}) {
    const calls = { execute: 0, verify: 0 }, checkpoints = [], events = [];
    let stopped = initiallyStopped;
    const controls = { stop() { stopped = true; }, calls, checkpoints, events };
    const report = await executeQueue({ items, previous, stopped: () => stopped,
        execute: async current => {
            calls.execute++; events.push('execute'); assert.equal(current, item);
            return onExecute ? onExecute(current, controls) : outcome;
        },
        verify: async current => {
            calls.verify++; events.push('verify'); assert.equal(current, item);
            return onVerify ? onVerify(current, controls) : evidence;
        },
        checkpoint: async current => {
            const snapshot = structuredClone(current);
            checkpoints.push(snapshot);
            events.push(`checkpoint:${snapshot.items[0]?.status || 'empty'}`);
            await onCheckpoint?.(snapshot, controls);
        },
    });
    return { report, calls, checkpoints, events };
}

const statuses = run => run.checkpoints.map(snapshot => snapshot.items[0]?.status);

await test('明确只读skip仅execute一次且不verify，不产生complete或submitted', async () => {
    const run = await runFixture({ onVerify: () => { throw new Error('READONLY_SKIP_MUST_NOT_VERIFY'); } });
    assert.deepEqual(run.calls, { execute: 1, verify: 0 });
    assert.equal(run.report.items[0].status, 'blocked');
    assert.equal(run.report.items[0].reason, skipReason);
    assert.equal(run.report.phase, 'finished-with-unresolved');
    assert.deepEqual(statuses(run), ['queued', 'running', 'blocked', 'blocked']);
    assert.deepEqual(run.events, ['checkpoint:queued', 'checkpoint:running', 'execute', 'checkpoint:blocked', 'checkpoint:blocked']);
    assert.equal(Object.hasOwn(run.report.items[0], 'readonlySkip'), false);
});

await test('只读skip不会因潜在verify complete证据被提升为complete', async () => {
    const run = await runFixture({ evidence: { complete: true } });
    assert.equal(run.calls.verify, 0);
    assert.equal(run.report.items[0].status, 'blocked');
    assert.equal(run.checkpoints.some(snapshot => snapshot.items.some(row => ['complete', 'submitted'].includes(row.status))), false);
});

await test('普通blocked仍verify一次并可按平台证据完成', async () => {
    const run = await runFixture({ outcome: { status: 'blocked', reason: '离线模拟普通受阻' } });
    assert.deepEqual(run.calls, { execute: 1, verify: 1 });
    assert.equal(run.report.items[0].status, 'complete');
    assert.equal(run.report.items[0].reason, '已重新检查平台完成状态');
    assert.equal(run.report.phase, 'finished');
    assert.deepEqual(statuses(run), ['queued', 'running', 'complete', 'complete']);
});

await test('普通blocked复核未完成时保留原原因', async () => {
    const reason = '离线模拟：入口未确认';
    const run = await runFixture({ outcome: { status: 'blocked', reason }, evidence: { complete: false, reason: '不替代后端原因' } });
    assert.deepEqual(run.calls, { execute: 1, verify: 1 });
    assert.equal(run.report.items[0].status, 'blocked');
    assert.equal(run.report.items[0].reason, reason);
});

await test('readonlySkip必须严格为true，其他值不绕过verify', async () => {
    for (const readonlySkip of [undefined, false, 1, 'true', {}, []]) {
        const run = await runFixture({ outcome: { status: 'blocked', reason: skipReason, readonlySkip } });
        assert.deepEqual(run.calls, { execute: 1, verify: 1 });
        assert.equal(run.report.items[0].status, 'complete');
    }
});

await test('readonlySkip在非blocked返回中不跳过submitted checkpoint或verify', async () => {
    const run = await runFixture({ outcome: { status: 'verify', readonlySkip: true },
        onVerify: (_current, controls) => {
            assert.equal(controls.checkpoints.at(-1).items[0].status, 'submitted');
            return { complete: true };
        } });
    assert.deepEqual(run.calls, { execute: 1, verify: 1 });
    assert.deepEqual(statuses(run), ['queued', 'running', 'submitted', 'complete', 'complete']);
    assert.equal(run.report.phase, 'finished');
});

await test('正常完成路径保持running和submitted先持久化再复核', async () => {
    const run = await runFixture({ outcome: { status: 'verify' } });
    assert.deepEqual(run.events, ['checkpoint:queued', 'checkpoint:running', 'execute', 'checkpoint:submitted',
        'verify', 'checkpoint:complete', 'checkpoint:complete']);
    assert.deepEqual(run.calls, { execute: 1, verify: 1 });
});

await test('正常返回但平台未确认时needs-review且不自动重试', async () => {
    const run = await runFixture({ outcome: { status: 'verify' }, evidence: { complete: false, reason: '离线模拟平台尚未确认' } });
    assert.deepEqual(run.calls, { execute: 1, verify: 1 });
    assert.equal(run.report.items[0].status, 'needs-review');
    assert.equal(run.report.items[0].reason, '离线模拟平台尚未确认');
});

await test('开始前停止时不调用execute或verify', async () => {
    const run = await runFixture({ initiallyStopped: true });
    assert.deepEqual(run.calls, { execute: 0, verify: 0 });
    assert.equal(run.report.phase, 'stopped');
    assert.equal(run.report.items[0].status, 'queued');
});

await test('running checkpoint期间到达停止时不调用后端', async () => {
    const run = await runFixture({ onCheckpoint: (snapshot, controls) => {
        if (snapshot.items[0]?.status === 'running') controls.stop();
    } });
    assert.deepEqual(run.calls, { execute: 0, verify: 0 });
    assert.equal(run.report.items[0].status, 'interrupted');
    assert.equal(run.report.phase, 'stopped');
});

await test('只读skip返回时已停止则停止守卫优先，不再verify', async () => {
    const run = await runFixture({ onExecute: (_current, controls) => {
        controls.stop(); return { status: 'blocked', reason: skipReason, readonlySkip: true };
    } });
    assert.deepEqual(run.calls, { execute: 1, verify: 0 });
    assert.equal(run.report.items[0].status, 'interrupted');
    assert.equal(run.report.phase, 'stopped');
});

await test('普通blocked返回时已停止仍不调用verify', async () => {
    const run = await runFixture({ onExecute: (_current, controls) => {
        controls.stop(); return { status: 'blocked', reason: skipReason };
    } });
    assert.deepEqual(run.calls, { execute: 1, verify: 0 });
    assert.equal(run.report.items[0].status, 'interrupted');
});

await test('submitted checkpoint期间停止时不复核或记为complete', async () => {
    const run = await runFixture({ outcome: { status: 'verify' }, onCheckpoint: (snapshot, controls) => {
        if (snapshot.items[0]?.status === 'submitted') controls.stop();
    } });
    assert.deepEqual(run.calls, { execute: 1, verify: 0 });
    assert.equal(run.report.items[0].status, 'interrupted');
    assert.equal(run.report.phase, 'stopped');
});

await test('历史不确定状态仍阻止execute与verify', async () => {
    for (const status of ['running', 'interrupted', 'submitted', 'needs-review']) {
        const run = await runFixture({ previous: [{ ...item, status }] });
        assert.deepEqual(run.calls, { execute: 0, verify: 0 });
        assert.equal(run.report.items[0].status, 'needs-review');
        assert.equal(run.report.items[0].reason, '上次执行结果未确认，避免自动重复提交');
    }
});

await test('重复任务编号在一次队列内仍只执行一次', async () => {
    const run = await runFixture({ items: [item, item] });
    assert.deepEqual(run.calls, { execute: 1, verify: 0 });
    assert.equal(run.report.items.length, 1);
});

await test('扫描时已完成任务仍作为历史完成且不执行', async () => {
    const run = await runFixture({ items: [{ ...item, status: 'complete' }] });
    assert.deepEqual(run.calls, { execute: 0, verify: 0 });
    assert.equal(run.report.items[0].status, 'already-complete');
});

console.log(JSON.stringify({ passed, failed: failures.length, failedGroups: failures,
    offline: true, realPlatformRequests: 0, realModelRequests: 0, privateStateRead: false }));
if (failures.length) process.exitCode = 1;
