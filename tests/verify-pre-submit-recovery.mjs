// Pure offline recovery checks: no browser, model, private state, files or network requests.
import assert from 'node:assert/strict';
import { preparePreSubmitRecovery } from '../automation/pre-submit-recovery.mjs';

const A = 'course:100:200', B = 'course:101:201', HISTORICAL = 'course:99:199';
const RUN_ID = 'c3194200-f624-4487-9da7-22f646245da8';
const baseTime = Date.now() - 30 * 60_000;
const at = (offset) => new Date(baseTime + offset).toISOString();
const START = at(0), END = at(300_000);
const reason = '第 1 题 A 无法确认选中状态，已停止提交';
const item = (id, status = 'pending', course = A, kind = 'work') =>
    ({ key: `${course}:${kind}:${id}`, kind, title: `离线任务${id}`, status });
const failure = (id, overrides = {}) => ({ ...item(id, 'blocked'), reason,
    startedAt: at(60_000), finishedAt: at(120_000), ...overrides });
const report = (rows = [failure(1)]) => ({ runId: RUN_ID, mode: 'run', phase: 'stopped',
    answerPolicy: { questionsOnly: true, skipWorkedSolutions: true }, courseKeys: [A, B],
    startedAt: START, finishedAt: END, updatedAt: END, items: rows });
const input = (rows = [failure(1)]) => ({ sourceReport: report(rows), previous: [item(1, 'needs-review')],
    items: [item(1)], courseKeys: [B, A], enabled: true });
const recover = (options) => preparePreSubmitRecovery(options);
const clone = (value) => structuredClone(value);
const note = (name) => console.log(`PASS ${name}`);
let cases = 0;
const rejected = (options, pattern = /恢复校验失败/) => { assert.throws(() => recover(options), pattern); cases++; };

{
    const previous = [item(1, 'needs-review')];
    const options = { previous, enabled: false, get sourceReport() { throw new Error('must not read source'); } };
    const result = recover(options);
    assert.equal(result.previous, previous);
    assert.deepEqual(result.recovery, { sourceRunId: null, taskKeys: [] });
    assert.equal(recover({ previous }).previous, previous);
    note('禁用时不读取来源报告、不验证或改变历史对象');
}

{
    const options = input();
    const before = clone(options);
    const result = recover(options);
    assert.deepEqual(result.recovery, { sourceRunId: RUN_ID, taskKeys: [item(1).key] });
    assert.equal(result.previous[0].status, 'pending');
    assert.notEqual(result.previous, options.previous);
    assert.notEqual(result.previous[0], options.previous[0]);
    assert.deepEqual(options, before);
    assert.deepEqual(Object.keys(result.recovery).sort(), ['sourceRunId', 'taskKeys']);
    assert.equal(JSON.stringify(result.recovery).includes(reason), false);
    note('严格匹配的本次提交前失败仅生成内存副本与最小审计键');
}

{
    for (const status of ['running', 'interrupted', 'submitted', 'needs-review']) {
        const options = input(); options.previous[0].status = status;
        assert.equal(recover(options).previous[0].status, 'pending');
    }
    for (const status of ['pending', 'blocked', 'complete', 'already-complete', 'skipped', 'unavailable', 'queued']) {
        const options = input(); options.previous[0].status = status;
        assert.deepEqual(recover(options).recovery.taskKeys, []);
        assert.equal(recover(options).previous, options.previous);
    }
    note('仅四种受保护的不确定历史状态可进入明确恢复例外');
}

{
    for (const changed of [
        { reason: reason + '。' }, { reason: ' ' + reason }, { reason: reason + '\n额外说明' },
        { reason: reason + '\n' }, { reason: reason + '\r\n' },
        { reason: reason.replace('1 题', '0 题') }, { reason: reason.replace('1 题', '01 题') },
        { reason: reason.replace(' A ', ' I ') }, { reason: reason.replace(' A ', ' a ') },
        { reason: reason.replace('已停止提交', '已停止') }, { status: 'needs-review' },
        { status: 'complete' }, { reason: undefined },
    ]) {
        const options = input([failure(1, changed)]);
        assert.deepEqual(recover(options).recovery.taskKeys, []);
    }
    const options = input([failure(1, { reason: reason.replace('1 题 A', '231 题 H') })]);
    assert.deepEqual(recover(options).recovery.taskKeys, [item(1).key]);
    const chapter = input([failure(1, { ...item(1, 'blocked', A, 'chapter') })]);
    chapter.items = [item(1, 'pending', A, 'chapter')];
    chapter.previous = [item(1, 'needs-review', A, 'chapter')];
    assert.deepEqual(recover(chapter).recovery.taskKeys, []);
    assert.equal(recover(chapter).previous[0].status, 'needs-review');
    note('只认独立作业的完整固定错误模板，章节保护不解除');
}

{
    for (const status of ['complete', 'already-complete', 'unavailable', 'blocked', 'skipped', 'running', 'submitted', 'needs-review']) {
        const options = input(); options.items[0].status = status;
        assert.deepEqual(recover(options).recovery.taskKeys, []);
        assert.equal(recover(options).previous[0].status, 'needs-review');
    }
    const absentFresh = input(); absentFresh.items = [];
    assert.deepEqual(recover(absentFresh).recovery.taskKeys, []);
    const absentHistory = input(); absentHistory.previous = [];
    assert.deepEqual(recover(absentHistory).recovery.taskKeys, []);
    note('最新平台完成、非 pending 或记录缺失时均不恢复、不重复执行');
}

