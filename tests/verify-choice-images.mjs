// Offline DOM and canvas simulation only. All fetches are intercepted; no real model or platform.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { validQuestions } from '../deepseek-console/answer-contract.mjs';
const sourceUrl = process.env.XUEXITONG_CONSOLE_SOURCE
    ? pathToFileURL(process.env.XUEXITONG_CONSOLE_SOURCE)
    : new URL('../deepseek-console/xuexitong-console.js', import.meta.url);
const source = readFileSync(sourceUrl, 'utf8').replace(/const LOCAL_TOKEN = '[^']*';/, "const LOCAL_TOKEN = 'offline-images';");
const { JSDOM, VirtualConsole } = await import('jsdom').catch(() =>
    import(new URL('../node_modules/jsdom/lib/api.js', import.meta.url)));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const pic = (id, width = 240, height = 60, more = {}) => ({ image: { id, width, height, ...more } });
const esc = text => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
let groups = 0;
function decodeFixture(data) { return JSON.parse(Buffer.from(data.split(',')[1], 'base64').toString('utf8')); }
async function setup(descriptors, config = {}) {
    const specs = new Map();
    const markup = parts => (Array.isArray(parts) ? parts : [parts]).map(part => {
        if (!part?.image) return esc(part ?? '');
        const image = part.image; specs.set(image.id, image);
        return `<img data-fixture="${esc(image.id)}" src="https://fixture.invalid/${esc(image.src || image.id)}.png">`;
    }).join('');
    const html = descriptors.map((q, index) => {
        const qid = String(1000 + index);
        return `<div class="singleQuesId"><div class="TiMu newTiMu"><div class="Zy_TItle clearfix">
            <div class="clearfix font-cxsecret fontLabel"><span class="newZy_TItle">${index + 1}.【${q.kind || '单选题'}】${markup(q.stem)}</span></div></div>
            <ul class="Zy_ulTop w-top fl">${q.options.map((parts, i) => `<li class="font-cxsecret before-after" role="${q.kind === '多选题' ? 'checkbox' : 'radio'}" qid="${qid}">
                <label class="fl before"><span class="${q.markerClass || (q.kind === '多选题' ? 'num_option_dx' : 'num_option')} choice${qid}" data="${q.optionData?.[i] ?? String.fromCharCode(65 + i)}">${String.fromCharCode(65 + i)}</span></label>
                <div class="option-content">${markup(parts)}</div></li>`).join('')}</ul>
            <input type="hidden" id="answer${qid}" value=""><input type="hidden" id="answertype${qid}" value="0"></div></div>`;
    }).join('');
    const logs = [], vc = new VirtualConsole();
    for (const level of ['log', 'warn', 'error']) vc.on(level, (...args) => logs.push(args.map(String).join(' ')));
    const dom = new JSDOM(`<body><div>题量：${descriptors.length}</div>${html}<button id="submit">提交</button></body>`, {
        url: 'https://mooc1.chaoxing.com/mooc-ans/mooc2/work/dowork?workId=offline-images',
        runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc,
    });
    const w = dom.window;
    Object.defineProperty(w.HTMLElement.prototype, 'innerText', { configurable: true,
        get() { return this.textContent; }, set(value) { this.textContent = value; } });
    w.Element.prototype.getClientRects = () => [{ width: 100, height: 20 }];
    w.Element.prototype.scrollIntoView = () => {};
    w.AbortSignal.timeout = () => new w.AbortController().signal;
    const nativeTimeout = w.setTimeout.bind(w);
    w.setTimeout = (fn, ms, ...args) => nativeTimeout(fn, Math.min(ms, 1), ...args);
    for (const image of w.document.images) {
        const spec = specs.get(image.dataset.fixture); image._fixtureId = spec.id;
        Object.defineProperties(image, {
            complete: { configurable: true, get: () => !spec.broken },
            naturalWidth: { configurable: true, get: () => spec.broken ? 0 : spec.width },
            naturalHeight: { configurable: true, get: () => spec.broken ? 0 : spec.height },
        });
    }
    const canvases = [], decodings = [];
    w.HTMLCanvasElement.prototype.getContext = function () {
        if (!this._context) {
            const context = { labels: [], draws: [], fills: [], fillStyle: '', font: '', textBaseline: '',
                fillRect: (...args) => context.fills.push(args),
                fillText: (text, x, y) => context.labels.push({ text, x, y }),
                drawImage: (image, ...bounds) => {
                    if (config.tainted && config.tainted === image._fixtureId) this._tainted = true;
                    context.draws.push({ ids: image._fixtureIds || [image._fixtureId], bounds,
                        sourceWidth: image.naturalWidth, sourceHeight: image.naturalHeight });
                },
            };
            this._context = context; canvases.push(this);
        }
        return this._context;
    };
    w.HTMLCanvasElement.prototype.toDataURL = function () {
        if (this._tainted) throw new Error('offline simulated security error');
        const data = { width: this.width, height: this.height,
            ids: this._context.draws.flatMap(draw => draw.ids), labels: this._context.labels };
        if (config.badEncoding) return 'data:image/png;base64,?';
        if (config.emptyEncoding) return 'data:,';
        const minChars = this._context.labels.length && config.atlasOversize ? 1600000 : config.imageChars || 0;
        let serialized = JSON.stringify(data);
        if (minChars) serialized += ' '.repeat(Math.max(0, Math.ceil(minChars * .75) - serialized.length));
        return `data:image/png;base64,${Buffer.from(serialized).toString('base64')}`;
    };
    w.Image = class OfflineImage {
        set src(value) {
            this.data = decodeFixture(value);
            decodings.push({ mime: value.slice(5, value.indexOf(';')), width: this.data.width, height: this.data.height, ids: this.data.ids });
        }
        async decode() {
            if (config.decodeFailure && this.data.ids.includes(config.decodeFailure)) throw new Error('offline damaged encoded image');
            this.complete = true; this.naturalWidth = this.data.width; this.naturalHeight = this.data.height;
            this._fixtureIds = this.data.ids;
        }
    };
    const events = { model: 0, click: 0, resourceFetch: 0, submit: 0 }, payloads = [];
    w.__xuexitongManaged = true;
    for (const [index, card] of [...w.document.querySelectorAll('.singleQuesId')].entries()) {
        const qid = String(1000 + index), q = descriptors[index];
        const markers = [...card.querySelectorAll(`.choice${qid}`)];
        const hidden = card.querySelector(`#answer${qid}`);
        const selectedClass = q.kind === '多选题' ? 'check_answer_dx' : 'check_answer';
        for (const marker of markers) if (config.initial?.[index]?.includes(marker.textContent)) marker.classList.add(selectedClass);
        hidden.value = markers.filter(marker => marker.classList.contains(selectedClass)).map(marker => marker.getAttribute('data')).join('');
        if (config.reverseSaved) hidden.value = [...hidden.value].reverse().join('');
        if (config.initialHiddenDrift) hidden.value = 'invalid';
        for (const row of card.querySelectorAll('li[qid]')) row.addEventListener('click', () => {
            const own = row.querySelector(`.choice${qid}`);
            if (q.kind === '多选题') own.classList.toggle(selectedClass);
            else {
                markers.forEach(marker => marker.classList.remove(selectedClass));
                own.classList.add(selectedClass);
            }
            hidden.value = markers.filter(marker => marker.classList.contains(selectedClass)).map(marker => marker.getAttribute('data')).join('');
            if (config.reverseSaved) hidden.value = [...hidden.value].reverse().join('');
            markers.forEach(marker => {
                const owner = marker.closest('li'); owner.setAttribute('aria-checked', String(marker.classList.contains(selectedClass)));
                owner.setAttribute('aria-pressed', String(marker.classList.contains(selectedClass)));
            });
            if (config.afterSelectionDrift === 'hidden') hidden.value = 'invalid';
            if (config.afterSelectionDrift === 'class') own.classList.remove(selectedClass);
            if (config.afterSelectionDrift === 'aria') row.setAttribute('aria-checked', 'false');
            if (config.afterSelectionDrift === 'pressed') row.setAttribute('aria-pressed', 'false');
        });
    }
    w.document.body.addEventListener('click', () => { events.click++; });
    w.document.querySelector('#submit').addEventListener('click', () => {
        events.submit++;
        const result = w.document.createElement('div'); result.textContent = '100分 提交时间：11-16'; w.document.body.append(result);
    });
    w.fetch = async (url, options) => {
        if (url === 'http://127.0.0.1:37841/health') return { ok: true };
        if (url !== 'http://127.0.0.1:37841/answer') {
            events.resourceFetch++;
            const original = [...w.document.images].find(image => (image.currentSrc || image.src) === url);
            const resource = original && config.resources?.[original._fixtureId];
            if (!resource) return { ok: false };
            let contents = JSON.stringify({ width: resource.width, height: resource.height, ids: [original._fixtureId] });
            if (resource.bytes) contents += ' '.repeat(Math.max(0, resource.bytes - Buffer.byteLength(contents)));
            return { ok: true, blob: async () => new w.Blob([contents], { type: resource.type }) };
        }
        events.model++;
        const payload = JSON.parse(options.body); payloads.push(payload.questions);
        assert.ok(validQuestions(payload.questions), 'payload keeps the unchanged image wire contract');
        return { ok: true, json: async () => ({ answers: descriptors.map((_, index) =>
            ({ id: index + 1, letters: config.answers?.[index] || ['A'] })) }) };
    };
    w.eval(source);
    for (let i = 0; i < 100 && !w.app; i++) await wait(2);
    assert.ok(w.app, 'offline work app initialized');
    const before = w.document.body.innerHTML;
    return { w, app: w.app, events, payloads, logs, canvases, decodings,
        async preview() { await w.app.previewQuiz(); },
        async auto() { await w.app.startAuto(); },
        unchanged() { assert.equal(w.document.body.innerHTML, before); assert.equal(events.click, 0); },
        close() { dom.window.close(); },
    };
}
async function check(label, descriptors, config, verify) {
    const f = await setup(descriptors, config);
    try {
        if (config.auto) await f.auto(); else await f.preview();
        try { verify(f); }
        catch (error) {
            error.message += `; offline failure category: ${f.logs.filter(log => log.includes('答案预览失败')).join(' | ')}`;
            throw error;
        }
        if (!config.auto) f.unchanged(); groups++; console.log(`PASS ${label}`);
    }
    finally { f.close(); }
}
const pure = count => ({ stem: ['lead', pic('stem'), 'tail'],
    options: Array.from({ length: count - 1 }, (_, i) => [pic(`opt-${i}`)]) });

