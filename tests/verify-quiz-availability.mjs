// Isolated synthetic DOM only. No browser, external request, real model or platform action.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const { JSDOM, VirtualConsole } = await import('jsdom').catch(() =>
    import(new URL('../node_modules/jsdom/lib/api.js', import.meta.url)));
const source = readFileSync(new URL('../deepseek-console/xuexitong-console.js', import.meta.url), 'utf8')
    .replace(/const LOCAL_TOKEN = '[^']*';/, "const LOCAL_TOKEN = 'offline-availability';");
const jquery = readFileSync(new URL('../node_modules/jquery/dist/jquery.js', import.meta.url), 'utf8');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let groups = 0;
function patchWindow(w) {
    Object.defineProperty(w.HTMLElement.prototype, 'innerText', {
        configurable: true, get() { return this.textContent; }, set(value) { this.textContent = value; },
    });
    w.Element.prototype.getClientRects = function () {
        return this.closest('[hidden],[style*="display: none"],[style*="display:none"]') ? [] : [{ width: 100, height: 20 }];
    };
    w.Element.prototype.scrollIntoView = () => {};
}
async function setup({ course = true, status = '', submit = 'enabled', questionCount = 1,
    optionMode = 'native', optionText = 'fixture', questionText = 'offline', statusMarkup, afterModel, afterOption, afterSubmit,
    disabledConfirm = false, unrelatedStatus = false, staleFrame = false, unrelatedSubmit = false,
    noQuestions = false, beforeRun, quizPath = '/mooc-ans/work/doHomeWorkNew' } = {}) {
    const vc = new VirtualConsole(), logs = [], children = [];
    for (const level of ['log', 'warn', 'error']) vc.on(level, (...args) => logs.push(args.map(String).join(' ')));
    const dom = new JSDOM(course ? `<body><div id="coursetree"><div id="cur100" class="posCatalog_active"></div></div>
        <div class="prev_title" title="章节测验">章节测验</div>
        <div id="prev_tab"><div>视频</div><div>章节测验</div><div>章节测验</div></div>
        <iframe id="iframe"></iframe><button id="prevNextFocusNext">下一节</button></body>` : '<body></body>', {
        url: course ? 'https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=100'
            : 'https://mooc1.chaoxing.com/mooc-ans/mooc2/work/dowork?workId=offline',
        pretendToBeVisual: true, runScripts: 'outside-only', virtualConsole: vc,
    });
    const w = dom.window; patchWindow(w);
    w.__xuexitongManaged = true;
    w.AbortSignal.timeout = () => new w.AbortController().signal;
    const nativeTimeout = w.setTimeout.bind(w), nativeInterval = w.setInterval.bind(w);
    w.setTimeout = (fn, ms, ...args) => nativeTimeout(fn, Math.min(ms, 1), ...args);
    w.setInterval = (fn, ms, ...args) => nativeInterval(fn, Math.min(ms, 1), ...args);
    let quizDoc = w.document;
    if (course) {
        const paths = ['/mooc-ans/knowledge/cards?knowledgeid=100&num=2',
            '/ananas/modules/work/index.html', quizPath];
        let parentDoc = w.document;
        for (let i = 0; i < paths.length; i++) {
            const child = new JSDOM('<body></body>', {
                url: `https://mooc1.chaoxing.com${paths[i]}`, pretendToBeVisual: true, runScripts: 'outside-only',
            });
            children.push(child); patchWindow(child.window);
            const targetDoc = child.window.document;
            const frame = i === 0 ? parentDoc.querySelector('#iframe') : parentDoc.body.appendChild(parentDoc.createElement('iframe'));
            frame.src = `https://mooc1.chaoxing.com${i === paths.length - 1 ? '/mooc-ans/api/work' : paths[i]}`;
            if (i === paths.length - 1) frame.id = 'frame_content';
            Object.defineProperty(frame, 'contentDocument', { configurable: true, get: () => targetDoc });
            parentDoc = targetDoc; quizDoc = targetDoc;
        }
    }
    const attr = submit === 'disabled' ? 'disabled' : submit === 'aria-disabled' ? 'aria-disabled="true"' : '';
    const submitButton = submit === 'none' ? '' : `<button id="submit" ${attr}><span>提交</span></button>`;
    const submitMarkup = submit === 'fieldset' ? `<fieldset disabled>${submitButton}</fieldset>`
        : submit === 'inert' ? `<div inert>${submitButton}</div>`
        : submit === 'aria-parent' ? `<div aria-disabled="true">${submitButton}</div>` : submitButton;
    quizDoc.body.innerHTML = `<div id="availability">${statusMarkup ?? status}</div><div>题量：${questionCount}</div>
        ${noQuestions ? '' : Array.from({ length: questionCount }, (_, index) => `<section class="question"><div>【单选题】${questionText}-${index}</div>
            ${['A', 'B'].map(letter => optionMode === 'native'
                ? `<label class="opt"><span>${letter}</span><input type="radio" name="q${index}"><span>${optionText}</span></label>`
                : `<li class="opt" role="radio" aria-checked="false"><span>${letter}</span><span>${optionText}</span></li>`).join('')}</section>`).join('')}
        ${submitMarkup}`;
    if (unrelatedStatus && course) {
        const unrelated = w.document.createElement('span'); unrelated.textContent = '未开始';
        w.document.querySelector('#coursetree').append(unrelated);
    }
    if (unrelatedSubmit && course) {
        const otherSubmit = w.document.createElement('button'); otherSubmit.textContent = '提交';
        w.document.body.append(otherSubmit);
    }
    if (staleFrame && course) {
        const stale = w.document.createElement('iframe'); stale.hidden = true; w.document.body.append(stale);
        const old = new JSDOM('<body><div>已截止</div></body>', {
            url: 'https://mooc1.chaoxing.com/mooc-ans/work/doHomeWorkNew', pretendToBeVisual: true,
        });
        children.push(old); patchWindow(old.window);
        Object.defineProperty(stale, 'contentDocument', { configurable: true, get: () => old.window.document });
    }
    const events = { model: 0, option: 0, submit: 0, confirm: 0, next: 0 };
    const f = { dom, w, quizDoc, logs, events,
        setStatus(value) { quizDoc.querySelector('#availability').textContent = value; },
        disableSubmit() { quizDoc.querySelector('#submit').disabled = true; },
        message() { return w.__xuexitongManagedState?.message || ''; },
        close() { dom.window.close(); for (const child of children) child.window.close(); },
    };
    quizDoc.querySelectorAll('.opt').forEach(option => {
        option.addEventListener('click', event => {
            if (event.target.tagName === 'INPUT') return;
            events.option++;
            if (optionMode === 'aria') {
                option.closest('section').querySelectorAll('.opt').forEach(item => item.setAttribute('aria-checked', String(item === option)));
            }
            afterOption?.(f);
        });
    });
    quizDoc.querySelector('#submit')?.addEventListener('click', () => {
        events.submit++;
        const content = w.document.createElement('div'); content.id = 'popcontent'; content.textContent = '确定提交？';
        const confirm = w.document.createElement('button'); confirm.id = 'popok'; confirm.textContent = '确定';
        confirm.disabled = disabledConfirm;
        w.document.body.append(content, confirm);
        confirm.addEventListener('click', () => {
            events.confirm++; content.remove(); confirm.remove();
            const result = quizDoc.createElement('div');
            result.textContent = course ? '本次成绩 100 分 我的答案：' : '100分 提交时间：11-16';
            quizDoc.body.append(result);
        });
        afterSubmit?.(f);
    });
    w.document.querySelector('#prevNextFocusNext')?.addEventListener('click', () => {
        events.next++; w.history.replaceState({}, '', '?chapterId=200');
    });
    w.fetch = async url => {
        assert.ok(typeof url === 'string' && url.startsWith('http://127.0.0.1:37841/'), 'only intercepted local paths allowed');
        if (url.endsWith('/health')) return { ok: true };
        assert.ok(url.endsWith('/answer'), 'unexpected fetch refused'); events.model++;
        afterModel?.(f);
        return { ok: true, json: async () => ({ answers: Array.from({ length: questionCount }, (_, index) => ({ id: index + 1, letters: ['B'] })) }) };
    };
    if (course) w.eval(jquery);
    w.eval(source);
    for (let i = 0; i < 500 && !w.app; i++) await wait(2);
    assert.ok(w.app, 'app initialized');
    f.app = w.app; f.app._clearCheckInterval();
    beforeRun?.(f);
    f.run = async () => {
        f.app.setMode('auto');
        await f.app._advanceChapterTest();
    };
    return f;
}
async function check(label, options, verify, { preview = false } = {}) {
    const f = await setup(options);
    try {
        if (preview) await f.app.previewQuiz(); else await f.run();
        verify(f); groups++; console.log(`PASS ${label}`);
    } finally { f.close(); }
}
function noActions(f, { model = 0 } = {}) {
    assert.equal(f.events.model, model, 'fake model count');
    assert.equal(f.events.option, 0, 'no selection'); assert.equal(f.events.submit, 0, 'no submit');
    assert.equal(f.events.confirm, 0, 'no confirmation'); assert.equal(f.events.next, 0, 'no navigation');
}

