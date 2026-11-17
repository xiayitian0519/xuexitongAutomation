// Real headless Edge against fully intercepted, offline fixtures only.
// Never executes run.main(), reads the production console, or opens private browser state.
import assert from 'node:assert/strict';
import { BrowserDriver, loadBrowserEngine } from '../automation/browser-driver.mjs';
import { parseArgs } from '../automation/run.mjs';
import { installQuestionOnlyGuards } from '../automation/question-policy.mjs';

const policy = Object.freeze({ questionsOnly: true, skipWorkedSolutions: true });
const origin = 'https://fixture.chaoxing.com';
const item = Object.freeze({ key: 'course:100:200:chapter:300', id: '300', kind: 'chapter',
    title: '离线模拟章节', courseTitle: '离线模拟课程', status: 'pending' });
const failures = [];
let passed = 0;
let browser;
let stage = 'initialise';
let fulfilledRequests = 0;
let abortedUnexpectedRequests = 0;

async function test(label, fn) {
    stage = label;
    try { await fn(); passed++; console.log(`PASS ${label}`); }
    catch { failures.push(label); console.error(`FAIL ${label}`); }
}

function silentWavData() {
    const sampleRate = 8000, samples = 1600;
    const wav = Buffer.alloc(44 + samples * 2);
    wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVE', 8);
    wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(1, 22); wav.writeUInt32LE(sampleRate, 24); wav.writeUInt32LE(sampleRate * 2, 28);
    wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36);
    wav.writeUInt32LE(samples * 2, 40);
    return `data:audio/wav;base64,${wav.toString('base64')}`;
}
const wavData = silentWavData();
const documentHtml = body => `<!doctype html><html><head><meta charset="utf-8"></head><body>${body}</body></html>`;

function guardDocument(frame = false) {
    return documentHtml(`${frame ? '' : '<iframe id="child" src="/guard-frame" width="400" height="150"></iframe>'}
<script>
window.fixtureGuard = {
    policyBeforeFirstScript: window.__xuexitongAnswerPolicy?.questionsOnly === true,
    policyFrozen: Object.isFrozen(window.__xuexitongAnswerPolicy),
    playIsNative: /\\[native code\\]/.test(Function.prototype.toString.call(HTMLMediaElement.prototype.play)),
    playEvents: 0, playingEvents: 0, endedEvents: 0, playResolved: false,
    fetchRejected: false, networkMediaError: false
};
const sample = document.createElement('audio');
sample.src = ${JSON.stringify(wavData)};
for (const [event, key] of [['play','playEvents'], ['playing','playingEvents'], ['ended','endedEvents']])
    sample.addEventListener(event, () => window.fixtureGuard[key]++);
sample.autoplay = true;
window.fixtureGuard.autoplayAfterSet = sample.autoplay;
document.body.append(sample);
window.fixtureAudio = sample;
sample.play().then(() => { window.fixtureGuard.playResolved = true; }, () => {});
fetch('/fetch-clip.mp4').then(() => {}, () => { window.fixtureGuard.fetchRejected = true; });
const streamed = document.createElement('audio');
streamed.preload = 'auto';
streamed.addEventListener('error', () => { window.fixtureGuard.networkMediaError = true; });
streamed.src = '/stream-resource';
document.body.append(streamed);
streamed.load();
</script>`);
}

function chapterDocument({ labels = ['视频', '章节测验'], selected = 0, title = '本章名称',
    cardNum = null, updateSelected = true, updateTitle = false, updateCard = true,
    scopedTabs = true } = {}) {
    const tabs = labels.map((label, index) => `<button type="button" data-index="${index}" class="${index === selected ? 'prev_blue' : 'prev_white'}">${label}</button>`).join('');
    return documentHtml(`<div class="prev_title" title="${title}">${title}</div>
<div ${scopedTabs ? 'id="prev_tab"' : ''} class="fixture-tabs">${tabs}</div>
${cardNum === null ? '' : `<iframe id="cards" src="/knowledge/cards?num=${cardNum}" width="400" height="120"></iframe>`}
<script>
window.fixtureTabClicks = [];
document.querySelectorAll('.fixture-tabs button').forEach(tab => tab.addEventListener('click', () => {
    const index = Number(tab.dataset.index);
    window.fixtureTabClicks.push(index);
    if (${JSON.stringify(updateSelected)}) document.querySelectorAll('.fixture-tabs button').forEach(other => {
        other.className = other === tab ? 'prev_blue' : 'prev_white';
    });
    if (${JSON.stringify(updateTitle)}) {
        const title = document.querySelector('.prev_title'); title.textContent = tab.textContent; title.title = tab.textContent;
    }
    const cards = document.querySelector('#cards');
    if (cards && ${JSON.stringify(updateCard)}) cards.src = '/knowledge/cards?num=' + index;
}));
</script>`);
}