await check('pure-image single-choice keeps all options and maps stem/option positions', [pure(5)], {}, f => {
    const q = f.payloads[0][0]; assert.equal(q.options.length, 4); assert.equal(q.images.length, 1);
    assert.match(q.question, /lead \[图1\] tail/);
    assert.deepEqual(q.options.map(option => option.text), ['[图2]', '[图3]', '[图4]', '[图5]']);
    const atlas = decodeFixture(q.images[0]);
    assert.deepEqual(atlas.ids, ['stem', 'opt-0', 'opt-1', 'opt-2', 'opt-3']);
    assert.deepEqual(atlas.labels.map(label => label.text), ['Image 1', 'Image 2', 'Image 3', 'Image 4', 'Image 5']);
});
await check('multi-choice .num_option wins over stray option-body letter B', [{ kind: '多选题', stem: ['fixture', pic('m-stem')],
    options: [['B', pic('m-A')], [pic('m-B')], ['text', pic('m-C'), 'after']] }], {}, f => {
    const q = f.payloads[0][0]; assert.equal(q.options.length, 3); assert.equal(q.images.length, 4);
    assert.deepEqual(q.options.map(option => option.text), ['B [图2]', '[图3]', 'text [图4] after']);
    assert.equal(f.canvases.filter(canvas => canvas._context.labels.length).length, 0, '<=4 keeps individual-image path');
});
await check('pure-image question stem remains a question', [{ stem: [pic('pure-stem')], options: [['one'], ['two']] }], {}, f => {
    assert.equal(f.events.model, 1); assert.match(f.payloads[0][0].question, /^\[图1\]/);
});
await check('same source in separate DOM positions keeps separate image identities', [{ stem: ['a', pic('same-stem', 240, 60, { src: 'same' })],
    options: [[pic('same-A', 240, 60, { src: 'same' }), 'then', pic('same-A2', 240, 60, { src: 'same' })], ['plain']] }], {}, f => {
    const q = f.payloads[0][0]; assert.equal(q.images.length, 3); assert.equal(q.options[0].text, '[图2] then [图3]');
    assert.deepEqual(q.images.map(image => decodeFixture(image).ids[0]), ['same-stem', 'same-A', 'same-A2']);
});
await check('seven-image atlas preserves every image and its global number', [{ stem: [pic('seven-stem')],
    options: [[pic('seven-A1'), pic('seven-A2')], [pic('seven-B1'), pic('seven-B2')], [pic('seven-C1'), pic('seven-C2')]] }], {}, f => {
    const q = f.payloads[0][0], atlas = decodeFixture(q.images[0]);
    assert.equal(atlas.ids.length, 7); assert.equal(atlas.labels.at(-1).text, 'Image 7');
    assert.equal(q.options[2].text, '[图6] [图7]');
});
await check('multiple atlas sheets retain numbering and clear uncropped bounds', [{ stem: [pic('large-stem', 1000, 600)],
    options: Array.from({ length: 3 }, (_, i) => [pic(`large-${i}-a`, 1000, 600), pic(`large-${i}-b`, 1000, 600)]) }], {}, f => {
    const q = f.payloads[0][0]; assert.equal(q.images.length, 3);
    assert.deepEqual(q.images.flatMap(image => decodeFixture(image).labels.map(label => label.text)),
        Array.from({ length: 7 }, (_, i) => `Image ${i + 1}`));
    for (const canvas of f.canvases.filter(item => item._context.labels.length)) {
        assert.ok(canvas.width <= 2048 && canvas.height <= 2048 && canvas.width * canvas.height <= 4000000);
        for (const draw of canvas._context.draws) {
            const [x, y, width, height] = draw.bounds;
            assert.ok(x >= 0 && y >= 34 && x + width <= canvas.width && y + height <= canvas.height);
            assert.equal(width, draw.sourceWidth); assert.equal(height, draw.sourceHeight);
        }
    }
});
await check('fifteen questions with 5/7/5 formula images are all retained within wire budget', [
    pure(5), { stem: [pic('r2-stem')], options: Array.from({ length: 3 }, (_, i) => [pic(`r2-${i}a`), pic(`r2-${i}b`)]) },
    { stem: [pic('r3-stem')], options: Array.from({ length: 4 }, (_, i) => [pic(`r3-${i}`)]) },
    ...Array.from({ length: 12 }, (_, i) => ({ stem: [`text-${i}`], options: [['one'], ['two']] })),
], {}, f => {
    assert.equal(f.app.inspectQuiz().length, 15); assert.equal(f.payloads[0].length, 15);
    assert.deepEqual(f.payloads[0].map(q => q.images.length).slice(0, 3), [1, 1, 1]);
    for (let i = 0; i < 3; i++) assert.match(f.payloads[0][i].question, /\[图1\]/);
});
await check('real 312x132 image/jpg fallback normalizes the MIME alias and uses a new clean PNG canvas',
    [{ stem: [pic('jpg-root', 312, 132)], options: [['one'], ['two']] }],
    { tainted: 'jpg-root', resources: { 'jpg-root': { type: 'image/jpg', width: 312, height: 132, bytes: 6675 } } }, f => {
        assert.equal(f.events.resourceFetch, 1); assert.equal(f.events.model, 1);
        assert.match(f.payloads[0][0].images[0], /^data:image\/png;base64,/);
        assert.deepEqual(decodeFixture(f.payloads[0][0].images[0]), { width: 312, height: 132, ids: ['jpg-root'], labels: [] });
        assert.equal(f.canvases.length, 2); assert.equal(f.canvases[0]._tainted, true); assert.ok(!f.canvases[1]._tainted);
        assert.ok(f.decodings.some(image => image.mime === 'image/jpeg' && image.width === 312 && image.height === 132));
    });
