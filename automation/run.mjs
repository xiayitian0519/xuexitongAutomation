import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync, openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { BrowserDriver, ROOT, loadBrowserEngine } from './browser-driver.mjs';
import { executeQueue, publicItem, cleanError, isUncertainStatus, actionable } from './task-queue.mjs';
import { readTaskLedger, mergeTaskLedger, saveTaskLedger } from './task-ledger.mjs';
import { installQuestionOnlyGuards } from './question-policy.mjs';
import { preparePreSubmitRecovery } from './pre-submit-recovery.mjs';

export const STATE_DIR = join(ROOT, '.automation.local');
const REPORT = join(STATE_DIR, 'latest.json'), LOCK = join(STATE_DIR, 'active.json'), STOP = join(STATE_DIR, 'stop.json');
export const TASK_LEDGER = join(STATE_DIR, 'task-ledger.json');
const SESSION = join(STATE_DIR, 'chaoxing-session.json');
const BROWSER_POLICY = join(STATE_DIR, 'browser-policy.json');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const loadJson = (path, fallback = null) => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; } };
const saveJson = (path, data) => { writeFileSync(`${path}.tmp`, JSON.stringify(data, null, 2)); renameSync(`${path}.tmp`, path); };

export const browserPolicy = () => loadJson(BROWSER_POLICY, { backend: 'isolated-edge' });
export function assertLocalBrowserLaunchAllowed(mode) {
    if (!['run','scan','login'].includes(mode)) return;
    const policy = existsSync(BROWSER_POLICY) ? JSON.parse(readFileSync(BROWSER_POLICY, 'utf8')) : { backend: 'isolated-edge' };
    if (policy.backend === 'official-browser')
        throw new Error('浏览器后端不是专用 isolated-edge；已停止。请核对专用 Edge 配置，不得改用常用浏览器或桌面控制。');
    if (policy.backend !== 'isolated-edge')
        throw new Error('浏览器后端必须为 isolated-edge；禁止改用桌面鼠标、键盘、窗口激活或焦点切换。请核对专用 Edge 连接。');
    throw new Error('EXISTING_BROWSER_ONLY：请通过 automation/existing-session.mjs 复用已连接的专用 Edge；本项目不自动新建窗口。');
}

// Preserve session cookies from this controller's own profile, with original expiry unchanged.
// This file stays inside the ignored private state directory and is never included in reports.
const platformCookie = (cookie) => typeof cookie?.domain === 'string' &&
    /(^|\.)chaoxing\.com$/i.test(cookie.domain.replace(/^\./, ''));
export async function saveLoginSession(context, path = SESSION) {
    const cookies = (await context.cookies()).filter(platformCookie);
    saveJson(path, { cookies });
}
export async function restoreLoginSession(context, path = SESSION) {
    const cookies = (loadJson(path)?.cookies || []).filter((cookie) => platformCookie(cookie) &&
        (cookie.expires === -1 || cookie.expires > Date.now() / 1000));
    if (cookies.length) await context.addCookies(cookies);
}

const fullTaskKey = /^course:\d+:\d+:(?:work|chapter):\d+$/;
const fullCourseKey = /^course:\d+:\d+$/;
function validateCourseKeys(courseKeys) {
    if (!Array.isArray(courseKeys) || courseKeys.some(key => typeof key !== 'string' || !fullCourseKey.test(key)))
        throw new Error('--course-key 必须是完整课程编号：course:<课程id>:<班级id>');
    if (new Set(courseKeys).size !== courseKeys.length) throw new Error('--course-key 不能重复指定同一课程');
}
function validateRunLimits(taskKeys, maxTasks) {
    if (!Array.isArray(taskKeys) || taskKeys.some((key) => typeof key !== 'string' || !fullTaskKey.test(key)))
        throw new Error('--task-key 必须是完整任务编号：course:<课程id>:<班级id>:work|chapter:<任务id>');
    if (new Set(taskKeys).size !== taskKeys.length) throw new Error('--task-key 不能重复指定同一任务');
    if (maxTasks !== undefined && (!Number.isSafeInteger(maxTasks) || maxTasks <= 0))
        throw new Error('--max-tasks 必须是安全范围内的正整数');
}

