// Local DOM fixtures only. Every model/network response is simulated.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { JSDOM, VirtualConsole } = await import('jsdom').catch(() =>
    import(new URL('../node_modules/jsdom/lib/api.js', import.meta.url)));
const source = readFileSync(new URL('../deepseek-console/xuexitong-console.js', import.meta.url), 'utf8')
    .replace(/const LOCAL_TOKEN = '[^']*';/, "const LOCAL_TOKEN = 'local-test';");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const answers = [{ id: 1, letters: ['B'] }, { id: 2, letters: ['A', 'C'] }];

async function setup({ state = 'input', decorateOnly = false, driftBeforeSubmit = false } = {}) {
    const logs = [];
    const vc = new VirtualConsole();
    for (const level of ['log', 'warn', 'error']) vc.on(level, (...args) => logs.push(args.map(String).join(' ')));
    const option = (number, letter) => {
        const checked = number === 1 ? letter === 'A' : letter === 'A' || letter === 'B';
        const attributes = state === 'aria' ? ` role="${number === 1 ? 'radio' : 'checkbox'}" aria-checked="${checked}"`
            : state === 'class' ? ` role="${number === 1 ? 'radio' : 'checkbox'}"` : '';
        return `<label class="opt ${state === 'class' ? checked ? 'selected' : 'unselected' : ''}" data-letter="${letter}"${attributes}>
            <span>${letter}</span>${state === 'input' ? `<input type="${number === 1 ? 'radio' : 'checkbox'}" name="q${number}" ${checked ? 'checked' : ''}>` : ''}<span>选项${letter}</span></label>`;
    };
    const dom = new JSDOM(`<body><div>题量：2</div>
        <section id="q1">【单选题】第一题${['A', 'B', 'C'].map((letter) => option(1, letter)).join('')}</section>
        <section id="q2">【多选题】第二题${['A', 'B', 'C'].map((letter) => option(2, letter)).join('')}</section>
        <button id="submit">提交</button></body>`, {
        url: 'https://mooc1-api.chaoxing.com/mooc-ans/mooc2/work/dowork?workId=fixture',
        runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc,
    });
    const w = dom.window;
    Object.defineProperty(w.HTMLElement.prototype, 'innerText', { configurable: true, get() { return this.textContent; } });
    w.Element.prototype.getClientRects = () => [{ width: 100, height: 20 }];
    w.AbortSignal.timeout = () => new w.AbortController().signal;
    const timeout = w.setTimeout.bind(w);
    w.setTimeout = (fn, ms, ...args) => timeout(fn, Math.min(ms, 2), ...args);
    const events = { requests: 0, submits: 0, writes: 0 };
    const setSelected = (element, selected) => {
        if (state === 'input') element.querySelector('input').checked = selected;
        if (state === 'aria') element.setAttribute('aria-checked', String(selected));
        if (state === 'class') {
            element.classList.toggle('selected', selected);
            element.classList.toggle('unselected', !selected);
        }
    };
    const selected = (element) => state === 'input' ? element.querySelector('input').checked
        : state === 'aria' ? element.getAttribute('aria-checked') === 'true' : element.classList.contains('selected');
    for (const element of w.document.querySelectorAll('.opt')) element.addEventListener('click', (event) => {
        events.writes++;
        if (decorateOnly && element.closest('#q1') && element.dataset.letter === 'B') {
            event.preventDefault();
            element.closest('section').setAttribute('data-decoration', 'changed');
            return;
        }
        if (state !== 'aria' && state !== 'class') return;
        const wasSelected = selected(element);
        if (element.closest('#q1')) for (const peer of element.parentElement.querySelectorAll('.opt')) setSelected(peer, false);
        setSelected(element, element.closest('#q1') ? true : !wasSelected);
    });
    w.Element.prototype.scrollIntoView = function () {
        if (this.id === 'submit' && driftBeforeSubmit) setSelected(w.document.querySelector('#q2 [data-letter="B"]'), true);
    };
    w.fetch = async (url) => {
        if (url === 'http://127.0.0.1:37841/health') return { ok: true };
        assert.equal(url, 'http://127.0.0.1:37841/answer');
        events.requests++;
        return { ok: true, json: async () => ({ answers }) };
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
    return { dom, w, app: w.app, events, logs, selected };
}

for (const state of ['input', 'aria', 'class']) {
    const fixture = await setup({ state });
    try {
        await fixture.app.startAuto();
        assert.equal(fixture.events.submits, 1);
        assert.deepEqual([...fixture.w.document.querySelectorAll('#q1 .opt')].filter(fixture.selected).map((el) => el.dataset.letter), ['B']);
        assert.deepEqual([...fixture.w.document.querySelectorAll('#q2 .opt')].filter(fixture.selected).map((el) => el.dataset.letter), ['A', 'C']);
        console.log(`PASS ${state}: correct existing wrong selections and remove stale multiple-choice answers`);
    } finally { fixture.dom.window.close(); }
}

for (const options of [{ decorateOnly: true }, { driftBeforeSubmit: true }, { state: 'unknown' }]) {
    const fixture = await setup(options);
    try {
        await fixture.app.startAuto();
        assert.equal(fixture.events.submits, 0);
        assert.ok(fixture.logs.some((line) => /未确认选中|实际选中项与答案不一致|无法确认选中状态/.test(line)), fixture.logs.join('\n'));
        console.log(`PASS refuse submission: ${JSON.stringify(options)}`);
    } finally { fixture.dom.window.close(); }
}

const fixture = await setup();
try {
    const before = fixture.w.document.body.outerHTML;
    await fixture.app.previewQuiz();
    assert.equal(fixture.events.requests, 1);
    assert.equal(fixture.events.writes, 0);
    assert.equal(fixture.events.submits, 0);
    assert.equal(fixture.w.document.body.outerHTML, before);
    console.log('PASS preview: no choice changes or submission');
} finally { fixture.dom.window.close(); }
console.log('Selection-state tests passed; no real browser, model calls or platform submissions.');
