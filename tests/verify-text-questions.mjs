import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { requestAnswers } from '../deepseek-console/wb-cli-request.mjs';
import { validQuestions, validateAnswers } from '../deepseek-console/answer-contract.mjs';
const { JSDOM, VirtualConsole } = await import(new URL('../node_modules/jsdom/lib/api.js', import.meta.url));
const script = readFileSync(new URL('../deepseek-console/xuexitong-console.js', import.meta.url), 'utf8');
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jOioAAAAASUVORK5CYII=';
const questions = [
    { id: 1, type: '简答题', question: '根据图示求磁感应强度并推导', options: [], blankCount: 1, images: [png] },
    { id: 2, type: '填空题', question: '填两个空', options: [], blankCount: 2, images: [] },
];
const textAnswers = [{ id: 1, texts: ['由毕奥-萨伐尔定律，B = μ₀I/(8a)。\n方向：垂直纸面向外。'] }, { id: 2, texts: ['2', 'm/s'] }];
assert.ok(validQuestions(questions));
assert.equal(validQuestions([{ ...questions[0], id: 1, images: ['https://example.com/a.png'] }]), false);
assert.equal(validQuestions([{ ...questions[0], id: 1, blankCount: 0 }]), false);
assert.throws(() => validateAnswers(questions, [{ id: 1, texts: [''] }, textAnswers[1]]));
assert.throws(() => validateAnswers(questions, [textAnswers[0], { id: 2, texts: ['only one'] }]));
let stdin;
const modelResult = await requestAnswers(questions, '', { runner: async (args, _ms, input) => {
    assert.equal(args[args.indexOf('--input-format') + 1], 'stream-json');
    assert.equal(args[args.indexOf('--tools') + 1], 'StructuredOutput');
    stdin = JSON.parse(input);
    assert.equal(stdin.message.content.filter((block) => block.type === 'image').length, 1);
    const text = stdin.message.content.find((block) => block.type === 'text').text;
    assert.ok(text.includes('blankCount'));
    assert.ok(!text.includes('data:image'), 'base64 is an image block, not prose');
    return { stdout: JSON.stringify({ type: 'result', structured_output: { answers: textAnswers } }) };
} });
assert.deepEqual(modelResult, textAnswers);
console.log('PASS wire contract: text counts, invalid answers, image blocks over stdin, tool whitelist');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function run({ editor = 'textarea', badImage = false, wrongCount = false, preview = false, empty = false, missing = false } = {}) {
    const control = editor === 'ueditor' ? '<div id="ue-container" class="edui-editor"><iframe></iframe></div><textarea id="ue-field" style="display:none"></textarea>' :
        editor === 'tinymce' ? '<textarea id="tiny-field" style="display:none"></textarea><div id="tiny-container" class="tox">工具栏</div>' :
        editor === 'unknown' ? '<iframe id="unknown"></iframe>' :
        editor === 'contenteditable' ? '<div id="answer" contenteditable="true"></div>' : '<textarea id="answer"></textarea>';
    const dom = new JSDOM(`<body><div>题量：2</div>
        <section><div>1. (简答题, 5分) 根据图示求磁感应强度</div><img id="diagram" src="https://mooc1-api.chaoxing.com/question.png">${control}</section>
        <section><div>2. 【填空题】数值和单位</div><input type="text" id="blank1"><input type="text" id="blank2"></section>
        ${missing ? '<section>【简答题】未加载的第三题</section>' : ''}<button id="submit">提交</button></body>`, {
        url: 'https://mooc1-api.chaoxing.com/mooc-ans/mooc2/work/dowork?workId=2', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: new VirtualConsole(),
    });
    const w = dom.window, doc = w.document;
    Object.defineProperty(w.HTMLElement.prototype, 'innerText', { configurable: true, get() { return this.textContent; }, set(v) { this.textContent = v; } });
    w.Element.prototype.getClientRects = function () { return this.style?.display === 'none' ? [] : [{ width: 100, height: 20 }]; };
    w.Element.prototype.scrollIntoView = () => {};
    w.HTMLCanvasElement.prototype.getContext = () => ({ fillRect() {}, drawImage() { if (badImage) throw new Error('tainted'); } });
    w.HTMLCanvasElement.prototype.toDataURL = () => png;
    const img = doc.querySelector('#diagram');
    Object.defineProperties(img, { complete: { value: true }, naturalWidth: { value: 400 }, naturalHeight: { value: 300 } });
    const timeout = w.setTimeout.bind(w);
    w.setTimeout = (fn, ms, ...rest) => timeout(fn, Math.min(ms, 2), ...rest);
    w.AbortSignal.timeout = () => new w.AbortController().signal;
    let synced = 0, editorValue = '';
    const plain = (html) => { const el = doc.createElement('div'); el.innerHTML = html.replace(/<\/p>/g, '</p>\n'); return el.textContent.trim(); };
    if (editor === 'ueditor') w.UE = { instants: { editor1: { container: doc.querySelector('#ue-container'),
        setContent(html) { editorValue = plain(html); }, getContentTxt() { return editorValue; },
        sync() { synced++; doc.querySelector('#ue-field').value = editorValue; }, fireEvent() {},
    } } };
    if (editor === 'tinymce') w.tinymce = { editors: [{ getElement: () => doc.querySelector('#tiny-field'), getContainer: () => doc.querySelector('#tiny-container'),
        setContent(html) { editorValue = plain(html); }, getContent() { return editorValue; },
        save() { synced++; doc.querySelector('#tiny-field').value = editorValue; }, fire() {},
    }] };
    if (editor === 'unknown') doc.querySelector('#unknown').contentDocument.body.setAttribute('contenteditable', 'true');
    let requests = 0, submits = 0, inputEvents = 0;
    doc.addEventListener('input', () => inputEvents++);
    let submittedValue;
    doc.querySelector('#submit').onclick = () => {
        submits++;
        submittedValue = editor === 'ueditor' ? doc.querySelector('#ue-field').value : editor === 'tinymce' ? doc.querySelector('#tiny-field').value : doc.querySelector('#answer')?.value || doc.querySelector('#answer')?.textContent;
        const score = doc.createElement('div'); score.textContent = '100分 提交时间：11-16'; doc.body.append(score);
    };
    w.fetch = async (url, options) => {
        if (url.endsWith('/health')) return { ok: true };
        if (url.endsWith('/answer')) {
            requests++;
            const payload = JSON.parse(options.body).questions;
            assert.equal(payload[0].type, '简答题');
            assert.equal(payload[0].images.length, 1);
            assert.equal(payload[1].blankCount, 2);
            const answers = empty ? [{ id: 1, texts: [''] }, textAnswers[1]] : wrongCount ? [textAnswers[0], { id: 2, texts: ['2'] }] : textAnswers;
            return { ok: true, json: async () => ({ answers }) };
        }
        throw new Error('image blocked');
    };
    w.eval(script.replace(/const LOCAL_TOKEN = '[^']*';/, "const LOCAL_TOKEN = 'test-only';"));
    for (let i = 0; i < 100 && !w.app; i++) await wait(5);
    assert.ok(w.app);
    try {
        if (preview) await w.app.previewQuiz(); else await w.app.startAuto();
        const shouldFail = badImage || wrongCount || empty || editor === 'unknown' || missing;
        if (shouldFail || preview) {
            assert.equal(submits, 0);
            assert.equal(doc.querySelector('#blank1').value, '');
            if (badImage || editor === 'unknown' || missing) assert.equal(requests, 0, 'reject before paid request');
        } else {
            assert.equal(requests, 1); assert.equal(submits, 1);
            assert.equal(submittedValue.replace(/\s/g, ''), textAnswers[0].texts[0].replace(/\s/g, ''));
            assert.equal(doc.querySelector('#blank1').value, '2');
            assert.equal(doc.querySelector('#blank2').value, 'm/s');
            assert.ok(inputEvents >= 2);
            if (editor === 'ueditor' || editor === 'tinymce') assert.equal(synced, 1);
        }
        console.log(`PASS DOM ${JSON.stringify({editor,badImage,wrongCount,preview,empty,missing})}`);
    } finally { dom.window.close(); }
}
for (const editor of ['textarea', 'contenteditable', 'ueditor', 'tinymce', 'unknown']) await run({ editor });
await run({ preview: true });
await run({ badImage: true });
await run({ wrongCount: true });
await run({ empty: true });
await run({ missing: true });
console.log('All text/image simulations passed. No real model or platform requests.');