await check('image/jpg fallback applies the same 1600-pixel normalization as the ordinary single-image path',
    [{ stem: [pic('jpg-large', 2000, 1000)], options: [['one'], ['two']] }],
    { tainted: 'jpg-large', resources: { 'jpg-large': { type: 'image/jpg', width: 2000, height: 1000, bytes: 6675 } } }, f => {
        assert.equal(f.events.model, 1); const image = decodeFixture(f.payloads[0][0].images[0]);
        assert.equal(image.width, 1600); assert.equal(image.height, 800);
        assert.equal(f.canvases[1]._context.draws[0].sourceWidth, 2000);
        assert.deepEqual(f.canvases[1]._context.draws[0].bounds, [0, 0, 1600, 800]);
    });
await check('image/jpg fallback also retains all five numbered atlas images',
    [{ stem: [pic('jpg-atlas', 312, 132)], options: Array.from({ length: 4 }, (_, i) => [pic(`jpg-opt-${i}`)]) }],
    { tainted: 'jpg-atlas', resources: { 'jpg-atlas': { type: 'image/jpg', width: 312, height: 132, bytes: 6675 } } }, f => {
        assert.equal(f.events.model, 1); const atlas = decodeFixture(f.payloads[0][0].images[0]);
        assert.deepEqual(atlas.ids, ['jpg-atlas', 'jpg-opt-0', 'jpg-opt-1', 'jpg-opt-2', 'jpg-opt-3']);
        assert.deepEqual(atlas.labels.map(label => label.text), ['Image 1', 'Image 2', 'Image 3', 'Image 4', 'Image 5']);
    });
