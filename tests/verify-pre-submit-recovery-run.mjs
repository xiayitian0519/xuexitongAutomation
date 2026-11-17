// Synthetic integration only: no browser, service, model, report or ledger file reads/writes.
import assert from 'node:assert/strict';
import { parseArgs, executeSelectedQueue } from '../automation/run.mjs';
import { mergeTaskLedger } from '../automation/task-ledger.mjs';

const course = 'course:100:200';
const row = (id, kind = 'work') => ({ key: `${course}:${kind}:${id}`, kind,
    title: `Synthetic ${id}`, courseTitle: 'Synthetic course', status: 'pending' });
const recoverable = row(1), historical = row(2), chapter = row(3, 'chapter'), complete = row(4);
const reason = '第 1 题 A 无法确认选中状态，已停止提交';
const now = Date.now();
const time = offset => new Date(now + offset).toISOString();
const source = { runId: '12345678-1234-4234-8234-123456789abc', mode: 'run', phase: 'stopped',
    startedAt: time(-10000), finishedAt: time(-3000), updatedAt: time(-2500),
    courseKeys: [course], answerPolicy: { questionsOnly: true, skipWorkedSolutions: true },
    items: [{ ...recoverable, status: 'blocked', reason, startedAt: time(-9000), finishedAt: time(-5000) },
        { ...chapter, status: 'blocked', reason, startedAt: time(-8000), finishedAt: time(-4000) },
        { ...historical, status: 'needs-review', reason: '上次执行结果未确认' },
        { ...complete, status: 'complete' }],
};
const previous = [recoverable, historical, chapter, complete].map(item => ({ ...item, status: 'running' }));
const fresh = [recoverable, historical, chapter, { ...complete, status: 'complete' }];
const args = ['--run', '--questions-only', '--course-key', course];
assert.equal(parseArgs([...args, '--resume-pre-submit']).resumePreSubmit, true);
for (const invalid of [
    ['--run', '--resume-pre-submit'],
    ['--run', '--questions-only', '--resume-pre-submit'],
    ['--run', '--course-key', course, '--resume-pre-submit'],
    ['--scan', '--questions-only', '--course-key', course, '--resume-pre-submit'],
    [...args, '--resume-pre-submit', '--resume-pre-submit'],
]) assert.throws(() => parseArgs(invalid));
console.log('PASS recovery flag requires questions-only execution and an explicit course allowlist');

const harness = async (options, sourceReport = source) => {
    const executed = [], checkpoints = [];
    let prepared = 0;
    let ledger = { version: 1, updatedAt: time(-2000), items: structuredClone(previous) };
    const report = await executeSelectedQueue({ items: fresh, previous, options, sourceReport,
        prepare: async () => { prepared++; },
        execute: async item => { executed.push(item.key); return { status: 'verify' }; },
        verify: async () => ({ complete: true }),
        checkpoint: async current => {
            checkpoints.push(structuredClone(current));
            ledger = mergeTaskLedger(ledger, current.items);
        },
    });
    return { report, executed, prepared, checkpoints, ledger };
};
const before = structuredClone({ source, previous, fresh });
{
    const state = await harness(parseArgs(args));
    assert.deepEqual(state.executed, []);
    assert.equal(state.prepared, 0);
    assert.equal(state.report.runScope.preSubmitRecovery, undefined);
}
console.log('PASS ordinary runs retain all uncertain duplicate-submission protection');
{
    const state = await harness(parseArgs([...args, '--resume-pre-submit']));
    assert.deepEqual(state.executed, [recoverable.key]);
    assert.equal(state.prepared, 1);
    assert.deepEqual(state.report.runScope.preSubmitRecovery,
        { sourceRunId: source.runId, taskKeys: [recoverable.key] });
    assert.ok(state.checkpoints.every(report => report.runScope.preSubmitRecovery.sourceRunId === source.runId));
    assert.equal(state.report.items.find(row => row.key === historical.key).status, 'needs-review');
    assert.equal(state.report.items.find(row => row.key === chapter.key).status, 'needs-review');
    assert.equal(state.report.items.find(row => row.key === complete.key).status, 'already-complete');
    assert.equal(state.ledger.items.find(row => row.key === recoverable.key).status, 'complete');
    assert.ok(state.ledger.items.filter(row => row.key === historical.key || row.key === chapter.key)
        .every(row => row.status === 'needs-review'));
    assert.equal(state.checkpoints[0].items.find(row => row.key === recoverable.key).status, 'queued');
}
assert.deepEqual({ source, previous, fresh }, before);
console.log('PASS only the proven work failure resumes, scoped audit survives checkpoints, source/history remain unchanged');
{
    let effects = 0;
    const bad = { ...source, courseKeys: ['course:101:201'] };
    await assert.rejects(executeSelectedQueue({ items: fresh, previous,
        options: parseArgs([...args, '--resume-pre-submit']), sourceReport: bad,
        prepare: async () => { effects++; }, execute: async () => { effects++; },
        verify: async () => { effects++; }, checkpoint: async () => { effects++; },
    }), /恢复校验/);
    assert.equal(effects, 0);
}
console.log('PASS mismatched source rejects before preparing, executing or checkpointing');
console.log('Pre-submit recovery integration: 4 groups passed');
