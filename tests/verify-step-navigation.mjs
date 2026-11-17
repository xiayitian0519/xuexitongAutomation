// Synthetic frame/document fixtures only. No browser, platform, media or model requests.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const { JSDOM, VirtualConsole } = await import('jsdom').catch(() =>
    import(new URL('../node_modules/jsdom/lib/api.js', import.meta.url)));
const source = readFileSync(new URL('../deepseek-console/xuexitong-console.js', import.meta.url), 'utf8')
    .replace(/const LOCAL_TOKEN = '[^']*';/, "const LOCAL_TOKEN = 'local-test';");
const jquery = readFileSync(new URL('../node_modules/jquery/dist/jquery.js', import.meta.url), 'utf8');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, ms = 8000) {
    const deadline = Date.now() + ms;
    while (!check() && Date.now() < deadline) await wait(2);
    assert.ok(check(), label);
}
function patch(w) {
    Object.defineProperty(w.HTMLElement.prototype, 'innerText', { configurable: true, get() { return this.textContent; } });
    w.Element.prototype.getClientRects = function () { return this.style?.display === 'none' ? [] : [{ width: 100, height: 20 }]; };
    w.Element.prototype.scrollIntoView = () => {};
}
async function setup({ labels = ['教学视频', '教学视频'], parameter = 'chapterId', nestedVideos = 1 } = {}) {
    const vc = new VirtualConsole(), logs = [], children = [];
    for (const level of ['log', 'warn', 'error']) vc.on(level, (...args) => logs.push(args.map(String).join(' ')));
    const dom = new JSDOM(`<body><div id="coursetree"><div id="cur100" class="posCatalog_active"></div></div>
        <div class="prev_title" title="章节名称">章节名称</div><div id="prev_tab">${labels.map((label, i) => `<div class="prev_white">${i + 1}${label}</div>`).join('')}</div>
        <iframe id="iframe" src="https://mooc1.chaoxing.com/knowledge/cards?knowledgeid=100&num=0"></iframe>
        <button id="prevNextFocusNext">下一节</button></body>`, {
        url: `https://mooc1.chaoxing.com/mycourse/studentstudy?${parameter}=100`,
        runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc,
    });
    const w = dom.window; patch(w);
    w.__xuexitongManaged = true;
    w.AbortSignal.timeout = () => new w.AbortController().signal;
    w.fetch = async url => { assert.ok(url.endsWith('/health'), 'no paid request permitted'); return { ok: true }; };
    const nativeTimeout = w.setTimeout.bind(w), nativeInterval = w.setInterval.bind(w);
    w.setTimeout = (fn, ms, ...args) => nativeTimeout(fn, Math.min(ms, 2), ...args);
    w.setInterval = (fn, ms, ...args) => nativeInterval(fn, Math.min(ms, 2), ...args);
    const events = { next: 0, resumes: 0, plays: [], lastVideo: null };
    let loaded, currentFrame = w.document.querySelector('#iframe');
    const linkFrame = frame => Object.defineProperty(frame, 'contentDocument', { configurable: true, get() { return loaded.document; } });
    linkFrame(currentFrame);
    function media(doc, id) {
        const video = doc.createElement('video'); video.id = id; video.src = `https://media.invalid/${id}.mp4`;
        let ended = false, ready = 1;
        Object.defineProperties(video, { ended: { configurable: true, get: () => ended }, readyState: { configurable: true, get: () => ready },
            networkState: { configurable: true, get: () => 1 }, paused: { configurable: true, get: () => false } });
        video.play = async () => { events.plays.push(id); };
        video.pause = () => {};
        doc.body.append(video);
        return { video, end: () => { ended = true; }, ready: value => { ready = value; } };
    }
    function card(index = 0, { count = 1, nested = false, quiz = false } = {}) {
        const child = new JSDOM('<body></body>', { url: `https://mooc1.chaoxing.com/knowledge/cards?knowledgeid=100&num=${index}`,
            pretendToBeVisual: true, runScripts: 'outside-only' });
        children.push(child); patch(child.window); child.window.document.title = quiz ? '章节测验' : '教学视频';
        const videos = [];
        if (quiz) child.window.document.body.innerHTML = '<section>【单选题】测试<label><span>A</span><input type="radio"><span>甲</span></label><label><span>B</span><input type="radio"><span>乙</span></label></section><button>提交</button>';
        else for (let i = 0; i < count; i++) {
            let doc = child.window.document;
            if (nested) {
                const frame = doc.createElement('iframe'); frame.className = 'ans-insertvideo-online'; frame.src = `https://mooc1.chaoxing.com/ananas/modules/video/index.html?fixture=${i}`; doc.body.append(frame);
                const player = new JSDOM('<body></body>', { url: frame.src, pretendToBeVisual: true, runScripts: 'outside-only' });
                children.push(player); patch(player.window); doc = player.window.document;
                Object.defineProperty(frame, 'contentDocument', { configurable: true, get: () => doc });
            }
            videos.push(media(doc, `video-${children.length}-${index}-${i}`));
        }
        return { document: child.window.document, videos };
    }
    loaded = card(0, { count: nestedVideos, nested: nestedVideos > 1 });
    w.document.querySelector('#prevNextFocusNext').onclick = () => { events.next++; };
    w.eval(jquery); w.eval(source);
    await until(() => w.app, 'initialize player');
    const app = w.app;
    app._clearCheckInterval(); app.setMode('auto'); events.plays.length = 0;
    const originalPlay = app.play;
    app.play = () => { events.resumes++; events.lastVideo = app._getVideoEl(); };
    return { dom, w, app, events, logs, media, card, get loaded() { return loaded; },
        setLoaded(value) { loaded = value; },
        setIndex(index) { currentFrame.src = `https://mooc1.chaoxing.com/knowledge/cards?knowledgeid=100&num=${index}`; },
        replaceFrame(value) { const next = currentFrame.cloneNode(); currentFrame.replaceWith(next); currentFrame = next; loaded = value; linkFrame(next); },
        restorePlay() { app.play = originalPlay; },
        close() { dom.window.close(); for (const child of children) child.window.close(); },
    };
}

