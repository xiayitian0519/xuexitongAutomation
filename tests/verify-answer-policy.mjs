// Offline fixtures only. The production token is replaced in memory before evaluation.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const { JSDOM, VirtualConsole } = await import(new URL('../node_modules/jsdom/lib/api.js', import.meta.url));
const source = readFileSync(new URL('../deepseek-console/xuexitong-console.js', import.meta.url), 'utf8')
    .replace(/const LOCAL_TOKEN = '[^']*';/, "const LOCAL_TOKEN = 'offline-policy';");
const jquery = readFileSync(new URL('../node_modules/jquery/dist/jquery.js', import.meta.url), 'utf8');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const policy = { questionsOnly: true, skipWorkedSolutions: true };
let groups = 0;
const esc = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const normal = () => ({ kind: '填空题', title: '测试数值', controls: 1 });

async function fixture(options = {}) {
    const descriptors = options.questions || [normal()];
    const cards = descriptors.map((q, index) => `<section class="policy-question"><h3>${index + 1}. 【${esc(q.kind)}】${esc(q.title || '测试内容')}</h3>${
        q.choice ? ['A', 'B'].map(letter => `<label><span>${letter}</span><input type="radio" name="q${index}"><span>测试选项</span></label>`).join('') :
        Array.from({ length: q.controls || 1 }, () => q.kind === '填空题' ? '<input class="text-answer" type="text">' : '<textarea class="text-answer"></textarea>').join('')
    }</section>`).join('');
    const vc = new VirtualConsole(), safeErrors = [], errorCategories = new Set();
    vc.on('error', (...args) => {
        const error = args.map(String).join(' ');
        if (error.includes('ANSWER_POLICY_')) safeErrors.push('ANSWER_POLICY_WORKED_SOLUTION');
        for (const category of ['ReferenceError', 'TypeError', 'not defined', 'is not a function', '未识别', '题目数量', '题干', '未作答', '加载', '框架', '编辑器', '不存在', '停止', '健康', '覆盖', '已完成']) if (error.includes(category)) errorCategories.add(category);
    });
    const dom = new JSDOM(`<body>${options.course ? '<div id="coursetree"></div><div class="prev_title" title="章节测验">章节测验</div>' : ''}
        <div>题量：${descriptors.length}</div>\n${cards}${options.extra || ''}
        <button id="submit">提交</button><button id="next">下一节</button></body>`, {
        url: options.course ? 'https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=1' : 'https://mooc1.chaoxing.com/mooc-ans/mooc2/work/dowork?workId=1',
        runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc,
    });
    const w = dom.window, doc = w.document;
    Object.defineProperty(w.HTMLElement.prototype, 'innerText', { configurable: true, get() { return this.textContent; }, set(value) { this.textContent = value; } });
    w.Element.prototype.getClientRects = function () { return this.style?.display === 'none' ? [] : [{ width: 100, height: 20 }]; };
    w.Element.prototype.scrollIntoView = () => {};
    w.focus = () => {};
    w.AbortSignal.timeout = () => new w.AbortController().signal;
    const timeout = w.setTimeout.bind(w), interval = w.setInterval.bind(w);
    w.setTimeout = (fn, ms, ...args) => timeout(fn, Math.min(ms, 2), ...args);
    w.setInterval = (fn, ms, ...args) => interval(fn, Math.min(ms, 2), ...args);
    w.open = () => ({ document: { title: '', body: { innerHTML: '' } }, blur() {}, eval() {}, clearInterval() {}, close() {} });
    w.__xuexitongManaged = true;
    if (options.policy !== false) w.__xuexitongAnswerPolicy = options.policy || policy;
    const events = { requests: 0, writes: 0, selections: 0, submits: 0, confirms: 0, next: 0, plays: 0 };
    const addWorked = () => {
        const section = doc.createElement('section'); section.innerHTML = '<h3>【证明题】测试内容</h3><textarea></textarea>';
        doc.querySelector('#submit').before(section);
    };
    let injected = false;
    doc.addEventListener('input', () => { events.writes++; if (options.afterInput && !injected) { injected = true; addWorked(); } });
    doc.querySelectorAll('input[type="radio"]').forEach(input => input.addEventListener('click', () => events.selections++));
    doc.querySelector('#next').addEventListener('click', () => events.next++);
    doc.querySelector('#submit').addEventListener('click', () => {
        events.submits++;
        const dialog = doc.createElement('div'); dialog.setAttribute('role', 'dialog');
        dialog.innerHTML = '确认提交<button>确定</button>';
        dialog.querySelector('button').onclick = () => {
            events.confirms++; dialog.remove();
            const result = doc.createElement('div'); result.textContent = options.course ? '本次成绩 100 分 我的答案：' : '100分 提交时间：11-16'; doc.body.append(result);
        };
        doc.body.append(dialog);
        if (options.beforeConfirm) addWorked();
    });
    let release;
    w.fetch = async (url, init) => {
        if (url.endsWith('/health')) return { ok: true };
        assert.ok(url.endsWith('/answer'), 'fixture refuses all nonlocal resources');
        events.requests++;
        if (options.slow) await new Promise(resolve => { release = resolve; });
        const questions = JSON.parse(init.body).questions;
        return { ok: true, json: async () => ({ answers: questions.map(q => q.type === '填空题' || q.type === '简答题'
            ? { id: q.id, texts: Array.from({ length: q.blankCount }, () => '7') } : { id: q.id, letters: ['A'] }) }) };
    };
    if (options.course) w.eval(jquery);
    w.eval(source);
    for (let i = 0; i < 100 && !w.app; i++) await wait(3);
    assert.ok(w.app, 'fixture initialized');
    return { dom, w, doc, app: w.app, events, safeErrors, errorCategories, addWorked,
        release: () => release?.(),
        async run() {
            await w.app.startAuto();
            // The original course player's play() launches the quiz task without returning it.
            if (options.course) for (let i = 0; i < 500 && !w.app._automationStopped; i++) await wait(3);
        },
        async pending() { for (let i = 0; i < 100 && !events.requests; i++) await wait(3); assert.equal(events.requests, 1); },
        close() { dom.window.close(); },
    };
}

