// Offline persistence/queue regression tests. No browser, model, credentials or network access.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTaskLedger, mergeTaskLedger, saveTaskLedger } from '../automation/task-ledger.mjs';
import { executeQueue } from '../automation/task-queue.mjs';

const project = dirname(dirname(fileURLToPath(import.meta.url)));
const testParent = resolve(project, '.automation.local');
mkdirSync(testParent, { recursive: true });
const sandbox = mkdtempSync(join(testParent, 'ledger-test-'));
const A = { key: 'course:A:work:1', kind: 'work', title: 'A 的作业', status: 'pending', courseTitle: 'A' };
const B = { key: 'course:B:work:2', kind: 'work', title: 'B 的作业', status: 'pending', courseTitle: 'B' };
const note = (name) => console.log(`PASS ${name}`);

try {
    const ledgerPath = join(sandbox, 'task-ledger.json'), reportPath = join(sandbox, 'latest.json');
    writeFileSync(reportPath, JSON.stringify({ phase: 'stopped', items: [{ ...B, status: 'submitted', reason: '等待平台确认' }] }));
    let ledger = readTaskLedger(ledgerPath, { legacyPath: reportPath });
    assert.equal(ledger.items[0].status, 'submitted');
    assert.equal(existsSync(ledgerPath), false, 'reading/migrating does not mutate before acquiring the run lock');
    saveTaskLedger(ledgerPath, ledger);
    note('旧 latest 中未确认提交可以迁移为独立账本');

    // B is uncertain; a scan restricted to A replaces the latest report, not B's durable history.
    ledger = mergeTaskLedger(ledger, [A]);
    saveTaskLedger(ledgerPath, ledger);
    writeFileSync(reportPath, JSON.stringify({ phase: 'scan-complete', courseFilter: 'A', items: [A] }));
    ledger = readTaskLedger(ledgerPath, { legacyPath: reportPath });
    assert.equal(ledger.items.find((item) => item.key === B.key).status, 'submitted');
    note('B 未确认 → 仅扫描 A → 重启后 B 防重记录仍存在');

    // A login-only/latest report with no tasks also cannot erase ledger history.
    writeFileSync(reportPath, JSON.stringify({ phase: 'login-ready', items: [] }));
    ledger = readTaskLedger(ledgerPath, { legacyPath: reportPath });
    assert.equal(ledger.items.find((item) => item.key === B.key).status, 'submitted');

    const executed = [];
    const report = await executeQueue({
        items: [A, B], previous: ledger.items,
        execute: async (item) => { executed.push(item.key); return { status: 'verify' }; },
        verify: async () => ({ complete: true }),
        checkpoint: async (current) => {
            ledger = mergeTaskLedger(ledger, current.items);
            saveTaskLedger(ledgerPath, ledger);
            writeFileSync(reportPath, JSON.stringify(current));
        },
    });
    assert.deepEqual(executed, [A.key], 'the all-course run must not re-submit B');
    assert.equal(report.items.find((item) => item.key === B.key).status, 'needs-review');
    assert.equal(readTaskLedger(ledgerPath).items.find((item) => item.key === B.key).status, 'needs-review');
    note('过滤扫描和登录后再全量执行，只运行 A，不重交 B');

    for (const stopAt of ['running', 'submitted']) {
        let stop = false, executed = 0, verified = 0;
        let history = readTaskLedger(join(sandbox, `stop-${stopAt}.json`));
        const stoppedReport = await executeQueue({
            items: [{ ...A, key: `stop:${stopAt}` }], previous: [], stopped: () => stop,
            execute: async () => { executed++; return { status: 'verify' }; },
            verify: async () => { verified++; return { complete: true }; },
            checkpoint: async (current) => {
                history = mergeTaskLedger(history, current.items);
                saveTaskLedger(join(sandbox, `stop-${stopAt}.json`), history);
                if (current.items[0]?.status === stopAt) {
                    // The stop arrives on a later event-loop turn while checkpoint is awaited.
                    await new Promise((resolve) => setImmediate(() => { stop = true; resolve(); }));
                }
            },
        });
        assert.equal(executed, stopAt === 'running' ? 0 : 1);
        assert.equal(verified, 0, 'stop during a checkpoint must prevent follow-up navigation/verification');
        assert.equal(stoppedReport.phase, 'stopped');
        assert.equal(stoppedReport.items[0].status, 'interrupted');
        assert.equal(readTaskLedger(join(sandbox, `stop-${stopAt}.json`)).items[0].status, 'interrupted');
    }
    note('running/submitted checkpoint 等待期间停止，不再启动任务或导航核实，账本保留 interrupted');

    for (const status of ['running','submitted','interrupted','needs-review']) {
        let state = mergeTaskLedger(readTaskLedger(ledgerPath), [{ ...B, status, reason: '不确定' }]);
        for (const observed of ['pending','unavailable','skipped','blocked','queued']) {
            state = mergeTaskLedger(state, [{ ...B, status: observed }]);
            assert.equal(state.items.find((item) => item.key === B.key).status, status);
        }
        let calls = 0;
        await executeQueue({ items: [B], previous: state.items, execute: async () => { calls++; },
            verify: async () => ({ complete: true }), checkpoint: async () => {} });
        assert.equal(calls, 0, `${status} must never auto-submit`);
    }
    note('四种不确定状态不会被普通扫描、失败或队列状态覆盖，不会自动重交');

    ledger = mergeTaskLedger(ledger, [{ ...B, status: 'complete', reason: '平台列表显示待批阅' }]);
    assert.equal(ledger.items.find((item) => item.key === B.key).status, 'complete');
    ledger = mergeTaskLedger(ledger, [{ ...B, status: 'submitted' }]);
    ledger = mergeTaskLedger(ledger, [{ ...B, status: 'already-complete' }]);
    assert.equal(ledger.items.find((item) => item.key === B.key).status, 'complete');
    note('只有明确的平台完成状态可解除不确定记录');

    // A process can fail after the ledger write but before replacing latest.json.
    // The last report is stale, but durable running history must still stop the next run.
    ledger = mergeTaskLedger(ledger, [{ ...B, status: 'running' }]);
    saveTaskLedger(ledgerPath, ledger);
    writeFileSync(reportPath, JSON.stringify({ phase: 'finished', items: [{ ...B, status: 'complete' }] }));
    ledger = readTaskLedger(ledgerPath, { legacyPath: reportPath });
    assert.equal(ledger.items.find((item) => item.key === B.key).status, 'running');
    note('最新报告过期或写入中断时，独立账本仍是防重复提交的依据');

    ledger = mergeTaskLedger(ledger, [{ ...A, href: 'https://test.invalid/?enc=SECRET', token: 'SECRET' }]);
    saveTaskLedger(ledgerPath, ledger);
    assert.equal(readFileSync(ledgerPath, 'utf8').includes('SECRET'), false);
    assert.equal(readdirSync(sandbox).some((name) => name.endsWith('.tmp')), false);
    note('账本不保存带签名地址或令牌，原子保存不留下临时文件');

    const goodLedger = readFileSync(ledgerPath, 'utf8');
    for (const invalid of [
        '{truncated',
        JSON.stringify({ version: 9, updatedAt: new Date().toISOString(), items: [] }),
        JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), items: [{ ...B, status: 'unknown' }] }),
        JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), items: [B, B] }),
        JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), items: 'missing' }),
    ]) {
        writeFileSync(ledgerPath, invalid);
        assert.throws(() => readTaskLedger(ledgerPath, { legacyPath: reportPath }), /损坏|未知|JSON|重复|数组/);
        assert.equal(readFileSync(ledgerPath, 'utf8'), invalid, 'failed reads must not overwrite evidence');
    }
    writeFileSync(ledgerPath, goodLedger);
    note('损坏 JSON、未知版本/状态、重复编号和非法数组全部拒绝，原文件保留');

    const missingLedger = join(sandbox, 'never-created.json');
    for (const invalid of ['{truncated', '{}', JSON.stringify({ items: [{ ...B, status: 'unknown' }] })]) {
        writeFileSync(reportPath, invalid);
        assert.throws(() => readTaskLedger(missingLedger, { legacyPath: reportPath }));
        assert.equal(existsSync(missingLedger), false);
    }
    assert.deepEqual(readTaskLedger(join(sandbox, 'new-install.json')).items, []);
    note('损坏旧历史不静默迁移为空，新安装无历史才允许空账本');
    console.log('全部任务账本离线测试通过，未启动浏览器、模型或网络请求。');
} finally {
    if (dirname(resolve(sandbox)) !== testParent) throw new Error('拒绝清理测试目录之外的路径');
    rmSync(sandbox, { recursive: true, force: true });
}
