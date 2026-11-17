// Delayed play-promise fixtures only; no real browser or media is opened.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const { JSDOM, VirtualConsole } = await import('jsdom').catch(() =>
    import(new URL('../node_modules/jsdom/lib/api.js', import.meta.url)));
const source = readFileSync(new URL('../deepseek-console/xuexitong-console.js', import.meta.url), 'utf8')
    .replace(/const LOCAL_TOKEN = '[^']*';/, "const LOCAL_TOKEN = 'local-test';");
const jquery = readFileSync(new URL('../node_modules/jquery/dist/jquery.js', import.meta.url), 'utf8');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function setup() {
    const dom = new JSDOM('<body><div id="coursetree"></div><div class="prev_title" title="章节测验">章节测验</div></body>', {
        url: 'https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=fixture',
        runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: new VirtualConsole(),
    });
    const w = dom.window;
    Object.defineProperty(w.HTMLElement.prototype, 'innerText', { configurable: true, get() { return this.textContent; } });
    w.Element.prototype.getClientRects = () => [{ width: 100, height: 20 }];
    w.AbortSignal.timeout = () => new w.AbortController().signal;
    w.__xuexitongManaged = true;
    w.fetch = async (url) => { assert.ok(url.endsWith('/health')); return { ok: true }; };
    const interval = w.setInterval.bind(w);
    w.setInterval = (fn, ms, ...args) => interval(fn, Math.min(ms, 2), ...args);
    w.eval(jquery);
    w.eval(source);
    for (let i = 0; i < 100 && !w.app; i++) await wait(2);
    assert.ok(w.app);
    const app = w.app;
    const video = w.document.createElement('video');
    const calls = { plays: 0, pauses: 0 };
    video.pause = () => { calls.pauses++; };
    app._isChapterTest = () => false;
    app._getVideoEl = function () { this._videoEl = video; return video; };
    return { dom, app, video, calls };
}

{
    const f = await setup();
    try {
        let rejectFirst;
        f.video.play = () => { f.calls.plays++; return new Promise((_, reject) => { rejectFirst = reject; }); };
        const started = f.app.startAuto();
        f.app.stopAuto();
        rejectFirst(new Error('delayed first play failure'));
        await started;
        await wait(5);
        assert.equal(f.calls.plays, 1);
        assert.equal(f.app._checkInterval, null);
        console.log('PASS stop during first play: delayed rejection never starts fallback');
    } finally { f.dom.window.close(); }
}
{
    const f = await setup();
    try {
        let resolveFallback;
        f.video.play = () => { f.calls.plays++; return new Promise((resolve) => { resolveFallback = resolve; }); };
        f.app._handlePlayError(new Error('simulated autoplay failure'));
        f.app.stopAuto();
        resolveFallback();
        await wait(5);
        assert.equal(f.app._checkInterval, null);
        assert.ok(f.calls.pauses >= 1);
        console.log('PASS stop during fallback: late success pauses media and never restarts monitoring');
    } finally { f.dom.window.close(); }
}
{
    const f = await setup();
    try {
        let rejectResume;
        f.video.play = () => { f.calls.plays++; return new Promise((_, reject) => { rejectResume = reject; }); };
        f.app._isPlaying = true;
        f.app._tryResumePlayback('fixture');
        f.app.stopAuto();
        rejectResume(new Error('delayed resume failure'));
        await wait(5);
        assert.equal(f.calls.plays, 1);
        assert.equal(f.app._checkInterval, null);
        console.log('PASS stop during resume: delayed rejection never starts another play');
    } finally { f.dom.window.close(); }
}
async function setupWork({ ignoreAbort = false } = {}) {
    const dom = new JSDOM(`<body><div>题量：1</div><section>【单选题】测试题
        <label><span>A</span><input type="radio" name="fixture"><span>选项A</span></label>
        <label><span>B</span><input type="radio" name="fixture"><span>选项B</span></label>
        </section><button id="submit">提交</button></body>`, {
        url: 'https://mooc1-api.chaoxing.com/mooc-ans/mooc2/work/dowork?workId=cancel-fixture',
        runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: new VirtualConsole(),
    });
    const w = dom.window;
    Object.defineProperty(w.HTMLElement.prototype, 'innerText', { configurable: true, get() { return this.textContent; } });
    w.Element.prototype.getClientRects = () => [{ width: 100, height: 20 }];
    w.Element.prototype.scrollIntoView = () => {};
    w.AbortSignal.timeout = () => new w.AbortController().signal;
    const timeout = w.setTimeout.bind(w);
    w.setTimeout = (fn, ms, ...args) => timeout(fn, Math.min(ms, 2), ...args);
    w.__xuexitongManaged = true;
    const events = { requests: 0, submits: 0, aborted: 0 };
    let firstSignal, releaseFirst;
    w.fetch = async (url, options) => {
        if (url.endsWith('/health')) return { ok: true };
        assert.equal(url, 'http://127.0.0.1:37841/answer');
        events.requests++;
        if (events.requests === 1) {
            firstSignal = options.signal;
            await new Promise((resolve, reject) => {
                releaseFirst = resolve;
                options.signal.addEventListener('abort', () => {
                    events.aborted++;
                    if (!ignoreAbort) reject(options.signal.reason);
                }, { once: true });
            });
        }
        return { ok: true, json: async () => ({ answers: [{ id: 1, letters: ['B'] }] }) };
    };
    w.document.querySelector('#submit').onclick = () => {
        events.submits++;
        const grade = w.document.createElement('div');
        grade.textContent = '100分 提交时间：模拟结果';
        w.document.body.append(grade);
    };
    w.eval(source);
    for (let i = 0; i < 100 && !w.app; i++) await wait(2);
    assert.ok(w.app);
    return { dom, w, events, get signal() { return firstSignal; }, releaseFirst: () => releaseFirst?.() };
}

