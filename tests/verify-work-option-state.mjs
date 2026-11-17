// Offline fixtures reproduce the observed standalone-work DIV/span/hidden contract.
// Every model response, choice event, and submission is simulated in jsdom.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { JSDOM, VirtualConsole } = await import('jsdom').catch(() =>
    import(new URL('../node_modules/jsdom/lib/api.js', import.meta.url)));
const source = readFileSync(new URL('../deepseek-console/xuexitong-console.js', import.meta.url), 'utf8')
    .replace(/const LOCAL_TOKEN = '[^']*';/, "const LOCAL_TOKEN = 'offline-work-options';");
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let groups = 0;

async function setup(config = {}) {
    const descriptors = config.questions || [
        { kind: '单选题', initial: ['A'], answer: ['B'] },
        { kind: '多选题', initial: ['A', 'B'], answer: ['A', 'C'] },
    ];
    const html = descriptors.map((question, index) => {
        const qid = String(2000 + index), multi = question.kind === '多选题';
        const data = question.data || ['A', 'B', 'C'];
        return `<div class="padBom50 questionLi fontLabel singleQuesId" data="${qid}" id="sig${qid}" role="group" tabindex="0">
            <h3 class="mark_name colorDeep fontLabel workTextWrap">${index + 1}.（${question.kind}）离线样题${index + 1}</h3>
            <input type="hidden" id="answertype${qid}" name="answertype${qid}" value="${multi ? '1' : '0'}">
            <input type="hidden" id="answer${qid}" name="answer${qid}" value="">
            <div class="stem_answer qtDetail">${data.map((value, i) =>
                `<div class="clearfix answerBg workTextWrap" qid="${qid}" qtype="${multi ? '1' : '0'}" role="button" tabindex="0">
                    <span class="choice${qid} ${multi ? 'num_option_dx' : 'num_option'}" data="${value}" aria-hidden="true" tabindex="-1">${String.fromCharCode(65 + i)}</span>
                    <div class="answer_p" aria-hidden="true" tabindex="-1">离线选项${i + 1}</div>
                </div>`).join('')}</div></div>`;
    }).join('');
    const logs = [], vc = new VirtualConsole();
    for (const level of ['log', 'warn', 'error']) vc.on(level, (...args) => logs.push(args.map(String).join(' ')));
    const dom = new JSDOM(`<body><div>题量：${descriptors.length}</div>${html}<button id="submit">提交</button></body>`, {
        url: 'https://mooc1.chaoxing.com/mooc-ans/mooc2/work/dowork?workId=offline-work-options',
        runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc,
    });
    const w = dom.window;
    Object.defineProperty(w.HTMLElement.prototype, 'innerText', { configurable: true, get() { return this.textContent; } });
    w.Element.prototype.getClientRects = () => [{ width: 100, height: 20 }];
    w.AbortSignal.timeout = () => new w.AbortController().signal;
    const nativeTimeout = w.setTimeout.bind(w);
    w.setTimeout = (fn, ms, ...args) => nativeTimeout(fn, Math.min(ms, 1), ...args);
    w.__xuexitongManaged = true;
    const events = { model: 0, choices: 0, submit: 0 };
    const cards = [...w.document.querySelectorAll('.singleQuesId')];
    const saved = card => [...card.querySelectorAll('input[type="hidden"]')].find(input => /^answer\d+$/.test(input.id) || /^answer\d+$/.test(input.name));
    const markers = card => [...card.querySelectorAll('span[data]')];
    const selectedClass = index => descriptors[index].kind === '多选题' ? 'check_answer_dx' : 'check_answer';
    function updateSaved(card, index) {
        const values = markers(card).filter(marker => marker.classList.contains(selectedClass(index))).map(marker => marker.getAttribute('data'));
        saved(card).value = config.reverseSaved ? values.reverse().join('') : values.join('');
    }
    cards.forEach((card, index) => {
        for (const marker of markers(card)) if (descriptors[index].initial?.includes(marker.textContent.trim())) marker.classList.add(selectedClass(index));
        updateSaved(card, index);
        for (const row of card.querySelectorAll('.answerBg')) row.addEventListener('click', () => {
            events.choices++;
            if (config.clickDrift === 'decoration') { row.classList.add('hover'); return; }
            const marker = row.querySelector('span[data]'), state = selectedClass(index);
            if (descriptors[index].kind === '多选题') marker.classList.toggle(state);
            else { markers(card).forEach(peer => peer.classList.remove(state)); marker.classList.add(state); }
            if (config.clickDrift !== 'class-only') updateSaved(card, index);
            if (config.clickDrift === 'hidden-only') marker.classList.remove(state);
        });
    });
    config.mutateInitial?.({ w, cards, saved, markers });
    w.Element.prototype.scrollIntoView = function () {
        if (this.id === 'submit') config.beforeSubmit?.({ w, cards, saved, markers, updateSaved });
    };
    w.fetch = async url => {
        if (url === 'http://127.0.0.1:37841/health') return { ok: true };
        assert.equal(url, 'http://127.0.0.1:37841/answer', 'no real network endpoint');
        events.model++;
        config.afterModel?.({ w, cards, saved, markers });
        return { ok: true, json: async () => ({ answers: descriptors.map((question, index) => ({ id: index + 1, letters: question.answer })) }) };
    };
    w.document.querySelector('#submit').addEventListener('click', () => {
        events.submit++;
        const grade = w.document.createElement('div'); grade.textContent = '100分 提交时间：模拟结果'; w.document.body.append(grade);
    });
    w.eval(source);
    for (let i = 0; i < 100 && !w.app; i++) await wait(2);
    assert.ok(w.app, 'work app initialized');
    return { w, cards, saved, markers, app: w.app, logs, events, close() { w.close(); } };
}