async function withFixture({ answerPolicy = policy, html = documentHtml('离线模拟页面'), extra = new Map() } = {}, fn) {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const tally = { fulfilled: 0, unexpected: 0, failedExtensionFetches: 0, failedTypedMedia: 0,
        fallbackExtensionFetches: 0, fallbackTypedMedia: 0 };
    await context.setOffline(true);
    context.on('requestfailed', req => {
        const address = new URL(req.url());
        if (address.pathname === '/fetch-clip.mp4') tally.failedExtensionFetches++;
        if (address.pathname === '/stream-resource' && req.resourceType() === 'media') tally.failedTypedMedia++;
    });
    // This catch-all is registered first: policy guards must run ahead of it and use fallback
    // only for permitted documents. Offline mode also prevents accidental network escape.
    await context.route('**/*', async route => {
        const req = route.request();
        const address = new URL(req.url());
        if (address.origin !== origin) {
            tally.unexpected++; abortedUnexpectedRequests++; await route.abort('blockedbyclient'); return;
        }
        if (address.pathname === '/fetch-clip.mp4') {
            tally.fallbackExtensionFetches++;
            await route.fulfill({ status: 200, contentType: 'application/octet-stream', body: 'OFFLINE_FIXTURE' }); return;
        }
        if (address.pathname === '/stream-resource') {
            tally.fallbackTypedMedia++;
            await route.fulfill({ status: 200, contentType: 'audio/wav', body: Buffer.from(wavData.split(',')[1], 'base64') }); return;
        }
        if (address.pathname === '/favicon.ico') { await route.fulfill({ status: 204, body: '' }); return; }
        const body = address.pathname === '/fixture' ? html :
            address.pathname === '/knowledge/cards' ? documentHtml('<p>离线卡片</p>') : extra.get(address.pathname);
        if (body === undefined) {
            tally.unexpected++; abortedUnexpectedRequests++; await route.abort('blockedbyclient'); return;
        }
        tally.fulfilled++; fulfilledRequests++;
        await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body });
    });
    await installQuestionOnlyGuards(context, answerPolicy);
    try {
        const page = await context.newPage();
        await page.goto(`${origin}/fixture`, { waitUntil: 'load', timeout: 10000 });
        await fn({ context, page, tally });
        assert.equal(tally.unexpected, 0, 'all fixture traffic must be explicitly handled locally');
    } finally { await context.close(); }
}

function driverFor(context, page, answerPolicy = policy) {
    const deadline = Date.now() + 4000;
    const driver = new BrowserDriver(context, { answerPolicy, stopped: () => Date.now() > deadline, timeoutMs: 1000 });
    driver.worker = page;
    return driver;
}