function validateRecoveryOptions(options) {
    if (!options.resumePreSubmit) return;
    if (options.mode !== 'run' || options.questionsOnly !== true || !options.courseKeys?.length)
        throw new Error('--resume-pre-submit 仅可与 --run、--questions-only 和明确的 --course-key 白名单一起使用');
}

export function parseArgs(args) {
    const options = { mode: 'scan', course: '', loginMs: 120000, timeoutMs: 14400000, taskKeys: [], courseKeys: [] };
    let selected = false;
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (['--run','--scan','--login','--status','--stop','--check','--help'].includes(arg)) {
            if (selected) throw new Error('一次只能选择一种模式');
            options.mode = arg.slice(2); selected = true;
        } else if (arg === '--questions-only') {
            if (options.questionsOnly) throw new Error('--questions-only 不能重复指定');
            options.questionsOnly = true;
        } else if (arg === '--resume-pre-submit') {
            if (options.resumePreSubmit) throw new Error('--resume-pre-submit 不能重复指定');
            options.resumePreSubmit = true;
        } else if (['--course','--course-key','--login-seconds','--task-seconds','--task-key','--max-tasks'].includes(arg)) {
            const value = args[++i];
            if (!value || value.startsWith('--')) throw new Error(`${arg} 缺少参数`);
            if (arg === '--course') options.course = value;
            else if (arg === '--course-key') options.courseKeys.push(value);
            else if (arg === '--task-key') options.taskKeys.push(value);
            else if (arg === '--max-tasks') {
                if (options.maxTasks !== undefined) throw new Error('--max-tasks 不能重复指定');
                if (!/^\d+$/.test(value)) throw new Error('--max-tasks 必须是正整数');
                options.maxTasks = Number(value);
            }
            else {
                const seconds = Number(value);
                if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 86400) throw new Error(`${arg} 必须在 1～86400 秒之间`);
                options[arg === '--login-seconds' ? 'loginMs' : 'timeoutMs'] = seconds * 1000;
            }
        } else throw new Error(`未知参数：${arg}`);
    }
    validateRunLimits(options.taskKeys, options.maxTasks);
    validateCourseKeys(options.courseKeys);
    if (options.courseKeys.length && !['run','scan'].includes(options.mode)) throw new Error('--course-key 仅可与 --run 或 --scan 一起使用');
    if (options.mode !== 'run' && (options.taskKeys.length || options.maxTasks !== undefined))
        throw new Error('--task-key 和 --max-tasks 仅可与 --run 一起使用');
    if (options.questionsOnly && options.mode !== 'run') throw new Error('--questions-only 仅可与 --run 一起使用');
    validateRecoveryOptions(options);
    return options;
}

// Select only after discovery has finished. Keep uncertain items in the queue so its normal
// duplicate-submit protection remains visible; only executable pending items consume the limit.
export function selectRunItems({ items, previous = [], course = '', courseKeys = [], taskKeys = [], maxTasks }) {
    validateRunLimits(taskKeys, maxTasks);
    validateCourseKeys(courseKeys);
    const seen = new Set();
    for (const item of items) {
        if (!item || typeof item.key !== 'string' || !item.key || seen.has(item.key))
            throw new Error('本次扫描存在空白或重复任务编号，未启动任何执行');
        seen.add(item.key);
    }
    const allowedCourses = new Set(courseKeys);
    const scoped = items.filter((item) => (!course || (typeof item.courseTitle === 'string' && item.courseTitle.includes(course))) &&
        (!allowedCourses.size || allowedCourses.has(item.key.match(/^course:\d+:\d+/)?.[0])));
    const scopedKeys = new Set(scoped.map((item) => item.key));
    for (const key of taskKeys) {
        if (!scopedKeys.has(key)) throw new Error(`指定任务不在本次课程扫描范围内或不存在：${key}；未启动任何执行`);
    }
    const requested = new Set(taskKeys), old = new Map(previous.map((item) => [item.key,item]));
    const selected = [], limit = maxTasks ?? Infinity;
    let plannedExecutions = 0, deferredTasks = 0;
    for (const item of scoped) {
        if (requested.size && !requested.has(item.key)) continue;
        const executable = actionable(item) && !isUncertainStatus(old.get(item.key)?.status);
        if (executable && plannedExecutions >= limit) { deferredTasks++; continue; }
        if (executable) plannedExecutions++;
        selected.push(item);
    }
    return { items: selected, runScope: { taskKeys: [...taskKeys], courseKeys: [...courseKeys], maxTasks: maxTasks ?? null, plannedExecutions, deferredTasks } };
}

