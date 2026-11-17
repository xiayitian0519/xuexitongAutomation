// A narrow, in-memory exception to queue protection. This module never changes the ledger.
import { isUncertainStatus } from './task-queue.mjs';

const COURSE_KEY = /^course:\d+:\d+$/;
const TASK_KEY = /^(course:\d+:\d+):(work|chapter):\d+$/;
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PRE_SUBMIT_REASON = /^第 [1-9]\d* 题 [A-H] 无法确认选中状态，已停止提交$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const FINISHED_PHASES = new Set(['stopped', 'finished', 'finished-with-unresolved']);
const STATUSES = new Set(['pending', 'complete', 'already-complete', 'unavailable', 'queued',
    'running', 'submitted', 'interrupted', 'needs-review', 'blocked', 'skipped']);
const CLOCK_MARGIN_MS = 2000;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (message) => { throw new Error(`提交前恢复校验失败：${message}`); };
// JavaScript's $ also matches before a final newline; require the complete string to match.
const exact = (pattern, value) => typeof value === 'string' && pattern.exec(value)?.[0] === value;

function courseSet(value, label) {
    if (!Array.isArray(value) || !value.length ||
        value.some((key) => !exact(COURSE_KEY, key)))
        fail(`${label}必须是非空的完整课程编号白名单`);
    const result = new Set(value);
    if (result.size !== value.length) fail(`${label}包含重复课程编号`);
    return result;
}

function taskMap(value, label, allowedCourses) {
    if (!Array.isArray(value)) fail(`${label}不是任务数组`);
    const result = new Map();
    for (const row of value) {
        if (!object(row) || typeof row.key !== 'string') fail(`${label}包含损坏任务记录`);
        const match = row.key.match(TASK_KEY);
        if (!match || match[0] !== row.key || row.kind !== match[2] || !STATUSES.has(row.status) ||
            (row.reason !== undefined && typeof row.reason !== 'string'))
            fail(`${label}包含格式、类型或状态损坏的任务记录`);
        if (result.has(row.key)) fail(`${label}包含重复任务编号`);
        if (allowedCourses && !allowedCourses.has(match[1])) fail(`${label}包含授权课程范围之外的任务`);
        result.set(row.key, row);
    }
    return result;
}

function timestamp(value, label) {
    if (!exact(ISO_TIME, value) || !Number.isFinite(Date.parse(value)))
        fail(`${label}缺失或不是合法时间`);
    const parsed = Date.parse(value);
    const normalized = value.replace(/(?:\.(\d{1,3}))?Z$/, (_match, fraction = '') => `.${fraction.padEnd(3, '0')}Z`);
    if (new Date(parsed).toISOString() !== normalized) fail(`${label}包含不存在的日期或时刻`);
    return parsed;
}

/**
 * Recover only a proven pre-submit state-check failure from one ended, equally scoped run.
 * The returned history is for this queue invocation only; callers must retain the durable ledger.
 */
export function preparePreSubmitRecovery(options) {
    const { previous, enabled } = options;
    // Do not even access sourceReport when recovery was not explicitly enabled.
    if (enabled === undefined || enabled === false)
        return { previous, recovery: { sourceRunId: null, taskKeys: [] } };
    if (enabled !== true) fail('启用开关必须是布尔值');

    const { sourceReport: source, items, courseKeys } = options;
    const allowedCourses = courseSet(courseKeys, '当前课程范围');
    if (!object(source) || !FINISHED_PHASES.has(source.phase) || source.mode !== 'run' ||
        !exact(RUN_ID, source.runId) || !object(source.answerPolicy) ||
        source.answerPolicy?.questionsOnly !== true || source.answerPolicy?.skipWorkedSolutions !== true)
        fail('来源必须是已结束、编号有效且遵守仅答题与跳过过程题策略的执行报告');
    const sourceCourses = courseSet(source.courseKeys, '来源课程范围');
    if (sourceCourses.size !== allowedCourses.size || [...sourceCourses].some((key) => !allowedCourses.has(key)))
        fail('来源与当前课程白名单不完全相同');

    const sourceStarted = timestamp(source.startedAt, '来源开始时间');
    const sourceFinished = timestamp(source.finishedAt, '来源结束时间');
    const sourceUpdated = timestamp(source.updatedAt, '来源更新时间');
    const now = Date.now();
    if (sourceUpdated < sourceStarted || sourceFinished < sourceStarted ||
        sourceFinished > sourceUpdated + CLOCK_MARGIN_MS) fail('来源时间顺序异常');
    if (Math.max(sourceStarted, sourceFinished, sourceUpdated) > now + CLOCK_MARGIN_MS)
        fail('来源报告包含未来时间');
    const sourceTasks = taskMap(source.items, '来源报告', allowedCourses);
    const freshTasks = taskMap(items, '当前平台记录', allowedCourses);
    // Historical records outside this run's course scope remain protected and unchanged.
    const priorTasks = taskMap(previous, '原任务历史');
    const taskKeys = [];
    for (const row of sourceTasks.values()) {
        // Chapter submissions keep their existing protections, including historical physics work.
        if (row.kind !== 'work' || row.status !== 'blocked' || !exact(PRE_SUBMIT_REASON, row.reason)) continue;
        const started = timestamp(row.startedAt, '来源任务开始时间');
        const finished = timestamp(row.finishedAt, '来源任务结束时间');
        if (finished < started || started < sourceStarted - CLOCK_MARGIN_MS ||
            finished > Math.min(sourceFinished, sourceUpdated, now) + CLOCK_MARGIN_MS)
            fail('来源任务时间超出本次执行范围或顺序异常');
        if (freshTasks.get(row.key)?.status === 'pending' && isUncertainStatus(priorTasks.get(row.key)?.status))
            taskKeys.push(row.key);
    }
    const recovered = new Set(taskKeys);
    const effectivePrevious = recovered.size
        ? previous.map((row) => recovered.has(row.key) ? { ...row, status: 'pending' } : row)
        : previous;
    return { previous: effectivePrevious, recovery: { sourceRunId: source.runId, taskKeys } };
}