for (const method of ['stopAuto', 'destroy']) {
    const f = await setupWork();
    try {
        const original = f.w.app;
        const first = original.startAuto();
        for (let i = 0; i < 100 && !f.signal; i++) await wait(2);
        assert.ok(f.signal);
        original[method]();
        assert.equal(f.signal.aborted, true, `${method} immediately aborts fetch`);
        await first;
        assert.equal(f.events.aborted, 1);
        assert.equal(f.events.submits, 0);
        assert.equal(f.w.document.querySelectorAll('input:checked').length, 0);
        assert.equal(f.w.__xuexitongManagedState.phase, 'stopped', 'cancel does not overwrite stopped with blocked');
        // Stop is terminal for this instance. Reinjecting starts a fresh executor and request.
        f.w.eval(source);
        for (let i = 0; i < 100 && f.w.app === original; i++) await wait(2);
        assert.notEqual(f.w.app, original);
        await f.w.app.startAuto();
        assert.equal(f.events.requests, 2, 'cancelled result is not reused');
        assert.equal(f.events.submits, 1);
        assert.equal(f.w.__xuexitongManagedState.phase, 'submitted');
        console.log(`PASS ${method}: abort pending model request, preserve stopped, reinject and restart successfully`);
    } finally { f.dom.window.close(); }
}
{
    const f = await setupWork({ ignoreAbort: true });
    try {
        const original = f.w.app;
        const first = original.startAuto();
        for (let i = 0; i < 100 && !f.signal; i++) await wait(2);
        original.stopAuto();
        f.w.eval(source);
        for (let i = 0; i < 100 && f.w.app === original; i++) await wait(2);
        const fresh = f.w.app;
        assert.notEqual(fresh, original);
        assert.equal(f.w.__xuexitongManagedState.phase, 'ready');
        f.releaseFirst();
        await first;
        assert.equal(f.events.submits, 0);
        assert.equal(f.w.__xuexitongManagedState.phase, 'ready', 'obsolete response cannot overwrite current state');
        await fresh.startAuto();
        assert.equal(f.events.requests, 2);
        assert.equal(f.events.submits, 1);
        console.log('PASS ignored cancellation: stale response cannot fill, cache or overwrite a newer executor');
    } finally { f.dom.window.close(); }
}
console.log('All playback and request-cancellation tests passed; no real model or platform requests.');
