import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve, dirname, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { pageSnapshot } from './page-snapshot.mjs';
import { normalizeAnswerPolicy } from './question-policy.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const listFailureFields = ['invalidId','noAnchor','rejectedUrl','missingIds'];
const ownRequire = createRequire(import.meta.url);
export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const managedMessages = {
    ready: new Set(['作业执行器已就绪', '课程执行器已就绪']),
    running: new Set(['正在执行当前作业或章节任务', '章节测验提交已确认']),
    stopped: new Set(['当前执行器已停止，未完成的模型请求已取消', '自动任务已停止']),
    submitted: new Set(['已观察到当前作业提交完成，等待作业列表复核']),
    verify: new Set(['已离开当前小节，等待目录核实完成状态', '当前学习步骤结束，等待目录核实任务点是否完成']),
};
const managedFallback = { ready: '执行器已就绪', running: '任务正在执行', stopped: '任务已停止',
    submitted: '已观察到提交状态，等待列表复核', verify: '等待列表复核完成状态' };

// Page state can contain upstream errors. Log only fixed labels and narrowly validated counters.
export function safeManagedProgress(managed) {
    if (!managed || typeof managed !== 'object' || typeof managed.phase !== 'string') return null;
    const phase = managed.phase;
    if (phase === 'blocked') {
        const message = typeof managed.message === 'string' ? managed.message.slice(0, 2000) : '';
        const categories = [
            [/登录|鉴权|Authentication required/i, '登录或鉴权未通过'],
            [/本地服务|连接失败|fetch failed/i, '本地服务连接异常'],
            [/模型|CodeBuddy CLI|DeepSeek|答案数量|返回.*JSON/i, '模型响应未通过检查'],
            [/识别|题目.*变化|题型|选项不存在/i, '题目识别或一致性检查未通过'],
            [/填写|勾选|校验/i, '填写结果校验未通过'],
            [/提交|确认框/i, '提交状态需核实'],
            [/视频|播放/i, '视频播放未完成'],
            [/下一节|步骤|章节|任务点|目录/i, '学习步骤需核实'],
        ];
        return `[blocked] ${categories.find(([pattern]) => pattern.test(message))?.[1] || '任务执行受阻，需核实'}`;
    }
    if (!Object.hasOwn(managedMessages, phase)) return null;
    const message = typeof managed.message === 'string' ? managed.message : '';
    let accepted = managedMessages[phase].has(message) ? message : '';
    if (phase === 'running' && !accepted) {
        if (/^(?:模型开始|填写后校验通过)：(?:[1-9]|[12]\d|30) 题$/.test(message) ||
            /^步骤切换成功：视频 \d{1,6}-\d{1,6} → 视频 \d{1,6}-\d{1,6}$/.test(message) ||
            /^步骤切换成功：(视频|章节测验|未知) \d{1,6} → (视频|章节测验|未知) \d{1,6}$/.test(message)) accepted = message;
    }
    return `[${phase}] ${accepted || managedFallback[phase]}`;
}

async function settleWithin(promises, timeoutMs) {
    if (!promises.length) return;
    let timer;
    try {
        await Promise.race([Promise.allSettled(promises), new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); })]);
    } finally { clearTimeout(timer); }
}

export function isPlatformUrl(value) {
    try { const url = new URL(value); return url.protocol === 'https:' && /(^|\.)chaoxing\.com$/i.test(url.hostname); }
    catch { return false; }
}
export async function loadBrowserEngine() {
    const candidates = [process.env.XUEXITONG_PLAYWRIGHT_PATH,
        join(process.env.USERPROFILE || '', '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core/index.mjs')];
    try { candidates.unshift(ownRequire.resolve('playwright-core')); } catch {}
    for (const candidate of candidates.filter(Boolean)) {
        if (existsSync(candidate)) {
            const loaded = await import(pathToFileURL(resolve(candidate)).href);
            const engine = loaded.chromium ? loaded : loaded.default;
            if (engine?.chromium?.launch) return engine;
        }
    }
    throw new Error('缺少 playwright-core。请在 automation 目录运行 npm install，或设置 XUEXITONG_PLAYWRIGHT_PATH');
}

