// Synthetic practice only; all browser requests are intercepted. No platform/account calls.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateManifest, validateTranscript, buildListeningQuestions, previewPractice } from '../listening/practice.mjs';
import { validateAudioUrl, fetchPracticeAudio } from '../listening/fetch-audio.mjs';
const { JSDOM, VirtualConsole } = await import('jsdom').catch(() => import(new URL('../node_modules/jsdom/lib/api.js', import.meta.url)));
const source = readFileSync(new URL('../deepseek-console/xuexitong-console.js', import.meta.url), 'utf8')
    .replace(/const LOCAL_TOKEN = '[^']*';/, "const LOCAL_TOKEN = 'offline-listening';");
let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log(`PASS ${name}`); };
const q = id => ({ id, type: '单选题', question: 'When does the library open?', options: [{ letter: 'A', text: 'Eight' }, { letter: 'B', text: 'Nine' }] });
const manifest = () => ({ schemaVersion: 1, purpose: 'listening-practice', questions: [q(1), q(2)],
    audio: [{ id: 'clip', questionIds: [1, 2], path: 'clip.wav' }], unresolved: [] });
const transcript = () => ({ schemaVersion: 1, engine: 'faster-whisper', language: 'en', duration: 8,
    segments: [{ start: 0, end: 5, text: 'The library opens at nine in the morning.', avgLogprob: -0.1, noSpeechProb: 0.01, words: [] }] });
async function browserFixture({ shared = false, frame = false, empty = false, missing = false } = {}) {
    const audio = empty ? '<audio></audio>' : frame ? '<iframe src="https://other.invalid/audio.html"></iframe>' : '<audio src="https://fixture.invalid/listening.wav" preload="none"></audio>';
    const card = id => `<div class="singleQuesId"><h3>${id}.【单选题】Listen and choose the opening time.</h3>
        ${!shared && !missing ? audio : ''}<ul><li><span>A</span>Eight<input type="radio" name="q${id}"></li>
        <li><span>B</span>Nine<input type="radio" name="q${id}"></li></ul></div>`;
    const logs = [], virtualConsole = new VirtualConsole();
    for (const name of ['error', 'warn', 'log']) virtualConsole.on(name, (...args) => logs.push(args.map(String).join(' ')));
    const dom = new JSDOM(`<body>${shared ? audio : ''}${card(1)}${card(2)}<button>提交</button></body>`, {
        url: 'https://mooc1.chaoxing.com/mooc-ans/mooc2/work/dowork?workId=offline-listening',
        runScripts: 'outside-only', virtualConsole, pretendToBeVisual: true });
    const w = dom.window, events = { requests: 0, clicks: 0, plays: 0 };
    Object.defineProperty(w.HTMLElement.prototype, 'innerText', { configurable: true, get() { return this.textContent; } });
    w.Element.prototype.getClientRects = () => [{ width: 100, height: 10 }];
    w.HTMLMediaElement.prototype.play = async () => { events.plays++; };
    w.document.addEventListener('click', () => events.clicks++);
    w.AbortSignal.timeout = () => new w.AbortController().signal;
    w.fetch = async url => {
        if (url.endsWith('/health')) return { ok: true };
        events.requests++; throw new Error('No answer or audio network permitted by fixture');
    };
    w.eval(source);
    for (let i = 0; i < 50 && !w.app; i++) await new Promise(resolve => setTimeout(resolve, 2));
    assert.ok(w.app);
    return { w, dom, events, logs };
}