{
    const f = await setup();
    try {
        f.loaded.videos[0].end();
        f.w.document.querySelector('#prevNextFocusNext').onclick = () => { f.events.next++; f.setIndex(1); };
        f.app.nextUnit();
        await wait(15);
        assert.equal(f.events.resumes, 0, 'changed iframe src with old document is not ready');
        f.setLoaded(f.card(1));
        await until(() => f.events.resumes === 1, 'same-label video-to-video resumes');
        assert.equal(f.events.next, 1);
        assert.match(f.w.__xuexitongManagedState.message, /视频 0 → 视频 1/);
        console.log('PASS same-label video-to-video: card index changed; stale old document never resumes');
    } finally { f.close(); }
}
{
    const f = await setup();
    try {
        const old = f.loaded.videos[0].video; f.loaded.videos[0].end();
        f.w.document.querySelector('#prevNextFocusNext').onclick = () => { f.events.next++; f.replaceFrame(f.card(0)); };
        f.app.nextUnit();
        await until(() => f.events.resumes === 1, 'same-address iframe replacement resumes');
        assert.notEqual(f.events.lastVideo, old);
        console.log('PASS replaced card iframe/document with identical address and label');
    } finally { f.close(); }
}
{
    const f = await setup({ labels: ['教学视频', '章节测验'] });
    try {
        f.loaded.videos[0].end();
        f.w.document.querySelector('#prevNextFocusNext').onclick = () => { f.events.next++; f.setIndex(1); f.setLoaded(f.card(1, { quiz: true })); };
        f.app.nextUnit();
        await until(() => f.events.resumes === 1, 'real quiz DOM is ready');
        assert.equal(f.app._currentStepTitle(), '章节测验');
        console.log('PASS video-to-quiz uses recognized question content and card identity');
    } finally { f.close(); }
}
for (const type of ['title-only', 'unknown-tab', 'source-mismatch']) {
    const f = await setup({ labels: ['教学视频', type === 'unknown-tab' ? '课件' : '教学视频'] });
    try {
        f.loaded.videos[0].end();
        f.w.document.querySelector('#prevNextFocusNext').onclick = () => {
            f.events.next++;
            f.w.document.querySelector('.prev_title').title = '视频';
            if (type !== 'title-only') f.setIndex(1);
            if (type === 'unknown-tab') f.setLoaded(f.card(1));
        };
        f.app.nextUnit();
        await until(() => f.w.__xuexitongManagedState.phase === 'blocked', `${type} blocks`);
        assert.equal(f.events.resumes, 0);
        assert.equal(f.events.next, 1);
        console.log(`PASS no false success: ${type}`);
    } finally { f.close(); }
}
for (const parameter of ['chapterid', 'knowledgeId']) {
    const f = await setup({ parameter });
    try {
        f.loaded.videos[0].end();
        f.w.document.querySelector('#prevNextFocusNext').onclick = () => {
            f.events.next++;
            f.w.history.replaceState({}, '', `?${parameter}=200`);
        };
        f.app.nextUnit();
        await until(() => f.w.__xuexitongManagedState.phase === 'verify', 'cross-chapter reports verify');
        assert.equal(f.events.resumes, 0);
        f.restorePlay(); await f.app.play();
        assert.equal(f.events.plays.length, 0, 'later play callback remains stopped at chapter boundary');
        console.log(`PASS managed boundary: ${parameter} changed, verify only, no playback in next chapter`);
    } finally { f.close(); }
}
{
    const f = await setup({ nestedVideos: 2, labels: ['教学视频'] });
    try {
        const [first, second] = f.loaded.videos;
        first.end(); second.ready(0);
        f.app.nextUnit();
        await until(() => f.events.resumes === 1, 'next nested video with configured source activates normally');
        assert.equal(f.events.next, 0, 'do not click PCount.next while an uncompleted sibling video remains');
        assert.equal(f.events.lastVideo, second.video);
        for (let i = 0; i < 4; i++) assert.equal(f.app._getVideoEl(), second.video, 'progress inspection never picks first video again');
        second.end();
        f.w.document.querySelector('#prevNextFocusNext').onclick = () => { f.events.next++; f.w.history.replaceState({}, '', '?chapterId=200'); };
        f.app.nextUnit();
        await until(() => f.w.__xuexitongManagedState.phase === 'verify', 'after both natural ends proceed to directory verification');
        assert.equal(f.events.next, 1);
        console.log('PASS two video iframes in one card: natural end, next configured source at readyState 0, stable identity, then verify');
    } finally { f.close(); }
}
{
    const f = await setup({ nestedVideos: 2, labels: ['教学视频'] });
    try {
        f.app.nextUnit();
        await until(() => f.w.__xuexitongManagedState.phase === 'blocked', 'no advance before natural end');
        assert.equal(f.events.next, 0); assert.equal(f.events.resumes, 0);
        console.log('PASS same-card video cannot be skipped before its natural end');
    } finally { f.close(); }
}
{
    const f = await setup();
    try {
        f.loaded.videos[0].end();
        f.w.document.querySelector('#prevNextFocusNext').onclick = () => { f.events.next++; f.setIndex(1); };
        f.app.nextUnit(); await wait(8); f.app.stopAuto();
        f.setLoaded(f.card(1)); await wait(20);
        assert.equal(f.events.resumes, 0); assert.equal(f.w.__xuexitongManagedState.phase, 'stopped');
        console.log('PASS stop while new card is loading: no late playback or blocked-state overwrite');
    } finally { f.close(); }
}
console.log('All step-navigation fixtures passed. No real model, media or platform requests.');