export class BrowserDriver {
    constructor(context, { stopped = () => false, log = () => {}, onAuthenticated = async () => {}, timeoutMs = 4 * 60 * 60 * 1000, answerPolicy = null } = {}) {
        this.context = context; this.stopped = stopped; this.log = log; this.timeoutMs = timeoutMs;
        this.onAuthenticated = onAuthenticated; this.authenticated = false;
        this.worker = null; this.navigation = null; this.catalog = null;
        this.taskPages = new Map();
        this.answerPolicy = normalizeAnswerPolicy(answerPolicy);
    }
    checkStop() { if (this.stopped()) throw new Error('任务已停止'); }
    async snapshots(page) {
        const rows = [];
        for (const frame of page.frames()) {
            if (!isPlatformUrl(frame.url())) continue;
            try { rows.push({ frame, data: await frame.evaluate(pageSnapshot) }); } catch { /* Frame may be navigating. */ }
        }
        return rows;
    }
    async waitKind(page, kinds, timeoutMs = 20000) {
        const deadline = Date.now() + timeoutMs;
        do {
            this.checkStop();
            const rows = await this.snapshots(page);
            if (rows.some((row) => row.data.kind === 'login')) throw new Error('登录已失效，请在自动任务浏览器中重新登录');
            const hit = rows.find((row) => kinds.includes(row.data.kind) &&
                (row.data.kind !== 'course-home' || ['章节','作业'].every((label) => row.data.menus.includes(label))));
            if (hit) return hit;
            await sleep(400);
        } while (Date.now() < deadline);
        throw new Error(`等待页面超时：${kinds.join(' / ')}`);
    }
    async navigate(page, href) {
        this.checkStop();
        if (!isPlatformUrl(href)) throw new Error('拒绝打开学习通域以外的任务地址');
        await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 30000 });
    }
    async clickMenu(page, label) {
        for (const { frame, data } of await this.snapshots(page)) {
            if (!data.menus.includes(label)) continue;
            const locator = frame.locator(`[title="${label}"],[name="${label}"]`);
            if (await locator.count()) { await locator.first().click(); return; }
            const fallback = frame.getByText(label, { exact: true });
            if (await fallback.count() === 1) { await fallback.click(); return; }
        }
        throw new Error(`未找到${label}入口，未猜测接口地址`);
    }
    async courses({ loginMs = 120000 } = {}) {
        this.catalog ||= await this.context.newPage();
        await this.navigate(this.catalog, 'https://i.chaoxing.com/base');
        const deadline = Date.now() + loginMs;
        let announced = false, waitingList = false, listError = null;
        do {
            this.checkStop();
            const rows = await this.snapshots(this.catalog);
            const courses = rows.find((row) => row.data.kind === 'courses');
            if (!this.authenticated && (courses || rows.some((row) => row.data.menus.includes('课程')))) {
                await this.onAuthenticated(); this.authenticated = true;
            }
            try {
                if (courses) return await this.collectPages(this.catalog, courses);
                if (rows.some((row) => row.data.menus.includes('课程'))) {
                    await this.clickMenu(this.catalog, '课程');
                    return await this.collectPages(this.catalog, await this.waitKind(this.catalog, ['courses']));
                }
            } catch (error) {
                if (error.code !== 'LIST_NOT_READY') throw error;
                listError = error;
                if (!waitingList) {
                    this.log('已到达课程列表，正在等待课程卡片加载；本窗口会继续保留到登录等待时间结束。');
                    this.log(JSON.stringify({ event: 'course-list-diagnostic', frames: (await this.snapshots(this.catalog)).map(({ data }) =>
                        ({ kind: data.kind, path: data.path, items: data.items.length, menus: data.menus, diagnostics: data.diagnostics })) }));
                    waitingList = true;
                }
            }
            if (!courses && !waitingList && !announced) { this.log('等待登录：请在自动打开的学习通窗口中完成扫码。登录成功后自动继续。'); announced = true; }
            await sleep(1000);
        } while (Date.now() < deadline);
        if (listError) throw new Error(`课程列表读取超时：${listError.message}`);
        throw new Error('等待登录超时；没有执行任何作业。下次会复用这个浏览器的登录状态');
    }
    async collectPages(page, first) {
        const rows = [];
        for await (const current of this.listPages(page, first)) rows.push(...current.data.items);
        return rows;
    }
    async *listPages(page, first) {
        const seen = new Set();
        let current = first;
        for (let n = 0; n < 50; n++) {
            // Containers can appear before asynchronous list items. Wait for a stable DOM snapshot.
            let stable = 0, last = '', stableDeadline = Date.now() + 15000;
            while (stable < 2 && Date.now() < stableDeadline) {
                this.checkStop(); await sleep(350);
                current = await this.waitKind(page, [first.data.kind]);
                const failures = listFailureFields.map((key) => Number(current.data.diagnostics?.[key]) || 0);
                const now = `${current.data.items.map((item) => `${item.key}:${item.status}`).join('|')}#${failures.join(',')}`;
                stable = (current.data.items.length || current.data.empty || failures.some((count) => count > 0)) && now === last ? stable + 1 : 0; last = now;
            }
            if (stable < 2) {
                const error = new Error(`列表尚未加载完整，且没有明确的空列表提示，未确认扫描成功（${current.data.kind}，${current.data.path}）`);
                error.code = 'LIST_NOT_READY';
                throw error;
            }
            const diagnostics = current.data.diagnostics || {};
            const failures = listFailureFields
                .filter((key) => Number(diagnostics[key]) > 0)
                .map((key) => `${key}=${diagnostics[key]}`);
            if (failures.length) {
                const error = new Error(`列表读取不完整：${failures.join('，')}；已停止扫描，未启动执行（${current.data.kind}，${current.data.path}）`);
                error.code = 'LIST_INCOMPLETE';
                throw error;
            }
            const signature = current.data.items.map((item) => `${item.key}:${item.status}`).join('|');
            if (seen.has(signature)) throw new Error('分页没有变化，已停止扫描，避免漏项');
            seen.add(signature);
            yield current;
            if (!current.data.next) return;
            const label = current.data.next.label;
            const button = current.frame.getByRole('link', { name: label, exact: true }).or(current.frame.getByRole('button', { name: label, exact: true }));
            if (await button.count() !== 1) throw new Error('分页按钮不唯一，已停止扫描');
            await button.click();
            const deadline = Date.now() + 15000;
            do {
                this.checkStop(); await sleep(300);
                current = await this.waitKind(page, [first.data.kind]);
                if (current.data.items.map((item) => `${item.key}:${item.status}`).join('|') !== signature) break;
            } while (Date.now() < deadline);
        }
        throw new Error('超过 50 页扫描上限，未启动执行');
    }
    async courseList(course, type) {
        this.navigation ||= await this.context.newPage();
        await this.navigate(this.navigation, course.href);
        await this.waitKind(this.navigation, ['course-home']);
        await this.clickMenu(this.navigation, type === 'work' ? '作业' : '章节');
        const found = await this.waitKind(this.navigation, [type === 'work' ? 'work-list' : 'chapters']);
        return this.collectPages(this.navigation, found);
    }
    async discover({ filter = '', courseKeys = [], loginMs } = {}) {
        if (!Array.isArray(courseKeys) || courseKeys.some(key => typeof key !== 'string' || !/^course:\d+:\d+$/.test(key)) ||
            new Set(courseKeys).size !== courseKeys.length) throw new Error('课程编号白名单格式不正确或包含重复项');
        const allowed = new Set(courseKeys);
        const courses = (await this.courses({ loginMs })).filter((course) => course.status === 'available' &&
            (!filter || course.title.includes(filter)) && (!allowed.size || allowed.has(course.key)));
        for (const key of allowed) if (!courses.some(course => course.key === key))
            throw new Error('指定课程不在当前可进入的课程范围内，未扫描或执行任何任务');
        if (!courses.length) throw new Error('没有找到匹配的可进入课程');
        const items = [], issues = [];
        for (const course of courses) {
            this.log(`扫描课程：${course.title}`);
            for (const type of ['work', 'chapter']) {
                this.checkStop();
                try {
                    for (const item of await this.courseList(course, type)) items.push({ ...item,
                        key: `${course.key}:${item.key}`, course, courseTitle: course.title });
                } catch (error) {
                    if (this.stopped()) throw error;
                    issues.push({ courseTitle: course.title, type, reason: error.message });
                }
            }
        }
        return { items, issues, courseCount: courses.length };
    }
    trackTaskPage(page) {
        if (this.taskPages.has(page)) return page;
        const listener = (popup) => this.trackTaskPage(popup);
        this.taskPages.set(page, listener);
        page.on('popup', listener);
        return page;
    }
    async followTaskEntry(page, click, kinds) {
        // Only a popup opened by this task is eligible; never adopt an unrelated new tab.
        let popup = null;
        const onPopup = (opened) => { popup = this.trackTaskPage(opened); };
        page.on('popup', onPopup);
        try {
            await click();
            const deadline = Date.now() + 20000;
            do {
                this.checkStop();
                const candidate = popup || page;
                if (candidate.isClosed()) throw new Error('任务入口打开后窗口已关闭');
                const url = candidate.url();
                if (url !== 'about:blank' && !isPlatformUrl(url))
                    throw new Error('任务入口跳到了学习通域以外，已停止');
                const rows = await this.snapshots(candidate);
                if (rows.some((row) => kinds.includes(row.data.kind))) {
                    this.worker = candidate;
                    return;
                }
                await sleep(250);
            } while (Date.now() < deadline);
            throw new Error('作答或章节入口没有打开支持的任务页面');
        } finally { page.off('popup', onPopup); }
    }
    async openItem(item) {
        this.worker = this.trackTaskPage(await this.context.newPage());
        if (item.kind === 'work') {
            await this.navigate(this.worker, item.href);
            const entry = await this.waitKind(this.worker, ['work-entry','work','work-result','work-preview']);
            if (entry.data.kind === 'work-preview') return { status: 'blocked', readonlySkip: true,
                reason: '平台仅打开作业预览页，没有确认可作答入口，未填写或提交' };
            if (entry.data.confirmed) return { status: 'verify' };
            if (entry.data.unavailable) return { status: 'blocked', reason: '作业已截止或尚未开始' };
            if (entry.data.kind === 'work-entry') {
                if (!entry.data.entry) return { status: 'blocked', reason: '未找到可作答入口，未点击重做或互评' };
                const start = entry.frame.getByRole('button', { name: entry.data.entry, exact: true })
                    .or(entry.frame.getByRole('link', { name: entry.data.entry, exact: true }));
                if (await start.count() !== 1) return { status: 'blocked', reason: '作答入口不唯一' };
                await this.followTaskEntry(this.worker, () => start.click(), ['work','work-result']);
            }
            return null;
        }
        await this.navigate(this.worker, item.course.href);
        await this.waitKind(this.worker, ['course-home']);
        await this.clickMenu(this.worker, '章节');
        const found = await this.waitKind(this.worker, ['chapters']);
        for await (const current of this.listPages(this.worker, found)) {
            const matches = current.data.items.filter((row) => row.id === item.id);
            if (!matches.length) continue;
            if (matches.length !== 1) return { status: 'blocked', reason: '章节编号不唯一，未点击任何任务' };
            const live = matches[0];
            if (live.status !== 'pending') return { status: live.status === 'complete' ? 'verify' : 'blocked', reason: '任务没有明确待完成状态' };
            this.checkStop();
            await this.followTaskEntry(this.worker, () => current.frame.locator(live.selector).click(), ['player']);
            return null;
        }
        return { status: 'blocked', reason: '遍历章节分页后仍未找到任务入口，未点击任何任务' };
    }
    async selectQuestionStep(item) {
        if (!this.answerPolicy?.questionsOnly || item.kind !== 'chapter') return null;
        const page = this.worker;
        const deadline = Date.now() + 15000;
        let noQuizStable = 0;
        let clickedQuiz = false;
        do {
            this.checkStop();
            // The platform's current step label must confirm the target. Never use a guessed URL.
            const snapshot = await page.evaluate(() => {
                const visible = el => el.getClientRects().length > 0;
                const clean = value => String(value || '').replace(/\s+/g, '');
                const title = [...document.querySelectorAll('.prev_title')].find(visible);
                const current = title && clean(title.getAttribute('title') || title.textContent);
                const labels = [...document.querySelectorAll('#prev_tab .prev_white,#prev_tab .prev_blue,.prev_ul .prev_white,.prev_ul .prev_blue')].filter(visible);
                const allTabs = labels.length ? labels : [...document.querySelectorAll('.prev_white,.prev_blue')].filter(visible);
                const isQuiz = value => /^\d*[.、]?(章节)?测验$/.test(clean(value));
                const card = [...document.querySelectorAll('iframe[src*="/knowledge/cards"]')].find(visible);
                let currentLabel = null;
                if (card) {
                    const index = new URL(card.getAttribute('src'), location.href).searchParams.get('num');
                    if (index !== null && /^\d+$/.test(index)) currentLabel = allTabs[Number(index)]?.textContent;
                }
                if (currentLabel == null) currentLabel = allTabs.find(el => el.classList.contains('prev_blue'))?.textContent;
                const tabs = allTabs.filter(el => isQuiz(el.textContent));
                return { currentQuiz: isQuiz(currentLabel || current), tabCount: tabs.length, labelled: allTabs.length > 0 };
            });
            if (snapshot.tabCount > 1) return { status: 'blocked', reason: '章节测验页签不唯一，只做题模式未猜测入口' };
            if (snapshot.currentQuiz) return null;
            if (clickedQuiz) { await sleep(300); continue; }
            if (snapshot.tabCount === 1) {
                const tab = page.locator('.prev_white:visible,.prev_blue:visible').filter({ hasText: /^\s*\d*\s*[.、]?\s*(章节)?测验\s*$/ });
                if (await tab.count() !== 1) return { status: 'blocked', reason: '章节测验页签发生变化，未启动作答' };
                await tab.click();
                clickedQuiz = true;
                // Re-observe the platform's selected card/label on the next iteration.
                await sleep(400);
                continue;
            }
            noQuizStable = snapshot.labelled ? noQuizStable + 1 : 0;
            if (noQuizStable >= 4) break;
            await sleep(300);
        } while (Date.now() < deadline);
        return { status: 'blocked', readonlySkip: true,
            reason: '本章没有可识别的章节测验入口，只做题模式跳过视频及其他任务点' };
    }
    async execute(item) {
        this.log(`执行：${item.courseTitle} / ${item.title}`);
        let answerPage, answerListener;
        const usageReads = new Set();
        try {
            const result = await this.openItem(item);
            if (result) return result;
            const scopeResult = await this.selectQuestionStep(item);
            if (scopeResult) return scopeResult;
            answerPage = this.worker;
            answerListener = (response) => {
                let url;
                try { url = new URL(response.url()); } catch { return; }
                if (url.origin !== 'http://127.0.0.1:37841' || url.pathname !== '/answer' || response.request().method() !== 'POST') return;
                const reading = (async () => {
                    if (!response.ok()) { this.log(`模型请求返回 HTTP ${response.status()}，未据此认定作答成功`); return; }
                    const value = await response.json();
                    const meta = value?.meta;
                    const model = typeof meta?.model === 'string' && /^[a-z0-9._-]{1,100}$/i.test(meta.model) ? meta.model : '未记录';
                    const credit = typeof meta?.credit === 'number' && Number.isFinite(meta.credit) && meta.credit >= 0 ? meta.credit : '未观测到';
                    this.log(`模型请求已返回：model=${model}，credit=${credit}`);
                })().catch(() => this.log('模型返回的用量信息未读取到，未推断免费'));
                usageReads.add(reading);
                reading.finally(() => usageReads.delete(reading));
            };
            answerPage.on('response', answerListener);
            const deadline = Date.now() + this.timeoutMs;
            let started = false, injectionAt = 0, lastManagedEvent = '', lastProgressAt = 0;
            while (Date.now() < deadline) {
                this.checkStop();
                const page = this.worker;
                if (!page || page.isClosed()) throw new Error('执行窗口已关闭，需检查提交结果');
                const rows = await this.snapshots(page);
                if (rows.some((row) => row.data.kind === 'login')) throw new Error('登录失效，已停止当前任务');
                if (rows.some((row) => row.data.kind === 'work-result' && row.data.confirmed)) return { status: 'verify' };
                const main = rows.find((row) => ['player','work'].includes(row.data.kind));
                if (!main) { await sleep(500); continue; }
                if (main.frame !== page.mainFrame()) throw new Error('执行器需要独立的学习页面，不能在未知嵌套框架里提交');
                const parameters = new Map([...new URL(page.url()).searchParams].map(([key, value]) => [key.toLowerCase(), value]));
                if (item.kind === 'chapter') {
                    const chapterId = parameters.get('chapterid') || parameters.get('knowledgeid');
                    if (!chapterId) throw new Error('当前章节地址没有可核实的章节编号，已停止避免越界执行');
                    if (chapterId !== item.id) return { status: 'verify' };
                } else if (parameters.get('workid') !== item.id) {
                    throw new Error('当前作业编号与队列不一致，未调用模型或提交');
                }
                const state = await page.evaluate(() => ({ ready: !!window.__xuexitongConsoleDeepSeek,
                    managed: window.__xuexitongManagedState || null, injected: window.__xuexitongManagedInjected === true }));
                if (state.managed) {
                    const event = safeManagedProgress(state.managed);
                    if (event !== lastManagedEvent) {
                        lastManagedEvent = event;
                        if (event) this.log(`任务进度：${event}`);
                    }
                }
                if (started && item.kind === 'chapter' && Date.now() - lastProgressAt >= 30000) {
                    lastProgressAt = Date.now();
                    const progress = await page.evaluate(() => {
                        const video = window.app?._getVideoEl?.();
                        if (!video) return null;
                        return { current: Number(video.currentTime), duration: Number(video.duration),
                            paused: video.paused, rate: Number(video.playbackRate) };
                    }).catch(() => null);
                    if (progress && Number.isFinite(progress.current)) {
                        this.log(`视频进度：${Math.floor(progress.current)} / ${Number.isFinite(progress.duration) ? Math.floor(progress.duration) : '?'} 秒，${progress.paused ? '暂停' : '播放中'}，速度 ${progress.rate}`);
                    }
                }
                if (!state.injected) {
                    await page.evaluate(({ key, policy }) => { window.__xuexitongManaged = true; window.__xuexitongManagedInjected = true;
                        window.__xuexitongManagedKey = key; window.__xuexitongAutoInjected = true;
                        if (policy) window.__xuexitongAnswerPolicy = Object.freeze(policy); }, { key: item.key, policy: this.answerPolicy });
                    await page.evaluate(readFileSync(join(ROOT, 'deepseek-console/xuexitong-console.js'), 'utf8'));
                    started = false; injectionAt = Date.now();
                } else if (state.managed?.phase === 'blocked') return { status: 'blocked', reason: state.managed.message };
                else if (['submitted','verify'].includes(state.managed?.phase)) return { status: 'verify' };
                else if (state.ready && !started) {
                    started = true;
                    await page.evaluate(() => { Promise.resolve(window.app.startAuto()).catch((error) => {
                        window.__xuexitongManagedState = { phase: 'blocked', message: error.message }; }); });
                }
                else if (!state.ready && injectionAt && Date.now() - injectionAt > 30000)
                    throw new Error('页面执行器超过 30 秒未就绪，未填写或提交');
                await sleep(1000);
            }
            throw new Error('单项任务超过执行时限，需检查平台状态，未自动重试');
        } finally {
            if (answerPage && answerListener) answerPage.off('response', answerListener);
            // Close only pages that belong to this task, including its popup descendants.
            // Stop all pages before awaiting metadata: a pending response must not postpone cancellation.
            const pages = [...this.taskPages];
            for (const [page, listener] of pages) {
                try { page.off('popup', listener); } catch {}
            }
            await settleWithin(pages.map(([page]) => Promise.resolve().then(() => page.evaluate(() => window.app?.stopAuto?.()))), 500);
            if (!this.stopped()) await settleWithin([...usageReads], 2000);
            await Promise.allSettled(pages.map(async ([page]) => { await page.close(); }));
            this.taskPages.clear();
        }
    }
    async verify(item) {
        const rows = await this.courseList(item.course, item.kind);
        const found = rows.find((row) => row.id === item.id);
        return { complete: found?.status === 'complete', reason: found ? `平台状态仍为：${found.reason || found.status}` : '重新扫描未找到该项，不能认定已完成' };
    }
}