await test('question-local audio deduplicates and maps exactly without DOM mutation', async () => {
    const f = await browserFixture();
    try {
        const before = f.w.document.body.outerHTML;
        const data = JSON.parse(JSON.stringify(f.w.app.exportListeningPractice()));
        assert.equal(data.questions.length, 2); assert.equal(data.audio.length, 1);
        assert.deepEqual(data.audio[0].questionIds, [1, 2]); assert.deepEqual(data.unresolved, []);
        assert.equal(data.audio[0].path, ''); assert.ok(data.audio[0].sourceUrl.startsWith('https://'));
        const summary = JSON.stringify(f.w.app.inspectListening());
        assert.ok(!summary.includes('fixture.invalid'));
        assert.equal(f.w.document.body.outerHTML, before);
        assert.deepEqual(f.events, { requests: 0, clicks: 0, plays: 0 });
    } finally { f.dom.window.close(); }
});
for (const config of [{ shared: true }, { frame: true }, { empty: true }, { missing: true }]) {
    await test(`unresolved mapping is explicit: ${JSON.stringify(config)}`, async () => {
        const f = await browserFixture(config);
        try { assert.ok(f.w.app.inspectListening().unresolved.length); assert.deepEqual(f.events, { requests: 0, clicks: 0, plays: 0 }); }
        finally { f.dom.window.close(); }
    });
}
await test('ordinary preview refuses to guess before sending a listening question', async () => {
    const f = await browserFixture();
    try {
        await f.w.app.previewQuiz();
        assert.equal(f.events.requests, 0); assert.equal(f.events.clicks, 0); assert.equal(f.events.plays, 0);
        assert.ok(f.logs.some(line => line.includes('LISTENING_REQUIRES_TRANSCRIPT')));
    } finally { f.dom.window.close(); }
});
await test('timestamped transcript reaches only mapped questions', async () => {
    const data = manifest();
    data.audio = [{ id: 'clip', questionIds: [1], path: 'clip.wav' }, { id: 'second', questionIds: [2], path: 'second.wav' }];
    const second = transcript(); second.segments[0].text = 'The museum opens at ten.';
    const questions = buildListeningQuestions(data, { clip: transcript(), second });
    assert.ok(questions[0].question.includes('library opens at nine'));
    assert.ok(!questions[0].question.includes('museum opens'));
    assert.ok(questions[1].question.includes('museum opens at ten'));
});
await test('bad, missing and duplicate mappings are refused', async () => {
    for (const modify of [m => m.unresolved.push({ reason: 'shared' }), m => m.audio[0].questionIds = [1],
        m => m.audio[0].questionIds = [1, 3], m => m.audio.push({ ...m.audio[0] }), m => m.audio[0].questionIds = [1, 1],
        m => m.purpose = 'oral-upload', m => m.audio[0].path = '../private.wav', m => m.audio[0].path = 'https://example.com/a.wav']) {
        const data = manifest(); modify(data); assert.throws(() => validateManifest(data));
    }
});
await test('empty, low confidence and invalid timestamp ASR fails closed', async () => {
    for (const modify of [t => t.segments = [], t => t.segments[0].text = '', t => t.segments[0].avgLogprob = -1.5,
        t => t.segments[0].noSpeechProb = 0.9, t => t.segments[0].end = 99, t => t.duration = 1300]) {
        const data = transcript(); modify(data); assert.throws(() => validateTranscript(data));
    }
});
await test('audio source rejects unapproved hosts, credentials and insecure transport', async () => {
    for (const value of ['http://pan.chaoxing.com/a.mp3', 'https://chaoxing.com.evil.invalid/a.mp3',
        'https://user:password@pan.chaoxing.com/a.mp3', 'https://127.0.0.1/a.mp3', 'https://pan.chaoxing.com:999/a.mp3'])
        assert.throws(() => validateAudioUrl(value));
    assert.equal(validateAudioUrl('https://pan.chaoxing.com/a.mp3').hostname, 'pan.chaoxing.com');
    assert.equal(validateAudioUrl('https://cdn.example.org/a.mp3', ['cdn.example.org']).hostname, 'cdn.example.org');
});
const tempRoot = fileURLToPath(new URL('../.tmp/', import.meta.url));
await mkdir(tempRoot, { recursive: true });
const temp = await mkdtemp(join(tempRoot, 'listening-fixture-'));
try {
    await writeFile(join(temp, 'clip.wav'), Buffer.from('offline-audio-placeholder'));
    await test('local pipeline defaults to ASR only and never calls the model', async () => {
        let calls = 0;
        const result = await previewPractice(manifest(), { baseDir: temp, transcriber: async () => transcript(), requester: async () => { calls++; } });
        assert.equal(calls, 0); assert.equal(result.phase, 'transcribed'); assert.equal(result.submitted, false);
        assert.match(result.audio[0].sha256, /^[a-f0-9]{64}$/);
        assert.ok(!JSON.stringify(result).includes('clip.wav'));
    });
    await test('explicit answer preview receives transcript and records usage', async () => {
        let calls = 0;
        const result = await previewPractice(manifest(), { baseDir: temp, answer: true, transcriber: async () => transcript(),
            requester: async (questions, _, deps) => {
                calls++; assert.ok(questions.every(q => q.question.includes('library opens at nine')));
                deps.onMeta({ model: 'fixture', credit: 0 }); return questions.map(q => ({ id: q.id, letters: ['B'] }));
            } });
        assert.equal(calls, 1); assert.equal(result.phase, 'answers-previewed'); assert.equal(result.submitted, false);
    });
    await test('ASR failure prevents paid model call', async () => {
        let calls = 0;
        await assert.rejects(previewPractice(manifest(), { baseDir: temp, answer: true,
            transcriber: async () => ({ ...transcript(), segments: [] }), requester: async () => { calls++; } }));
        assert.equal(calls, 0);
    });
    await test('download saves local manifest and removes signed source URLs', async () => {
        const data = manifest(); data.audio[0].sourceUrl = 'https://pan.chaoxing.com/a.wav?signature=offline-test';
        const destination = join(temp, 'downloaded'); let calls = 0;
        const local = await fetchPracticeAudio(data, destination, { fetchImpl: async (_, options) => {
            calls++; assert.equal(options.redirect, 'manual'); assert.equal(options.credentials, 'omit');
            return new Response(Buffer.from('offline-wave-placeholder'), { headers: { 'content-type': 'audio/wav' } });
        } });
        assert.equal(calls, 1); assert.ok(!JSON.stringify(local).includes('signature'));
        validateManifest(local);
        assert.ok(readFileSync(join(destination, 'clip.wav')).length);
        await assert.rejects(fetchPracticeAudio(data, destination, { fetchImpl: () => { throw new Error('must not fetch'); } }));
    });
    await test('unresolved mapping blocks before fetching audio', async () => {
        const data = manifest(); data.unresolved.push({ reason: 'unknown-map' }); let calls = 0;
        await assert.rejects(fetchPracticeAudio(data, join(temp, 'must-not-download'), { fetchImpl: async () => { calls++; } }));
        assert.equal(calls, 0);
    });
    await test('redirect, HTML, empty and oversized audio responses fail before ASR', async () => {
        const responses = [
            () => new Response(null, { status: 302, headers: { location: 'https://unapproved.invalid' } }),
            () => new Response('login', { headers: { 'content-type': 'text/html' } }),
            () => new Response('', { headers: { 'content-type': 'audio/wav' } }),
            () => new Response('small', { headers: { 'content-type': 'audio/wav', 'content-length': String(31 * 1024 * 1024) } }),
        ];
        for (const [index, response] of responses.entries()) {
            const data = manifest(); data.audio[0].sourceUrl = 'https://pan.chaoxing.com/a.wav';
            const destination = join(temp, `bad-response-${index}`);
            await assert.rejects(fetchPracticeAudio(data, destination, { fetchImpl: async () => response() }));
            assert.throws(() => readFileSync(join(destination, 'practice.json')));
        }
    });
} finally { await rm(temp, { recursive: true, force: true }); }
console.log(`All ${passed} listening groups passed; no real platform or model requests.`);