for (const status of ['已截止', '作业已结束', '已过截止时间', '尚未开始', '未到开始时间', '本次测验未开始']) {
    await check(`unavailable state ${status} blocks before fake model`, { status }, f => {
        noActions(f); assert.match(f.message(), /已截止或已结束|尚未开始/);
    });
}
for (const statusMarkup of ['已<span>截止</span>', '尚未<b>开始</b>']) {
    await check('split inline unavailable label stops before fake model', { statusMarkup }, f => {
        noActions(f); assert.match(f.message(), /已截止或已结束|尚未开始/);
    });
}
await check('expired nested work document with no questions or submit stops clearly',
    { status: '已截止', submit: 'none', noQuestions: true }, f => {
        noActions(f); assert.match(f.message(), /已截止/); assert.doesNotMatch(f.message(), /120 秒/);
    });
await check('expired api/work document without questions or submit stops clearly',
    { quizPath: '/mooc-ans/api/work', status: '已截止', submit: 'none', noQuestions: true }, f => {
        noActions(f); assert.match(f.message(), /已截止/); assert.doesNotMatch(f.message(), /120 秒/);
    });
for (const submit of ['disabled', 'aria-disabled', 'fieldset', 'inert', 'aria-parent']) {
    await check(`${submit} submit blocks before fake model`, { submit }, f => {
        noActions(f); assert.match(f.message(), /提交按钮已禁用/);
    });
}
await check('unrelated usable submit cannot mask current disabled submit', { submit: 'disabled', unrelatedSubmit: true }, f => {
    noActions(f); assert.match(f.message(), /提交按钮已禁用/);
});
for (const optionMode of ['native', 'aria']) {
    await check(`active depth3 ${optionMode} controls reach mock confirmation and grade`, { optionMode }, f => {
        assert.deepEqual(f.events, { model: 1, option: 1, submit: 1, confirm: 1, next: 1 });
        assert.equal(f.w.__xuexitongManagedState.phase, 'verify');
    });
}
await check('current api/work question document uses the same guarded workflow', { quizPath: '/mooc-ans/api/work' }, f => {
    assert.deepEqual(f.events, { model: 1, option: 1, submit: 1, confirm: 1, next: 1 });
});
await check('question option text and unrelated navigation status do not block active quiz',
    { questionText: '讨论已截止和未开始的区别', optionText: '已截止', unrelatedStatus: true }, f => {
        assert.deepEqual(f.events, { model: 1, option: 1, submit: 1, confirm: 1, next: 1 });
    });
