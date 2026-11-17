// Local DOM simulation only: no network, model calls, or real submissions.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const { JSDOM, VirtualConsole } = await import(new URL('../node_modules/jsdom/lib/api.js', import.meta.url));
const source = readFileSync(new URL('../deepseek-console/xuexitong-console.js', import.meta.url), 'utf8');
const jquery = readFileSync(new URL('../node_modules/jquery/dist/jquery.js', import.meta.url), 'utf8');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const answers = [{ id: 1, letters: ['B'] }, { id: 2, letters: ['A', 'C'] }, { id: 3, letters: ['A'] }];
function question(kind, index, multi = false) {
    return `<div class="qitem"><div>【${kind}】测试题${index}</div>${['A', 'B', 'C'].map((letter) =>
        `<label class="opt"><span>${letter}</span><input type="${multi ? 'checkbox' : 'radio'}" name="q${index}" ${multi && letter === 'B' ? 'checked' : ''}><span>选项${letter}</span></label>`).join('')}</div>`;
}
async function setup({ course = false, bad = false, unsupported = false, slow = false, resume = false } = {}) {
    const vc = new VirtualConsole();
    const logs = [];
    for (const level of ['log', 'warn', 'error']) vc.on(level, (...args) => logs.push(args.map(String).join(' ')));
    const dom = new JSDOM(`<body>${course ? '<div id="coursetree"></div><div class="prev_title" title="章节测验">章节测验</div>' : ''}
        <div>题量：3</div>${question('单选题', 1)}${question('多选题', 2, true)}${question('判断题', 3)}
        ${unsupported ? '<div>【填空题】未支持题型</div>' : ''}
        <button id="submit">提交</button><button id="next">下一节</button></body>`, {
        url: course ? 'https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=1' : 'https://mooc1-api.chaoxing.com/mooc-ans/mooc2/work/dowork?workId=1',
        runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc,
    });
    const w = dom.window;
    Object.defineProperty(w.HTMLElement.prototype, 'innerText', { configurable: true,
        get() { return this.textContent; }, set(value) { this.textContent = value; } });
    w.Element.prototype.getClientRects = () => [{ width: 100, height: 20 }];
    w.Element.prototype.scrollIntoView = () => {};
    w.focus = () => {};
    w.AbortSignal.timeout = () => new w.AbortController().signal;
    const timeout = w.setTimeout.bind(w), interval = w.setInterval.bind(w);
    w.setTimeout = (fn, ms, ...rest) => timeout(fn, Math.min(ms, 2), ...rest);
    w.setInterval = (fn, ms, ...rest) => interval(fn, Math.min(ms, 2), ...rest);
    const keeper = { closed: false, document: { title: '', body: { innerHTML: '' } }, blur() {}, eval() {}, clearInterval() {}, close() { this.closed = true; } };
    w.open = () => keeper;
    if (resume) {
        w.__xuexitongAutoInjected = true;
        w.__xuexitongRequestedMode = 'auto';
        w.__xuexitongKeeperRef = keeper;
    }
    const events = { requests: 0, submit: 0, confirm: 0, next: 0 };
    let release;
    w.fetch = async (url) => {
        if (url.endsWith('/health')) return { ok: true };
        assert.ok(url.endsWith('/answer'));
        events.requests++;
        if (slow) await new Promise((resolve) => { release = resolve; });
        return { ok: true, json: async () => ({ answers: bad ? [{ id: 9, letters: ['A'] }] : answers }) };
    };
    w.document.querySelector('#submit').addEventListener('click', () => {
        events.submit++;
        const dialog = w.document.createElement('div');
        dialog.setAttribute('role', 'dialog');
        dialog.innerHTML = '确认提交？<button>确定</button>';
        dialog.querySelector('button').addEventListener('click', () => {
            events.confirm++;
            dialog.remove();
            const score = w.document.createElement('div');
            score.textContent = course ? '本次成绩 100 分 我的答案：' : '100分 提交时间：11-16';
            w.document.body.append(score);
        });
        w.document.body.append(dialog);
    });
    w.document.querySelector('#next').addEventListener('click', () => {
        events.next++;
        const title = w.document.querySelector('.prev_title');
        if (title) { title.title = '视频'; title.textContent = '视频'; }
    });
    w.eval(jquery);
    w.eval(source.replace(/const LOCAL_TOKEN = '[^']*';/, "const LOCAL_TOKEN = 'test-only';"));
    for (let i = 0; i < 100 && !w.app; i++) await wait(5);
    assert.ok(w.app, 'app initialized');
    return { dom, w, app: w.app, events, keeper, logs, release: () => release?.() };
}

let state = await setup();
try {
    assert.equal(state.events.requests, 0);
    await state.app.startAuto();
    assert.equal(state.events.requests, 1);
    assert.equal(state.events.submit, 1);
    assert.equal(state.events.confirm, 1);
    assert.equal(state.events.next, 0);
    const selected = [...state.w.document.querySelectorAll('input[name="q2"]')].map((input) => input.checked);
    assert.deepEqual(selected, [true, false, true], 'existing wrong checkbox is removed');
    await state.app.startAuto();
    assert.equal(state.events.submit, 1, 'no duplicate submit');
    console.log('PASS work: single/multiple/true-false, reconcile selections, submit+confirm once, no navigation');
} finally { state.dom.window.close(); }

state = await setup();
try {
    await state.app.previewQuiz();
    assert.equal(state.events.submit, 0);
    await state.app.startAuto();
    assert.equal(state.events.requests, 1, 'cached preview avoids another model call');
    assert.equal(state.events.submit, 1);
    console.log('PASS preview remains read-only; startAuto reuses matching preview');
} finally { state.dom.window.close(); }

for (const previewFirst of [true, false]) {
    state = await setup({ slow: true });
    try {
        const first = previewFirst ? state.app.previewQuiz() : state.app.startAuto();
        for (let i = 0; i < 100 && !state.events.requests; i++) await wait(5);
        assert.equal(state.events.requests, 1);
        const second = previewFirst ? state.app.startAuto() : state.app.previewQuiz();
        for (let i = 0; i < 100 && !state.logs.some((line) => line.includes('等待现有请求结果')); i++) await wait(5);
        assert.ok(state.logs.some((line) => line.includes('等待现有请求结果')), 'second caller joined the pending request');
        assert.equal(state.events.requests, 1, 'preview and auto share the pending request');
        assert.equal(state.events.submit, 0, 'no submission while model is pending');
        state.release();
        await Promise.all([first, second]);
        assert.equal(state.events.requests, 1);
        assert.equal(state.events.submit, 1);
        assert.equal(state.events.confirm, 1);
        console.log(`PASS concurrent preview/auto (${previewFirst ? 'preview' : 'auto'} first): one request and one submission`);
    } finally { state.dom.window.close(); }
}

for (const bad of [false, true]) {
    state = await setup({ slow: true, bad });
    try {
        const preview = state.app.previewQuiz();
        for (let i = 0; i < 100 && !state.events.requests; i++) await wait(5);
        const auto = state.app.startAuto();
        for (let i = 0; i < 100 && !state.logs.some((line) => line.includes('等待现有请求结果')); i++) await wait(5);
        assert.ok(state.logs.some((line) => line.includes('等待现有请求结果')), 'auto joined preview before response');
        if (!bad) state.app.stopAuto();
        state.release();
        await Promise.all([preview, auto]);
        assert.equal(state.events.requests, 1, 'no automatic retry after shared failure or stop');
        assert.equal(state.events.submit, 0);
        assert.equal(state.w.document.querySelectorAll('input:checked').length, 1, 'original checkbox remains unchanged');
        console.log(`PASS shared request ${bad ? 'invalid answer' : 'stop'}: no filling, submission, or retry`);
    } finally { state.dom.window.close(); }
}

for (const mode of ['bad', 'unsupported']) {
    state = await setup({ [mode]: true });
    try {
        await state.app.startAuto();
        assert.equal(state.events.submit, 0);
        assert.equal(state.w.document.querySelectorAll('input[name="q1"]:checked').length, 0);
        console.log(`PASS ${mode}: stops before filling/submission`);
    } finally { state.dom.window.close(); }
}

state = await setup({ slow: true });
try {
    const task = state.app.startAuto();
    for (let i = 0; i < 100 && !state.events.requests; i++) await wait(5);
    state.app.stopAuto();
    state.release();
    await task;
    assert.equal(state.events.submit, 0);
    assert.equal(state.w.document.querySelectorAll('input[name="q1"]:checked').length, 0);
    console.log('PASS stop during model request prevents later filling/submission');
} finally { state.dom.window.close(); }

state = await setup({ course: true });
try {
    const app = state.app;
    const task = app._advanceChapterTest.bind(app);
    app.setMode('auto');
    assert.equal(state.keeper.__xuexitongMode, 'auto');
    // Simulate the next video's ready player without real media/network.
    app._getVideoEl = () => ({});
    let resumed = false;
    app.play = () => { resumed = true; };
    await task();
    assert.equal(state.events.submit, 1);
    assert.equal(state.events.confirm, 1);
    assert.equal(state.events.next, 1);
    assert.equal(resumed, true);
    console.log('PASS chapter quiz: submit+confirm, wait for grade, next step and resume video');
} finally { state.dom.window.close(); }

state = await setup({ course: true, resume: true });
try {
    assert.equal(state.app.configs.mode, 'auto', 'keeper reinjection preserves auto mode');
    state.app.stopAuto();
    assert.equal(state.keeper.closed, true);
    console.log('PASS keeper restore auto mode; stop closes keeper');
} finally { state.dom.window.close(); }

state = await setup({ course: true });
try {
    const app = state.app, video = state.w.document.createElement('video');
    let plays = 0, pauses = 0, advances = 0;
    video.play = async () => { plays++; };
    video.pause = () => { pauses++; };
    Object.defineProperty(video, 'paused', { get: () => false });
    app._isChapterTest = () => false;
    app._getVideoEl = function () { this._videoEl = video; return video; };
    app.nextUnit = () => { advances++; };
    await app.startAuto();
    assert.equal(plays, 1);
    assert.equal(video.muted, true);
    assert.equal(video.playbackRate, 1, 'no artificial speed change');
    video.dispatchEvent(new state.w.Event('ended'));
    await wait(20);
    assert.equal(advances, 1, 'ended event advances once');
    app.stopAuto();
    assert.equal(pauses, 1);
    await app.play();
    assert.equal(plays, 1, 'stopped task cannot be restarted by delayed play callbacks');
    console.log('PASS video: play at normal speed, ended advances, stop pauses and blocks restart');
} finally { state.dom.window.close(); }
console.log('All local automatic submission simulations passed; no real requests were sent.');