async function check(label, options, verify, execute) {
    const f = await fixture(options);
    try {
        if (execute) await execute(f); else await f.run();
        try { verify(f); } catch (error) {
            console.log(JSON.stringify({ fixtureFailure: label, events: f.events, errorCategories: [...f.errorCategories],
                policyRefusals: f.safeErrors.length, questionCount: f.app.inspectQuiz().length }));
            throw error;
        }
        groups++; console.log(`PASS ${label}`);
    } finally { f.close(); }
}
const untouched = f => {
    assert.equal(f.events.requests, 0); assert.equal(f.events.writes, 0); assert.equal(f.events.selections, 0);
    assert.equal(f.events.submits, 0); assert.equal(f.events.confirms, 0);
    assert.ok([...f.doc.querySelectorAll('.text-answer')].every(input => !input.value), 'all text controls remain empty');
    assert.ok(f.safeErrors.length || f.w.__xuexitongManagedState?.message?.includes('ANSWER_POLICY_WORKED_SOLUTION'), 'policy reports a safe refusal');
};

await check('simple numeric and word blanks remain executable', { questions: [normal(), { kind: '填空题', title: '测试词语与单位', controls: 2 }] }, f => {
    assert.equal(f.events.requests, 1); assert.equal(f.events.writes, 3); assert.equal(f.events.submits, 1); assert.equal(f.events.confirms, 1);
    assert.ok([...f.doc.querySelectorAll('.text-answer')].every(input => input.value.length === 1));
});
await check('ordinary fill instruction explicitly requiring no process is allowed', { questions: [{ kind: '填空题', title: '填写数值，无需写出过程', controls: 1 }] }, f => {
    assert.equal(f.events.requests, 1); assert.equal(f.events.submits, 1); assert.equal(f.events.confirms, 1);
});
for (const kind of ['简答题', '计算题', '解答题', '证明题', '论述题']) {
    await check(`mixed ${kind} blocks the entire paper before the model`, { questions: [normal(), { kind, title: '测试内容', controls: 1 }] }, untouched);
}
for (const title of ['请写出具体步骤', '给出推导过程', '请详细说明理由', '证明下列关系']) {
    await check('explicit process requirement inside a nominal blank is refused', { questions: [{ kind: '填空题', title, controls: 1 }] }, untouched);
}
for (const extra of ['<section><div>【证明题】测试内容</div></section>', '<section><div>题型：解答题</div></section>',
    '<section><div><span>【证明</span><span>题】</span>测试内容</div></section>', '<section><div>1. 解答题</div></section>']) {
    await check('unextracted worked-solution labels in the original DOM fail closed', { extra }, untouched);
}
await check('a worked-solution question inserted while the model waits prevents filling and submit', { slow: true }, f => {
    assert.equal(f.events.requests, 1); assert.equal(f.events.writes, 0); assert.equal(f.events.submits, 0); assert.equal(f.events.confirms, 0);
}, async f => { const task = f.run(); await f.pending(); f.addWorked(); f.release(); await task; });
await check('a process requirement added during model wait is checked before writing', { slow: true }, f => {
    assert.equal(f.events.requests, 1); assert.equal(f.events.writes, 0); assert.equal(f.events.submits, 0);
}, async f => {
    const task = f.run(); await f.pending(); f.doc.querySelector('h3').append(' 请写出解题步骤'); f.release(); await task;
});
await check('a worked-solution question inserted after a fill blocks the submit boundary', { afterInput: true }, f => {
    assert.equal(f.events.requests, 1); assert.equal(f.events.writes, 1); assert.equal(f.events.submits, 0); assert.equal(f.events.confirms, 0);
});
await check('a worked-solution question inserted by submit blocks the confirmation boundary', { beforeConfirm: true }, f => {
    assert.equal(f.events.requests, 1); assert.equal(f.events.submits, 1); assert.equal(f.events.confirms, 0);
});
await check('questions-only play and recovery paths do not call a media player', { course: true }, f => {
    assert.equal(f.events.requests, 0); assert.equal(f.events.plays, 0); assert.equal(f.events.next, 0);
}, async f => {
    const video = f.doc.createElement('video'); video.play = async () => { f.events.plays++; }; video.pause = () => {};
    f.app._isChapterTest = () => false; f.app._getVideoEl = () => video;
    await f.app.startAuto(); await f.app.play(); f.app._tryResumePlayback?.('offline'); f.app._handlePlayError?.(new Error('offline'));
});
await check('questions-only completed chapter stops before the next video', { course: true }, f => {
    assert.equal(f.events.requests, 1); assert.equal(f.events.submits, 1); assert.equal(f.events.confirms, 1);
    assert.equal(f.events.next, 0); assert.equal(f.events.plays, 0);
});
await check('no-policy legacy calculation remains available with unchanged wire type', { policy: false, questions: [{ kind: '计算题', title: '测试内容', controls: 1 }] }, f => {
    assert.equal(f.events.requests, 1); assert.equal(f.events.writes, 1); assert.equal(f.events.submits, 1); assert.equal(f.events.confirms, 1);
});
console.log(`All ${groups} answer-policy fixture groups passed. Zero real model or platform requests.`);