export async function executeSelectedQueue({ items, previous = [], options = {}, sourceReport, prepare = async () => {},
    execute, verify, checkpoint, stopped = () => false }) {
    if (options.mode !== undefined && options.mode !== 'run') throw new Error('任务执行范围仅可用于 --run');
    validateRecoveryOptions(options);
    const preparedHistory = preparePreSubmitRecovery({ sourceReport, previous, items,
        courseKeys: options.courseKeys, enabled: options.resumePreSubmit });
    const effectivePrevious = preparedHistory.previous;
    const selection = selectRunItems({ items, previous: effectivePrevious, course: options.course, courseKeys: options.courseKeys, taskKeys: options.taskKeys, maxTasks: options.maxTasks });
    if (options.resumePreSubmit) selection.runScope.preSubmitRecovery = preparedHistory.recovery;
    if (options.questionsOnly) {
        selection.runScope.answerPolicy = { questionsOnly: true, skipWorkedSolutions: true };
        // Open independent assignments before inspecting chapters that may contain only videos.
        selection.items = [
            ...selection.items.filter(item => item.kind === 'work'),
            ...selection.items.filter(item => item.kind !== 'work'),
        ];
    }
    if (stopped()) throw new Error('启动执行前已停止');
    if (selection.runScope.plannedExecutions) await prepare(selection.runScope);
    const report = await executeQueue({ items: selection.items, previous: effectivePrevious, execute, verify, stopped,
        checkpoint: (current) => checkpoint({ ...current, runScope: selection.runScope }) });
    return { ...report, runScope: selection.runScope };
}

function lockRun(runId) {
    const old = loadJson(LOCK);
    if (old?.pid) {
        let alive = true;
        try { process.kill(old.pid, 0); } catch (error) { alive = error.code !== 'ESRCH'; }
        if (alive) throw new Error('已有自动任务正在运行；用 --status 查看，或 --stop 停止');
        unlinkSync(LOCK);
    } else if (existsSync(LOCK)) throw new Error('运行锁无法识别，未启动第二个任务');
    const fd = openSync(LOCK, 'wx');
    try { writeFileSync(fd, JSON.stringify({ pid: process.pid, runId, startedAt: new Date().toISOString() })); }
    finally { closeSync(fd); }
}

async function ensureService() {
    const scriptPath = join(ROOT, 'deepseek-console/xuexitong-console.js');
    const probe = async () => {
        const token = readFileSync(scriptPath, 'utf8').match(/const LOCAL_TOKEN = '([^']+)';/)?.[1];
        if (!token || token === '__LOCAL_TOKEN__') return false;
        try {
            const response = await fetch('http://127.0.0.1:37841/health', { signal: AbortSignal.timeout(2000),
                headers: { Origin: 'https://mooc1.chaoxing.com', 'X-Xuexitong-Token': token } });
            if (response.status === 403) throw new Error('本地服务令牌与当前文件不匹配，不能安全复用');
            if (!response.ok) return false;
            const health = await response.json();
            if (health.ok && health.provider !== 'workbuddy-cli')
                throw new Error('本地服务未报告 WorkBuddy CLI 模式。请重启 start-local-service-cli.cmd 后重试');
            if (health.ok && (health.protocolVersion !== 2 ||
                !['request-cancel','usage-meta'].every(value => health.capabilities?.includes(value))))
                throw new Error('本地服务版本较旧，请重启 start-local-service-cli.cmd 以启用停止取消和用量记录');
            return health.ok === true;
        } catch (error) { if (/令牌|WorkBuddy CLI 模式|本地服务版本较旧/.test(error.message)) throw error; return false; }
    };
    if (await probe()) return;
    const serviceLog = openSync(join(STATE_DIR, 'service.log'), 'a');
    const child = spawn(process.execPath, ['deepseek-local.mjs','--workbuddy-cli'], {
        cwd: join(ROOT, 'deepseek-console'), windowsHide: true, stdio: ['ignore',serviceLog,serviceLog],
    });
    closeSync(serviceLog);
    let failure = '';
    child.on('error', (error) => { failure = cleanError(error); });
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
        if (await probe()) { child.unref(); return; }
        if (child.exitCode !== null || failure) break;
        await sleep(300);
    }
    child.kill();
    throw new Error(`本地答题服务未启动：${failure || '超过 10 秒未响应'}`);
}