try {
    await test('questions-only参数仅run接受，普通运行保持默认策略', async () => {
        assert.equal(parseArgs(['--questions-only', '--run']).questionsOnly, true);
        assert.equal(parseArgs(['--run', '--questions-only']).questionsOnly, true);
        for (const mode of ['scan', 'login', 'status', 'stop', 'check', 'help'])
            assert.throws(() => parseArgs([`--${mode}`, '--questions-only']), /仅可与 --run/);
        assert.throws(() => parseArgs(['--questions-only']), /仅可与 --run/);
        assert.throws(() => parseArgs(['--run', '--questions-only', '--questions-only']), /不能重复/);
        assert.equal(parseArgs(['--run']).questionsOnly, undefined);
        assert.equal(new BrowserDriver({}).answerPolicy, null);
        const scoped = parseArgs(['--run', '--questions-only', '--course-key', 'course:100:200', '--course-key', 'course:101:201']);
        assert.deepEqual(scoped.courseKeys, ['course:100:200', 'course:101:201']);
    });

    await test('没有policy时不安装任何初始化脚本或网络保护', async () => {
        const calls = [];
        const untouched = { addInitScript: async () => calls.push('init'), route: async () => calls.push('route') };
        await installQuestionOnlyGuards(untouched, null);
        await installQuestionOnlyGuards(untouched, undefined);
        assert.deepEqual(calls, []);
    });

    await test('未启用policy或任务非章节时不读取页面也不检查停止状态', async () => {
        for (const [answerPolicy, task] of [[null, item], [policy, { ...item, kind: 'work' }]]) {
            const driver = new BrowserDriver({}, { answerPolicy,
                stopped: () => { throw new Error('NO_OP_MUST_NOT_CHECK_STOP'); } });
            driver.worker = new Proxy({}, { get() { throw new Error('NO_OP_MUST_NOT_ACCESS_PAGE'); } });
            assert.equal(await driver.selectQuestionStep(task), null);
        }
    });

    stage = 'launch-headless-edge';
    const engine = await loadBrowserEngine();
    browser = await engine.chromium.launch({ channel: 'msedge', headless: true,
        args: ['--disable-background-networking', '--autoplay-policy=no-user-gesture-required'] });

    await test('导航前保护覆盖主frame与iframe，原生play及ended均不运行', async () => {
        await withFixture({ html: guardDocument(), extra: new Map([['/guard-frame', guardDocument(true)]]) }, async ({ page, tally }) => {
            await page.waitForFunction(() => {
                const complete = state => state?.playResolved && state.fetchRejected && state.networkMediaError;
                return complete(window.fixtureGuard) && complete(document.querySelector('#child')?.contentWindow?.fixtureGuard);
            }, null, { timeout: 5000 });
            await page.waitForTimeout(350); // Longer than the local WAV; a native playback would finish.
            for (const frame of page.frames()) {
                const state = await frame.evaluate(() => ({ ...window.fixtureGuard,
                    paused: window.fixtureAudio.paused, currentTime: window.fixtureAudio.currentTime }));
                assert.equal(state.policyBeforeFirstScript, true);
                assert.equal(state.policyFrozen, true);
                assert.equal(state.playIsNative, false);
                assert.equal(state.autoplayAfterSet, false);
                assert.equal(state.playResolved, true);
                assert.equal(state.playEvents, 0);
                assert.equal(state.playingEvents, 0);
                assert.equal(state.endedEvents, 0);
                assert.equal(state.paused, true);
                assert.equal(state.currentTime, 0);
            }
            assert.equal(tally.failedExtensionFetches, 2, 'extension filter must block fetch, not merely typed media');
            assert.equal(tally.failedTypedMedia, 2, 'resourceType media must block extensionless media');
            assert.equal(tally.fallbackExtensionFetches + tally.fallbackTypedMedia, 0);
        });
    });

    await test('旧运行不带policy时真实Edge原生play与autoplay属性保持原样', async () => {
        const html = documentHtml(`<script>
window.fixtureOriginal = { policyAbsent: window.__xuexitongAnswerPolicy === undefined,
    playIsNative: /\\[native code\\]/.test(Function.prototype.toString.call(HTMLMediaElement.prototype.play)) };
const audio = document.createElement('audio'); audio.autoplay = true;
window.fixtureOriginal.autoplayAfterSet = audio.autoplay;
</script>`);
        await withFixture({ answerPolicy: null, html }, async ({ page }) => {
            assert.deepEqual(await page.evaluate(() => window.fixtureOriginal), {
                policyAbsent: true, playIsNative: true, autoplayAfterSet: true });
        });
    });

    await test('从当前视频页签仅点击一次测验页签', async () => {
        await withFixture({ html: chapterDocument({ title: '视频', updateTitle: true }) }, async ({ context, page }) => {
            assert.equal(await driverFor(context, page).selectQuestionStep(item), null);
            assert.deepEqual(await page.evaluate(() => window.fixtureTabClicks), [1]);
            assert.equal(await page.locator('.prev_title').getAttribute('title'), '章节测验');
        });
    });

    await test('标题为章名时按knowledge/cards的num切换并确认测验', async () => {
        await withFixture({ html: chapterDocument({ labels: ['1.视频', '2.章节测验'], title: '安培环路定理',
            cardNum: 0, selected: -1, updateSelected: false }) }, async ({ context, page }) => {
            assert.equal(await driverFor(context, page).selectQuestionStep(item), null);
            assert.deepEqual(await page.evaluate(() => window.fixtureTabClicks), [1]);
            assert.equal(new URL(await page.locator('#cards').getAttribute('src'), origin).searchParams.get('num'), '1');
            assert.equal(await page.locator('.prev_title').getAttribute('title'), '安培环路定理');
        });
    });

    await test('当前已是测验时不重复点击', async () => {
        await withFixture({ html: chapterDocument({ selected: 1, title: '章节测验' }) }, async ({ context, page }) => {
            assert.equal(await driverFor(context, page).selectQuestionStep(item), null);
            assert.deepEqual(await page.evaluate(() => window.fixtureTabClicks), []);
        });
    });

    await test('标题为章名且num已指向测验时不重复点击', async () => {
        await withFixture({ html: chapterDocument({ labels: ['1、视频', '2、测验'], title: '本章名称',
            cardNum: 1, selected: -1, updateSelected: false }) }, async ({ context, page }) => {
            assert.equal(await driverFor(context, page).selectQuestionStep(item), null);
            assert.deepEqual(await page.evaluate(() => window.fixtureTabClicks), []);
        });
    });

    for (const cardNum of [0, 1]) {
        await test(`没有标准页签容器时用cards num确认（当前${cardNum === 0 ? '视频' : '测验'}）`, async () => {
            await withFixture({ html: chapterDocument({ labels: ['1.视频', '2.章节测验'], title: '本章名称',
                scopedTabs: false, selected: -1, cardNum, updateSelected: false }) }, async ({ context, page }) => {
                assert.equal(await driverFor(context, page).selectQuestionStep(item), null);
                assert.deepEqual(await page.evaluate(() => window.fixtureTabClicks), cardNum === 0 ? [1] : []);
                assert.equal(new URL(await page.locator('#cards').getAttribute('src'), origin).searchParams.get('num'), '1');
            });
        });
    }

    await test('测验页签点击后平台未切换时不重复点击或继续执行', async () => {
        await withFixture({ html: chapterDocument({ title: '视频', selected: 0, updateSelected: false,
            cardNum: 0, updateTitle: false, updateCard: false }) }, async ({ context, page }) => {
            await assert.rejects(driverFor(context, page).selectQuestionStep(item), /任务已停止/);
            assert.deepEqual(await page.evaluate(() => window.fixtureTabClicks), [1]);
            assert.equal(await page.locator('.prev_title').getAttribute('title'), '视频');
            assert.equal(new URL(await page.locator('#cards').getAttribute('src'), origin).searchParams.get('num'), '0');
        });
    });

    for (const selected of [0, 1]) {
        await test(`重复可见测验页签阻断（当前${selected === 0 ? '视频' : '测验'}）`, async () => {
            await withFixture({ html: chapterDocument({ labels: ['视频', '章节测验', '测验'], selected,
                title: selected === 0 ? '视频' : '章节测验' }) }, async ({ context, page }) => {
                const result = await driverFor(context, page).selectQuestionStep(item);
                assert.equal(result?.status, 'blocked');
                assert.match(result.reason, /不唯一|发生变化/);
                assert.deepEqual(await page.evaluate(() => window.fixtureTabClicks), []);
            });
        });
    }

    await test('没有测验的章节跳过，execute不进入注入或模型阶段', async () => {
        await withFixture({ html: chapterDocument({ labels: ['视频', '资料'], title: '视频' }) }, async ({ context, page }) => {
            const driver = driverFor(context, page);
            let postScopeSnapshots = 0, stateBeforeClose;
            driver.openItem = async () => { driver.worker = driver.trackTaskPage(page); return null; };
            // This tripwire runs before the production-source read in execute(). A regression
            // cannot accidentally load that file during an otherwise offline test.
            driver.snapshots = async () => { postScopeSnapshots++; throw new Error('OFFLINE_INJECTION_TRIPWIRE'); };
            const close = page.close.bind(page);
            page.close = async () => {
                stateBeforeClose = await page.evaluate(() => ({ injected: window.__xuexitongManagedInjected === true,
                    hasApp: window.app !== undefined, clicks: window.fixtureTabClicks }));
                await close();
            };
            const result = await driver.execute(item);
            assert.equal(result?.status, 'blocked');
            assert.match(result.reason, /没有可识别的章节测验入口/);
            assert.equal(result.readonlySkip, true);
            assert.equal(postScopeSnapshots, 0);
            assert.deepEqual(stateBeforeClose, { injected: false, hasApp: false, clicks: [] });
            assert.equal(page.isClosed(), true);
            assert.equal(driver.taskPages.size, 0);
        });
    });
} catch {
    failures.push(stage);
    console.error(`FAIL ${stage}`);
} finally {
    await browser?.close().catch(() => { failures.push('close-headless-edge'); });
}
console.log(JSON.stringify({ passed, failed: failures.length, failedGroups: failures,
    realBrowser: 'headless Edge', offline: true, locallyFulfilledDocuments: fulfilledRequests,
    unexpectedRequestsAborted: abortedUnexpectedRequests, realPlatformRequests: 0, realModelRequests: 0,
    productionConsoleRead: false, privateStateRead: false }));
if (failures.length) process.exitCode = 1;