{
    const options = input();
    const protectedRows = [1, 2, 3, 4].map((id) => ({ ...item(id, 'submitted', HISTORICAL, 'chapter'),
        reason: '历史提交结果未知', nested: { untouched: true } }));
    options.previous.push(...protectedRows);
    const before = clone(options);
    Object.freeze(options.previous[0]);
    protectedRows.forEach((row) => { Object.freeze(row.nested); Object.freeze(row); });
    Object.freeze(options.previous);
    const result = recover(options);
    assert.deepEqual(result.previous.slice(1), protectedRows);
    protectedRows.forEach((row, index) => assert.equal(result.previous[index + 1], row));
    assert.deepEqual(options, before);
    note('范围外四份历史保护记录及嵌套对象保持原样，冻结输入也可用');
}

{
    for (const phase of ['stopped', 'finished', 'finished-with-unresolved']) {
        const options = input(); options.sourceReport.phase = phase;
        assert.deepEqual(recover(options).recovery.taskKeys, [item(1).key]);
    }
    for (const changed of [
        { phase: 'running' }, { phase: 'scan-complete' }, { mode: 'scan' },
        { runId: 'not-a-uuid' }, { runId: '00000000-0000-0000-0000-000000000000' }, { runId: RUN_ID + '\n' },
        { answerPolicy: null }, { answerPolicy: { questionsOnly: true } },
        { answerPolicy: { questionsOnly: 1, skipWorkedSolutions: true } },
        { answerPolicy: { questionsOnly: true, skipWorkedSolutions: false } },
    ]) {
        const options = input(); Object.assign(options.sourceReport, changed); rejected(options);
    }
    rejected({ ...input(), sourceReport: null });
    rejected({ ...input(), enabled: 'true' });
    note('来源必须是已结束的有效 UUID 执行报告并满足两项答题策略');
}

{
    for (const current of [[], [A], [A, B, HISTORICAL], [A, A], ['100:200'], [A + '\n', B], null])
        rejected({ ...input(), courseKeys: current });
    for (const source of [[], [A], [A, B, HISTORICAL], [A, A], ['course:invalid'], [A, B + '\n'], null]) {
        const options = input(); options.sourceReport.courseKeys = source; rejected(options);
    }
    const escapedSource = input([failure(1, { ...item(1, 'blocked', HISTORICAL) })]); rejected(escapedSource);
    const escapedFresh = input(); escapedFresh.items.push(item(2, 'pending', HISTORICAL)); rejected(escapedFresh);
    note('课程集合必须精确相同且非空，来源/当前任务越界立即拒绝');
}

{
    for (const list of ['sourceReport', 'items', 'previous']) {
        const options = input();
        if (list === 'sourceReport') options.sourceReport.items.push(clone(options.sourceReport.items[0]));
        else options[list].push(clone(options[list][0]));
        rejected(options, /重复任务编号/);
    }
    for (const list of ['sourceReport', 'items', 'previous']) {
        for (const changed of [null, { ...item(1), key: 'work:1' }, { ...item(1), key: item(1).key + '\n' }, { ...item(1), kind: 'chapter' },
            { ...item(1), status: 'unknown' }, { ...item(1), reason: {} }]) {
            const options = input();
            if (list === 'sourceReport') options.sourceReport.items = [changed];
            else options[list] = [changed];
            rejected(options);
        }
        const options = input();
        if (list === 'sourceReport') options.sourceReport.items = null;
        else options[list] = null;
        rejected(options);
    }
    note('三个来源的重复任务、损坏数组/键/类型/状态均拒绝，不覆盖记录');
}

{
    for (const changed of [
        { startedAt: undefined }, { finishedAt: undefined }, { startedAt: 'invalid' }, { finishedAt: '' },
        { startedAt: at(-2001) }, { finishedAt: at(302_001) },
        { startedAt: at(180_000), finishedAt: at(120_000) },
        { startedAt: at(-120_000), finishedAt: at(-60_000) },
        { startedAt: '0' }, { finishedAt: '2026-02-30T00:00:00.000Z' },
    ]) rejected(input([failure(1, changed)]));
    for (const changed of [
        { startedAt: undefined }, { updatedAt: undefined }, { startedAt: 'invalid' },
        { updatedAt: at(-1000) }, { finishedAt: 'invalid' }, { finishedAt: undefined },
        { finishedAt: at(-1000) }, { finishedAt: at(302_001) },
        { updatedAt: '2026-02-30T00:00:00.000Z' },
        { updatedAt: new Date(Date.now() + 10_000).toISOString() },
        { startedAt: new Date(Date.now() + 10_000).toISOString(),
            finishedAt: new Date(Date.now() + 11_000).toISOString(), updatedAt: new Date(Date.now() + 12_000).toISOString() },
    ]) { const options = input(); Object.assign(options.sourceReport, changed); rejected(options); }
    const afterFinished = input([failure(1, { finishedAt: at(302_001) })]);
    afterFinished.sourceReport.updatedAt = at(500_000);
    rejected(afterFinished);
    const boundary = input([failure(1, { startedAt: at(-2000), finishedAt: at(302_000) })]);
    assert.deepEqual(recover(boundary).recovery.taskKeys, [item(1).key]);
    note('开始/结束时间必备且有序，拒绝历史行、超过结束时间、未来或不存在的日期');
}

{
    const options = input([]);
    const result = recover(options);
    assert.equal(result.previous, options.previous);
    assert.deepEqual(result.recovery, { sourceRunId: RUN_ID, taskKeys: [] });
    const unrelated = input([item(1, 'skipped')]);
    assert.deepEqual(recover(unrelated).recovery.taskKeys, []);
    note('没有候选时返回空恢复清单并保持历史引用');
}

console.log(`全部提交前恢复离线测试通过（另含 ${cases} 项拒绝断言），未访问私有状态、浏览器、模型或网络。`);