export async function main(args = process.argv.slice(2)) {
    const options = parseArgs(args);
    assertLocalBrowserLaunchAllowed(options.mode);
    if (options.mode === 'help') {
        console.log('学习通总控：--scan 只扫描；--run 执行；--login 首次登录；--status 查看；--stop 停止；--check 检查环境。\n可选 --course 课程名片段；--course-key 完整课程编号（可重复）；--login-seconds 秒数；--task-seconds 单项上限。\n仅 --run 可用：--task-key 完整任务编号；--max-tasks 正整数；--questions-only（不播放视频，跳过需要过程的题目）；--resume-pre-submit（仅恢复上一段已证实发生在提交前的选项状态失败，须显式课程白名单）。');
        return;
    }
    if (options.mode === 'status') {
        const active = loadJson(LOCK);
        let alive = false;
        if (active?.pid) { try { process.kill(active.pid, 0); alive = true; } catch {} }
        console.log(JSON.stringify({ browserPolicy: browserPolicy(), active, alive, report: loadJson(REPORT, { phase: 'not-started' }) }, null, 2)); return;
    }
    mkdirSync(STATE_DIR, { recursive: true });
    if (options.mode === 'stop') {
        const active = loadJson(LOCK);
        if (!active) { console.log('当前没有自动任务。'); return; }
        saveJson(STOP, { runId: active.runId, requestedAt: new Date().toISOString() });
        console.log('已请求停止。执行器会停止后续填写和提交；已发出的提交无法撤回。'); return;
    }
    const engine = await loadBrowserEngine();
    if (options.mode === 'check') {
        const edge = process.platform !== 'win32' || [process.env['PROGRAMFILES(X86)'],process.env.PROGRAMFILES]
            .filter(Boolean).some((base) => existsSync(join(base, 'Microsoft/Edge/Application/msedge.exe')));
        console.log(JSON.stringify({ browserPolicy: browserPolicy(), browserEngine: !!engine.chromium, edge, stateDirectory: STATE_DIR,
            cliModule: existsSync(join(ROOT, 'deepseek-console/wb-cli-request.mjs')), launchesBrowser: false }, null, 2));
        if (!edge) process.exitCode = 1;
        return;
    }
    const runId = randomUUID();
    lockRun(runId);
    let context, driver, ledger, lastReport, recoverySource, interrupted = false;
    let recoveryEvidenceSaved = !options.resumePreSubmit;
    const onSignal = () => { interrupted = true; };
    process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal);
    const stopped = () => interrupted || loadJson(STOP)?.runId === runId;
    const checkpoint = async (report) => {
        if (!ledger) throw new Error('任务账本尚未安全读取，未更新任何报告');
        lastReport = report;
        ledger = mergeTaskLedger(ledger, report.items || []);
        // Commit durable history first. A crash or report-write failure cannot erase a running submit.
        saveTaskLedger(TASK_LEDGER, ledger);
        saveJson(REPORT, { ...report, runId, mode: options.mode, courseFilter: options.course,
            courseKeys: options.courseKeys,
            answerPolicy: options.questionsOnly ? { questionsOnly: true, skipWorkedSolutions: true } : null,
            taskKeys: options.taskKeys, maxTasks: options.maxTasks ?? null, updatedAt: new Date().toISOString() });
    };
    try {
        // Migrate the old report only if there is no ledger. Corrupt/unknown history fails closed.
        ledger = readTaskLedger(TASK_LEDGER, { legacyPath: REPORT });
        if (options.resumePreSubmit) {
            // Capture the last ended run before the first checkpoint can replace latest.json.
            recoverySource = loadJson(REPORT);
            preparePreSubmitRecovery({ sourceReport: recoverySource, previous: ledger.items, items: [],
                courseKeys: options.courseKeys, enabled: true });
            const evidenceDirectory = join(STATE_DIR, 'pre-submit-recovery');
            mkdirSync(evidenceDirectory, { recursive: true });
            const evidence = join(evidenceDirectory, `${recoverySource.runId}.json`);
            const serialized = JSON.stringify(recoverySource, null, 2);
            if (existsSync(evidence)) {
                if (readFileSync(evidence, 'utf8') !== serialized)
                    throw new Error('同一来源运行的恢复证据发生变化，未继续执行');
            } else writeFileSync(evidence, serialized, { flag: 'wx' });
            recoveryEvidenceSaved = true;
        }
        saveTaskLedger(TASK_LEDGER, ledger);
        await checkpoint({ phase: 'opening-browser', items: ledger.items });
        context = await engine.chromium.launchPersistentContext(join(STATE_DIR, 'edge-profile'), {
            channel: 'msedge', headless: false, viewport: null,
        });
        const answerPolicy = options.questionsOnly ? { questionsOnly: true, skipWorkedSolutions: true } : null;
        await installQuestionOnlyGuards(context, answerPolicy);
        await restoreLoginSession(context);
        driver = new BrowserDriver(context, { stopped, timeoutMs: options.timeoutMs, answerPolicy,
            onAuthenticated: () => saveLoginSession(context),
            log: (message) => console.log(cleanError(message)) });
        if (options.mode === 'login') {
            const courses = await driver.courses({ loginMs: options.loginMs });
            await checkpoint({ phase: 'login-ready', courseCount: courses.length, items: ledger.items });
            console.log('已确认课程列表可读，登录状态已保留；后续可以从对话直接启动。'); return;
        }
        await checkpoint({ phase: 'scanning', items: ledger.items });
        const plan = await driver.discover({ filter: options.course, courseKeys: options.courseKeys, loginMs: options.loginMs });
        const issues = plan.issues.map((issue) => ({ ...issue, reason: cleanError(issue.reason) }));
        // A filtered scan updates only observed keys; all other courses' history remains durable.
        // A freshly observed platform-complete state can resolve an earlier uncertain submission.
        ledger = mergeTaskLedger(ledger, plan.items.map(publicItem));
        saveTaskLedger(TASK_LEDGER, ledger);
        if (options.mode === 'scan') {
            // Keep uncertain submissions across a read-only scan so the next run cannot lose them.
            const old = new Map(ledger.items.map((item) => [item.key, item]));
            const items = plan.items.map((item) => {
                const prior = old.get(item.key);
                return item.status === 'pending' && prior && isUncertainStatus(prior.status)
                    ? { ...publicItem(item), status: 'needs-review', reason: prior.reason || '上次执行结果待核实' } : publicItem(item);
            });
            const phase = issues.length ? 'scan-incomplete' : 'scan-complete';
            await checkpoint({ phase, courseCount: plan.courseCount, issues, items });
            console.log(JSON.stringify({ phase, courseCount: plan.courseCount,
                pending: items.filter((item) => item.status === 'pending').length, issues: issues.length, report: REPORT }, null, 2)); return;
        }
        const report = await executeSelectedQueue({ items: plan.items, previous: ledger.items, options, sourceReport: recoverySource, stopped,
            prepare: ensureService,
            execute: (item) => driver.execute(item), verify: (item) => driver.verify(item),
            checkpoint: (report) => checkpoint({ ...report, issues, courseCount: plan.courseCount }) });
        if (issues.length && report.phase === 'finished') {
            report.phase = 'finished-with-unresolved';
            await checkpoint({ ...report, issues, courseCount: plan.courseCount });
        }
        console.log(JSON.stringify({ phase: report.phase, complete: report.items.filter((item) => item.status === 'complete').length,
            unresolved: report.items.filter((item) => ['needs-review','blocked','queued'].includes(item.status)).length,
            runScope: report.runScope, report: REPORT }, null, 2));
    } catch (error) {
        // Do not overwrite unreadable history. Use the in-memory checkpoint rather than a stale
        // latest report, which might otherwise erase an uncertain submit after a failed write.
        if (ledger && recoveryEvidenceSaved) {
            const latest = lastReport || { items: ledger.items };
            await checkpoint({ ...latest, phase: stopped() ? 'stopped' : 'blocked', error: cleanError(error),
                items: (latest.items || []).map((row) => row.status === 'running' ? { ...row, status: 'interrupted' } : row) });
        }
        throw error;
    } finally {
        if (context && driver?.authenticated) {
            try { await saveLoginSession(context); }
            catch { console.error('专用浏览器登录状态保存失败，下次可能需要重新扫码'); }
        }
        await context?.close().catch(() => {});
        process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal);
        if (loadJson(LOCK)?.runId === runId) unlinkSync(LOCK);
    }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
    main().catch((error) => { console.error(cleanError(error)); process.exitCode = 1; });