for (const initial of [[], ['A']]) {
    await check('platform single-choice uses empty/old hidden+class state and verifies the new state', [{ stem: ['fixture'], options: [['one'], ['two']] }],
        { auto: true, initial: [initial], answers: [['B']] }, f => {
            assert.equal(f.events.submit, 1); assert.equal(f.w.document.querySelector('#answer1000').value, 'B');
            assert.equal(f.w.document.querySelector('.choice1000.check_answer').textContent, 'B');
        });
}
await check('platform multi-choice prefix anchor reconciles stale selection', [{ kind: '多选题', stem: ['fixture'], options: [['one'], ['two'], ['three']] }],
    { auto: true, initial: [['A', 'B']], answers: [['A', 'C']] }, f => {
        assert.equal(f.events.submit, 1); assert.equal(f.w.document.querySelector('#answer1000').value, 'AC');
    });
await check('platform multi-choice hidden order may differ without changing its unique selection set',
    [{ kind: '多选题', stem: ['fixture'], options: [['one'], ['two'], ['three']] }],
    { auto: true, initial: [['A', 'C']], answers: [['A', 'C']], reverseSaved: true }, f => {
        assert.equal(f.events.submit, 1); assert.equal(f.w.document.querySelector('#answer1000').value, 'CA');
    });