async function check(label, config, verify) {
    const fixture = await setup(config);
    try {
        if (config.preview) await fixture.app.previewQuiz(); else await fixture.app.startAuto();
        verify(fixture); groups++; console.log(`PASS ${label}`);
    } finally { fixture.close(); }
}
const blocked = fixture => {
    assert.equal(fixture.events.submit, 0);
    assert.match(fixture.w.__xuexitongManagedState.message, /不一致|无法确认|未确认选中|选项已变化/);
};

await check('observed DIV+SPAN contract reconciles single and multiple selections', {}, fixture => {
    assert.deepEqual(fixture.events, { model: 1, choices: 3, submit: 1 });
    assert.equal(fixture.saved(fixture.cards[0]).value, 'B');
    assert.equal(fixture.saved(fixture.cards[1]).value, 'AC');
    assert.equal(fixture.cards[0].querySelector('.check_answer').textContent, 'B');
    assert.deepEqual([...fixture.cards[1].querySelectorAll('.check_answer_dx')].map(marker => marker.textContent), ['A', 'C']);
});
await check('empty selections are known only through matching hidden and platform classes', {
    questions: [{ kind: '单选题', initial: [], answer: ['B'] }],
}, fixture => { assert.deepEqual(fixture.events, { model: 1, choices: 1, submit: 1 }); });
await check('judgment uses span data true/false rather than guessing from visible letters', {
    questions: [{ kind: '判断题', data: ['true', 'false'], initial: [], answer: ['B'] }],
}, fixture => { assert.equal(fixture.events.submit, 1); assert.equal(fixture.saved(fixture.cards[0]).value, 'false'); });
await check('multiple-choice hidden order is compared as a unique set', {
    questions: [{ kind: '多选题', initial: ['A', 'C'], answer: ['A', 'C'] }], reverseSaved: true,
}, fixture => { assert.deepEqual(fixture.events, { model: 1, choices: 0, submit: 1 }); });
await check('hidden answer may be associated by exact name when ID is absent', {
    mutateInitial: ({ cards, saved }) => saved(cards[0]).removeAttribute('id'),
}, fixture => { assert.equal(fixture.events.submit, 1); });

for (const [label, mutateInitial] of [
    ['unknown option container', ({ cards }) => cards[0].querySelectorAll('.answerBg').forEach(row => row.classList.remove('answerBg'))],
    ['missing saved hidden answer', ({ cards, saved }) => saved(cards[0]).remove()],
    ['hidden and marker disagreement', ({ cards, saved }) => { saved(cards[0]).value = ''; }],
    ['ambiguous hidden ID and name association', ({ cards, saved }) => { saved(cards[0]).name = 'answer9999'; }],
    ['marker owned by a different question', ({ cards, markers }) => { markers(cards[0])[0].closest('[qid]').setAttribute('qid', '9999'); }],
    ['duplicate span data mapping', ({ cards, markers }) => { markers(cards[0])[1].setAttribute('data', markers(cards[0])[0].getAttribute('data')); }],
    ['duplicate visible option letters', ({ cards, markers }) => { markers(cards[0])[1].textContent = 'A'; }],
    ['multiple selected markers in a single-choice question', ({ cards, markers, saved }) => {
        markers(cards[0])[1].classList.add('check_answer'); saved(cards[0]).value = 'AB';
    }],
    ['mismatched single/multiple selected class', ({ cards, markers }) => { markers(cards[0])[0].classList.add('check_answer_dx'); }],
]) {
    await check(`read-only preflight rejects ${label} before model`, { mutateInitial }, fixture => {
        assert.deepEqual(fixture.events, { model: 0, choices: 0, submit: 0 });
        assert.equal(fixture.w.__xuexitongManagedState.phase, 'blocked');
    });
}
await check('hidden drift while model answers is rejected before any click', {
    afterModel: ({ cards, saved }) => { saved(cards[0]).value = ''; },
}, fixture => { blocked(fixture); assert.equal(fixture.events.model, 1); assert.equal(fixture.events.choices, 0); });
for (const clickDrift of ['class-only', 'hidden-only', 'decoration']) {
    await check(`click with ${clickDrift} change never proves successful selection`, { clickDrift }, fixture => {
        blocked(fixture); assert.equal(fixture.events.model, 1); assert.equal(fixture.events.choices, 1);
    });
}
await check('valid platform state changed immediately before submit is rejected by strict final readback', {
    beforeSubmit: ({ cards, markers, updateSaved }) => {
        markers(cards[0]).forEach(marker => marker.classList.remove('check_answer'));
        markers(cards[0])[0].classList.add('check_answer'); updateSaved(cards[0], 0);
    },
}, fixture => { blocked(fixture); assert.equal(fixture.events.model, 1); assert.equal(fixture.events.choices, 3); });
await check('preview can explain an unknown state without requesting any choice or submission', {
    preview: true, mutateInitial: ({ cards }) => cards.forEach(card => card.querySelectorAll('.answerBg').forEach(row => row.classList.remove('answerBg'))),
}, fixture => { assert.deepEqual(fixture.events, { model: 1, choices: 0, submit: 0 }); });

console.log(`All ${groups} standalone-work option-state groups passed; zero real model/platform requests.`);