await check('same-document hidden status and template do not block active quiz', {
    beforeRun: f => {
        const hidden = f.quizDoc.createElement('div'); hidden.hidden = true; hidden.innerHTML = '<span>已截止</span>';
        const template = f.quizDoc.createElement('template'); template.innerHTML = '<span>尚未开始</span>';
        const wrapper = f.quizDoc.createElement('div'); wrapper.innerHTML = '<span hidden>已截止</span>';
        f.quizDoc.body.append(hidden, template, wrapper);
    },
}, f => {
    assert.deepEqual(f.events, { model: 1, option: 1, submit: 1, confirm: 1, next: 1 });
});
await check('hidden stale expired iframe does not block active quiz', { staleFrame: true }, f => {
    assert.deepEqual(f.events, { model: 1, option: 1, submit: 1, confirm: 1, next: 1 });
});
await check('deadline reached during fake model wait blocks before first selection', { afterModel: f => f.setStatus('已截止') }, f => {
    noActions(f, { model: 1 }); assert.match(f.message(), /已截止/);
});
await check('submit disabled during fake model wait blocks before first selection', { afterModel: f => f.disableSubmit() }, f => {
    noActions(f, { model: 1 }); assert.match(f.message(), /提交按钮已禁用/);
});
await check('status changed after first selection prevents second selection and submit',
    { questionCount: 2, afterOption: f => f.setStatus('尚未开始') }, f => {
        assert.equal(f.events.model, 1); assert.equal(f.events.option, 1);
        assert.equal(f.events.submit, 0); assert.equal(f.events.confirm, 0); assert.equal(f.events.next, 0);
        assert.match(f.message(), /尚未开始/);
    });
await check('submit disabled after final selection prevents submit', { afterOption: f => f.disableSubmit() }, f => {
    assert.equal(f.events.option, 1); assert.equal(f.events.submit, 0); assert.equal(f.events.confirm, 0);
    assert.match(f.message(), /提交按钮已禁用/);
});
await check('deadline changed after submit click prevents confirmation', { afterSubmit: f => f.setStatus('已截止') }, f => {
    assert.equal(f.events.submit, 1); assert.equal(f.events.confirm, 0); assert.equal(f.events.next, 0);
    assert.match(f.message(), /已截止/);
});
await check('disabled platform confirmation button is never clicked', { disabledConfirm: true }, f => {
    assert.equal(f.events.submit, 1); assert.equal(f.events.confirm, 0); assert.equal(f.events.next, 0);
    assert.match(f.message(), /提交确认按钮已禁用/);
});
await check('expired result remains inspectable and preview stays read-only', { course: false, status: '已截止', submit: 'none' }, f => {
    assert.equal(f.app.inspectQuiz().length, 1); noActions(f, { model: 1 });
    assert.ok(f.logs.some(line => line.includes('答案预览')));
}, { preview: true });
await check('disabled submit does not disable read-only preview', { course: false, submit: 'disabled' }, f => {
    assert.equal(f.app.inspectQuiz().length, 1); noActions(f, { model: 1 });
}, { preview: true });

console.log(`All ${groups} quiz-availability fixture groups passed. Zero real model or platform requests.`);
