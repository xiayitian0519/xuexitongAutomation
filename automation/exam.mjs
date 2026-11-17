// Explicit single-exam entry. It is not added to broad course scans or queues.
import { readFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, isPlatformUrl, loadBrowserEngine } from './browser-driver.mjs';
import { restoreLoginSession, assertLocalBrowserLaunchAllowed } from './run.mjs';
import { cliExists } from '../deepseek-console/wb-cli-request.mjs';
import { runtimeDefaults } from '../listening/runtime-profile.mjs';
import { checkLocalAsr } from '../listening/preflight.mjs';
import { runExam } from './exam-runner.mjs';
import { digest } from '../listening/transcript-store.mjs';

export function validateExamSpec(spec) {
    if (spec?.schemaVersion !== 1 || typeof spec.identity?.title !== 'string' || !spec.identity.title.trim() ||
        !/^course:\d+:\d+$/.test(spec.identity.courseKey || '') || !/^[a-z0-9_-]+$/i.test(spec.identity.examId || '') ||
        !isPlatformUrl(spec.url)) throw new Error('EXAM_SPEC_INVALID');
    const params = new URL(spec.url).searchParams;
    const id = params.get('examId') || params.get('examid') || params.get('testPaperId');
    if (id !== String(spec.identity.examId)) throw new Error('EXAM_URL_ID_MISMATCH');
    if (!Number.isFinite(spec.minimumMinutes) || spec.minimumMinutes < 0 || spec.minimumMinutes > 1440) throw new Error('EXAM_MINIMUM_MINUTES_REQUIRED');
    if (typeof spec.deadline !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/.test(spec.deadline) ||
        !Number.isFinite(Date.parse(spec.deadline))) throw new Error('EXAM_DEADLINE_REQUIRED');
    if (spec.notBefore && (!/(?:Z|[+-]\d{2}:\d{2})$/.test(spec.notBefore) || !Number.isFinite(Date.parse(spec.notBefore)))) throw new Error('INVALID_EARLIEST_SUBMIT_TIME');
    if (spec.listening !== undefined && spec.listening !== false &&
        (!spec.listening || typeof spec.listening !== 'object' || Array.isArray(spec.listening))) throw new Error('INVALID_LISTENING_OPTIONS');
    if (spec.listening?.concurrency !== undefined && ![1, 2].includes(spec.listening.concurrency)) throw new Error('INVALID_ASR_CONCURRENCY');
    if (spec.listening?.threads !== undefined && (!Number.isInteger(spec.listening.threads) || spec.listening.threads < 1 || spec.listening.threads > 16))
        throw new Error('INVALID_ASR_THREADS');
    if (spec.listening?.audioHosts !== undefined && (!Array.isArray(spec.listening.audioHosts) ||
        spec.listening.audioHosts.some(host => typeof host !== 'string' || !/^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i.test(host)))) throw new Error('INVALID_AUDIO_HOST');
    return spec;
}
export async function main(args = process.argv.slice(2)) {
    const mode = args[0];
    if (!['--check', '--execute'].includes(mode) || args[1] !== '--spec' || args.length !== 3) throw new Error('使用 --check|--execute --spec 项目私有考试配置.json');
    const spec = validateExamSpec(JSON.parse(await readFile(resolve(args[2]), 'utf8')));
    if (!cliExists()) throw new Error('CODEBUDDY_CLI_NOT_FOUND');
    const model = spec.listening?.model || process.env.LISTENING_MODEL || join(ROOT, '.tmp/listening-model-small');
    const listening = spec.listening === false ? { enabled: false } :
        { ...await runtimeDefaults(model), ...spec.listening, model };
    if (listening.enabled !== false) await checkLocalAsr(listening);
    if (mode === '--check') {
        console.log(JSON.stringify({ phase: 'spec-checked', course: spec.identity.courseKey, title: spec.identity.title,
            listening: { concurrency: listening.concurrency, threads: listening.threads }, paidCalls: 0,
            note: '配置和文件检查通过不等于已登录或页面兼容。' }));
        return;
    }
    if (Date.now() >= Date.parse(spec.deadline)) throw new Error('EXAM_DEADLINE_REACHED');
    assertLocalBrowserLaunchAllowed('run');
    const directory = join(ROOT, '.automation.local/exams', digest(spec.identity));
    await mkdir(directory, { recursive: true });
    const engine = await loadBrowserEngine(), controller = new AbortController();
    const stop = () => controller.abort();
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    const browser = await engine.chromium.launch({ channel: 'msedge', headless: false });
    try {
        const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false });
        await restoreLoginSession(context);
        const page = await context.newPage();
        await page.goto(spec.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        const result = await runExam({ page, identity: spec.identity, directory, signal: controller.signal,
            minimumMinutes: spec.minimumMinutes, notBefore: spec.notBefore, deadline: spec.deadline, listening,
            onEvent: event => console.log(JSON.stringify({ event: 'exam-progress', ...event })),
            onCompletion: event => console.log(JSON.stringify({ event: 'exam-submitted', ...event })) });
        console.log(JSON.stringify({ event: 'exam-finished', ...result }));
    } finally {
        await browser.close();
        process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
    main().catch(error => { console.error(/^[A-Z_]+$/.test(error.message) ? error.message : 'EXAM_RUN_FAILED'); process.exitCode = 1; });