await check('platform judgment maps visible A/B to true/false data without guessing', [{ kind: '判断题', stem: ['fixture'],
    optionData: ['true', 'false'], options: [['one'], ['two']] }], { auto: true, answers: [['B']] }, f => {
        assert.equal(f.events.submit, 1); assert.equal(f.w.document.querySelector('#answer1000').value, 'false');
    });
await check('platform class/hidden disagreement refuses selection and submit', [{ stem: ['fixture'], options: [['one'], ['two']] }],
    { auto: true, initialHiddenDrift: true, answers: [['B']] }, f => {
        assert.equal(f.events.submit, 0); assert.equal(f.events.click, 0);
        assert.match(f.w.__xuexitongManagedState.message, /保存字段不一致/);
    });
await check('single-choice multiple selected markers refuse any corrective click even when the hidden value matches AB',
    [{ stem: ['fixture'], options: [['one'], ['two']] }], { auto: true, initial: [['A', 'B']], answers: [['B']] }, f => {
        assert.equal(f.events.submit, 0); assert.equal(f.events.click, 0);
        assert.equal(f.w.document.querySelector('#answer1000').value, 'AB');
        assert.match(f.w.__xuexitongManagedState.message, /保存字段不一致/);
    });
for (const afterSelectionDrift of ['hidden', 'class', 'aria', 'pressed']) {
    await check(`platform ${afterSelectionDrift} drift after click refuses submit`, [{ stem: ['fixture'], options: [['one'], ['two']] }],
        { auto: true, afterSelectionDrift, answers: [['B']] }, f => {
            assert.equal(f.events.submit, 0); assert.equal(f.events.click, 1);
            assert.match(f.w.__xuexitongManagedState.message, /不一致|状态不明确|无法确认/);
        });
}
for (const [label, descriptors, config, expected] of [
    ['broken source', [{ stem: [pic('broken', 100, 40, { broken: true })], options: [['one'], ['two']] }], {}, /损坏|尚未加载/],
    ['broken atlas decoding', [pure(5)], { decodeFailure: 'opt-1' }, /IMAGE_DECODE/],
    ['bad encoded data', [pure(5)], { badEncoding: true }, /IMAGE_ENCODING/],
    ['unreadable cross-origin resource', [pure(5)], { tainted: 'opt-0' }, /IMAGE_FETCH/],
    ['oversized original would become unreadable', [{ stem: [pic('huge', 5000, 2000)], options: Array.from({ length: 4 }, (_, i) => [pic(`huge-${i}`)]) }], {}, /公式不可读/],
    ['too many atlas sheets', [{ stem: [pic('tall', 1000, 1500)], options: Array.from({ length: 3 }, (_, i) => [pic(`tall-${i}a`, 1000, 1500), pic(`tall-${i}b`, 1000, 1500)]) }], {}, /四张清晰图集/],
    ['atlas encoded size overflow', [pure(5)], { atlasOversize: true }, /IMAGE_SIZE_LIMIT/],
    ['single wire image size overflow', [{ stem: [pic('size')], options: [['one'], ['two']] }], { imageChars: 1600000 }, /图片过大/],
    ['request total image count overflow', Array.from({ length: 13 }, (_, i) => ({ stem: [pic(`budget-${i}`)], options: [['one'], ['two']] })), {}, /总数或总大小限制/],
    ['request total character size overflow', Array.from({ length: 6 }, (_, i) => ({ stem: [pic(`bytes-${i}`)], options: [['one'], ['two']] })), { imageChars: 1400000 }, /总数或总大小限制/],
    ['empty canvas data', [{ stem: [pic('empty')], options: [['one'], ['two']] }], { emptyEncoding: true }, /IMAGE_ENCODING.*question=1.*image=1.*chars=6/],
    ['fallback decoded aspect mismatch', [{ stem: [pic('ratio', 312, 132)], options: [['one'], ['two']] }],
        { tainted: 'ratio', resources: { ratio: { type: 'image/jpg', width: 624, height: 400, bytes: 6675 } } }, /IMAGE_ASPECT_RATIO/],
    ['fallback decoded resolution loss', [{ stem: [pic('small', 312, 132)], options: [['one'], ['two']] }],
        { tainted: 'small', resources: { small: { type: 'image/jpg', width: 156, height: 66, bytes: 6675 } } }, /IMAGE_RESOLUTION/],
    ['fallback raw blob size overflow', [{ stem: [pic('blob-limit')], options: [['one'], ['two']] }],
        { tainted: 'blob-limit', resources: { 'blob-limit': { type: 'image/jpg', width: 240, height: 60, bytes: 1000001 } } }, /IMAGE_FETCH_SIZE.*bytes=1000001/],
    ['unsupported fallback MIME instead of treating it as the JPEG alias', [{ stem: [pic('bad-mime')], options: [['one'], ['two']] }],
        { tainted: 'bad-mime', resources: { 'bad-mime': { type: 'image/gif', width: 240, height: 60, bytes: 6675 } } }, /IMAGE_MIME/],
]) {
    await check(`reject ${label} before fake model without writes`, descriptors, config, f => {
        const failures = f.logs.filter(log => log.includes('答案预览失败'));
        assert.equal(f.events.model, 0); assert.ok(f.logs.some(log => expected.test(log)), `clear failure category: ${failures.join(' | ')}`);
        assert.ok(failures.every(log => !log.includes('fixture.invalid') && !log.includes('data:image')), 'failure diagnostics do not reveal URLs or encoded image bytes');
    });
}
console.log(`All ${groups} choice-image fixture groups passed. Canvas is simulated; zero real model or platform requests.`);
