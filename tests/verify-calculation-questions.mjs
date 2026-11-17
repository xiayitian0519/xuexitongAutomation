import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const { JSDOM, VirtualConsole } = await import(new URL('../node_modules/jsdom/lib/api.js', import.meta.url));
const source = readFileSync(new URL('../deepseek-console/xuexitong-console.js', import.meta.url), 'utf8');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jOioAAAAASUVORK5CYII=';
const labels = ['(计算题, 10分)', '（计算题，5分）', '【计算题】', '(计算题, 10.5分)'];

async function fixture({ script = source, expectedCount = 4, unsupported = false, extraEditor = false } = {}) {
    const cards = labels.map((label, i) => `<div class="padBom50 questionLi fontLabel singleQuesId" id="question${i}">
        <h3 class="mark_name colorDeep fontLabel workTextWrap">${i + 1}. <span class="colorShallow">${label}</span> 求图示点的电势并给出推导（测试题${i + 1}）。${i < 2 ? '<img class="diagram" src="https://mooc1-api.chaoxing.com/test.png">' : ''}</h3>
        <div class="clear"></div><input type="hidden" id="answertype${i}" value="7">
        <div class="stem_answer"><div class="edui-editor" id="ue${i}"><div>段落格式字体字号</div><iframe></iframe></div>
        <textarea style="display:none" id="field${i}"></textarea><script>var qtype = '7'; var wordNum = '';</script></div>
        ${i === 0 && extraEditor ? '<textarea id="extra"></textarea>' : ''}</div>`).join('');
    const dom = new JSDOM(`<body><div>题量：${expectedCount}</div><div class="mark_table padTop20 ans-cc"><form id="submitForm"><div class="whiteDiv">
        <h2 class="type_tit">一. 计算题（共4题，35分）</h2>${cards}
        ${unsupported ? '<section><h3>(论述题, 5分) 未支持的第五题</h3><textarea></textarea></section>' : ''}
        </div></form></div><button id="submit">提交</button></body>`, {
        url: 'https://mooc1-api.chaoxing.com/mooc-ans/mooc2/work/dowork?workId=2',
        runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: new VirtualConsole(),
    });
    const w = dom.window, doc = w.document;
    Object.defineProperty(w.HTMLElement.prototype, 'innerText', { configurable: true, get() { return this.textContent; } });
    w.Element.prototype.getClientRects = function () { return this.style?.display === 'none' ? [] : [{ width: 100, height: 20 }]; };
    w.Element.prototype.scrollIntoView = () => {};
    w.HTMLCanvasElement.prototype.getContext = () => ({ fillRect() {}, drawImage() {} });
    w.HTMLCanvasElement.prototype.toDataURL = () => png;
    for (const image of doc.querySelectorAll('.diagram')) Object.defineProperties(image, {
        complete: { value: true }, naturalWidth: { value: 200 }, naturalHeight: { value: 150 },
    });
    const timeout = w.setTimeout.bind(w);
    w.setTimeout = (fn, ms, ...args) => timeout(fn, Math.min(ms, 2), ...args);
    w.AbortSignal.timeout = () => new w.AbortController().signal;
    const counts = { requests: 0, writes: 0, syncs: 0, submits: 0 };
    w.UE = { instants: Object.fromEntries(labels.map((_, i) => {
        let value = '';
        return [`editor${i}`, { container: doc.querySelector(`#ue${i}`),
            setContent(html) { counts.writes++; const holder = doc.createElement('div'); holder.innerHTML = html; value = holder.textContent; },
            getContentTxt() { return value; }, fireEvent() {},
            sync() { counts.syncs++; doc.querySelector(`#field${i}`).value = value; },
        }];
    })) };
    doc.querySelector('#submit').onclick = () => {
        counts.submits++;
        for (let i = 0; i < 4; i++) assert.equal(doc.querySelector(`#field${i}`).value, `测试答案${i + 1}：V = kq/r。`);
        const message = doc.createElement('p'); message.textContent = '100分 提交时间：11-16'; doc.body.append(message);
    };
    w.fetch = async (url, options) => {
        if (url.endsWith('/health')) return { ok: true };
        if (!url.endsWith('/answer')) throw new Error('unexpected request');
        counts.requests++;
        const questions = JSON.parse(options.body).questions;
        assert.equal(questions.length, 4);
        for (const [i, question] of questions.entries()) {
            assert.equal(question.id, i + 1);
            assert.equal(question.type, '简答题', 'normalize only at extraction; existing wire contract stays valid');
            assert.equal(question.blankCount, 1);
            assert.equal(question.images.length, i < 2 ? 1 : 0);
            assert.ok(!/段落格式|wordNum|qtype/.test(question.question), 'exclude editor/script decorations');
        }
        return { ok: true, json: async () => ({ answers: questions.map(q => ({ id: q.id, texts: [`测试答案${q.id}：V = kq/r。`] })) }) };
    };
    w.eval(script.replace(/const LOCAL_TOKEN = '[^']*';/, "const LOCAL_TOKEN = 'test-only';"));
    for (let i = 0; i < 100 && !w.app; i++) await wait(5);
    assert.ok(w.app);
    return { dom, w, doc, counts };
}

{
    const f = await fixture();
    try {
        const before = f.doc.body.innerHTML;
        const questions = f.w.app.inspectQuiz();
        assert.equal(questions.length, 4);
        assert.ok(questions.every(q => q.type === '简答题' && q.blankCount === 1));
        assert.equal(f.w.app.inspectPageDom().题型标记.计算题, 4);
        assert.equal(f.doc.body.innerHTML, before);
        assert.deepEqual(f.counts, { requests: 0, writes: 0, syncs: 0, submits: 0 });
        await f.w.app.previewQuiz();
        assert.deepEqual(f.counts, { requests: 1, writes: 0, syncs: 0, submits: 0 });
        assert.equal(f.doc.body.innerHTML, before);
        console.log('PASS real-shaped calculation markers: four UEditors, readonly inspection and preview, images kept, normalized payload');
    } finally { f.dom.window.close(); }
}
{
    const f = await fixture();
    try {
        await f.w.app.startAuto();
        assert.deepEqual(f.counts, { requests: 1, writes: 4, syncs: 4, submits: 1 });
        console.log('PASS offline automatic path: all four managed editors synchronized and reread before simulated submit');
    } finally { f.dom.window.close(); }
}
for (const options of [{ expectedCount: 5 }, { unsupported: true }, { extraEditor: true }]) {
    const f = await fixture(options);
    try {
        await f.w.app.startAuto();
        assert.deepEqual(f.counts, { requests: 0, writes: 0, syncs: 0, submits: 0 });
        console.log(`PASS fail closed before model: ${JSON.stringify(options)}`);
    } finally { f.dom.window.close(); }
}
{
    const oldMarkers = source.replace(/(const kindPattern = [^\r\n]*?)\|计算题(?=\))/, '$1');
    assert.notEqual(oldMarkers, source, 'regression mutation must change the question-extraction marker');
    const f = await fixture({ script: oldMarkers });
    try {
        assert.equal(f.w.app.inspectQuiz().length, 0, 'old marker set reproduces the actual extraction failure');
        console.log('PASS regression sensitivity: old marker set cannot extract calculation questions');
    } finally { f.dom.window.close(); }
}
console.log('All calculation question fixtures passed; no real model or platform request was sent.');
