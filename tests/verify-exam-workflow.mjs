import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { loadBrowserEngine } from '../automation/browser-driver.mjs';
import { runExam } from '../automation/exam-runner.mjs';
import { ExamPage } from '../automation/exam-page.mjs';
import { examHtml, identity } from './fixtures/exam/page.mjs';

await mkdir(resolve(import.meta.dirname, '../.tmp'), { recursive: true });
const root = await mkdtemp(resolve(import.meta.dirname, '../.tmp/exam-tests-'));
const engine = await loadBrowserEngine(), browser = await engine.chromium.launch({ channel: 'msedge', headless: true });
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log('PASS ' + name); }
async function fixture(options = {}) {
    const state = { checked: false, saved: {}, entered: 0, resultVisits: 0, posts: 0, external: 0, ...options };
    const context = await browser.newContext({ serviceWorkers: 'block' });
    await context.setOffline(true);
    await context.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.hostname !== 'fixture.chaoxing.com') { state.external++; return route.abort(); }
        if (url.pathname.endsWith('/preview-save')) {
            state.posts++;
            if (!state.saveFailure && !state.dropWrites) {
                const body = route.request().postDataJSON(); state.saved[body.key] = body.value;
            }
            return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ status: state.saveFailure ? 'error' : 'success' }) });
        }
        let phase = 'entry';
        if (url.pathname.endsWith('reVersionTestStartNew')) { phase = 'exam'; state.entered++; }
        if (url.pathname === '/exam-ans/mooc2/exam/preview') phase = 'exam';
        if (url.pathname.endsWith('/look')) { phase = 'result'; state.resultVisits++; }
        return route.fulfill({ contentType: 'text/html; charset=utf-8', body: examHtml(state, phase) });
    });
    const page = await context.newPage();
    await page.goto('https://fixture.chaoxing.com/exam-ans/exam/entry?examId=offline-exam');
    let calls = 0;
    const requester = async (questions, _, deps) => {
        calls++; deps.onMeta({ model: 'offline', credit: 0 });
        return questions.map(q => q.type === '填空题' ? { id: q.id, texts: ['nine'] } :
            { id: q.id, letters: q.type === '多选题' ? ['A', 'C'] : ['B'] });
    };
    return { state, context, page, requester, get calls() { return calls; } };
}
const execute = (f, directory, options = {}) => runExam({ page: f.page, identity, directory, requester: f.requester, ...options });
try {
    await test('all five button actions plus choice, multi, editor, persistence and immediate notice', async () => {
        const f = await fixture(), order = [], directory = join(root, 'complete');
        try {
            const result = await execute(f, directory, {
                onCompletion: async row => { order.push('notice'); assert.equal(row.submitted, true); },
                archive: async () => { assert.deepEqual(order, ['notice']); order.push('archive'); },
            });
            assert.equal(result.score, 96); assert.equal(result.phase, 'reported'); assert.equal(f.calls, 1);
            assert.equal(result.modelCalls, 1); assert.equal(result.observedCredit, 0); assert.equal(result.persistedAnswers, 3);
            assert.deepEqual(f.state.saved, { one: 'Y', two: 'XV', word: 'nine' });
            assert.equal(f.state.external, 0);
            const checkpoint = JSON.parse(await readFile(join(directory, 'exam-checkpoint.json'), 'utf8'));
            assert.deepEqual(checkpoint.actions.map(row => row.action), ['consent', 'entry', 'entry-confirm', 'submit', 'submit-confirm']);
            assert.ok(checkpoint.actions.every(row => row.actor === 'automation'));
            assert.equal(checkpoint.persisted.answers, 3);
            const visits = f.state.resultVisits;
            await execute(f, directory, { onCompletion: () => { throw new Error('must not notify twice'); } });
            assert.equal(f.state.resultVisits, visits); assert.equal(f.calls, 1);
        } finally { await f.context.close(); }
    });
    await test('already checked consent is not toggled, hidden names do not interfere', async () => {
        const f = await fixture({ checked: true });
        try {
            const api = new ExamPage(f.page, identity);
            const result = await api.click('consent');
            assert.equal(result.performed, false); assert.equal(result.state.consent[0].checked, true);
            await api.click('entry'); assert.equal((await api.observe()).kind, 'entry-confirmation');
        } finally { await f.context.close(); }
    });
    await test('two audio materials flow through download, parallel ASR, model, fill and reload', async () => {
        const f = await fixture({ audio: true });
        let active = 0, maximum = 0, downloads = 0;
        try {
            const result = await execute(f, join(root, 'with-audio'), { listening: {
                modelIdentity: 'offline-asr', concurrency: 2,
                fetchImpl: async url => { downloads++; return new Response('fake local sound ' + url.pathname, { headers: { 'content-type': 'audio/wav' } }); },
                transcriber: async () => {
                    active++; maximum = Math.max(maximum, active);
                    await new Promise(resolve => setTimeout(resolve, 30)); active--;
                    return { schemaVersion: 1, engine: 'faster-whisper', language: 'en', duration: 12,
                        segments: [{ start: 0, end: 8, text: 'Question one. What time does it open?', avgLogprob: -0.1, noSpeechProb: 0.01 }] };
                },
            } });
            assert.equal(result.submitted, true); assert.equal(result.fullyAutomated, true);
            assert.equal(downloads, 2); assert.equal(maximum, 2); assert.equal(f.calls, 2);
            assert.equal(f.state.saved.soundone, 'Q'); assert.equal(f.state.saved.soundtwo, 'Q');
            const checkpoint = JSON.parse(await readFile(join(root, 'with-audio/exam-checkpoint.json'), 'utf8'));
            assert.equal(checkpoint.persisted.answers, 5);
        } finally { await f.context.close(); }
    });
    await test('wrong exam identity prevents every click', async () => {
        const f = await fixture();
        try {
            await assert.rejects(new ExamPage(f.page, { ...identity, examId: 'another' }).click('entry'), /IDENTITY/);
            assert.equal(f.state.entered, 0); assert.equal(f.state.posts, 0);
        } finally { await f.context.close(); }
    });
    await test('overview popup becomes the current paper before any answer is requested', async () => {
        const f = await fixture({ overviewPopup: true });
        try {
            const result = await execute(f, join(root, 'popup-overview'));
            assert.equal(result.submitted, true); assert.equal(f.context.pages().length, 2);
            assert.equal(new URL(f.page.url()).pathname, '/exam-ans/exam/test/reVersionTestStartNew');
        } finally { await f.context.close(); }
    });
    await test('unconfirmed whole-paper range blocks before a model call', async () => {
        const f = await fixture({ noOverview: true });
        try {
            await assert.rejects(execute(f, join(root, 'no-overview')), /WHOLE_PAPER/);
            assert.equal(f.calls, 0); assert.equal(f.state.resultVisits, 0); assert.equal(f.state.posts, 0);
        } finally { await f.context.close(); }
    });
    await test('save rejection retains answers and resume does not call the model again', async () => {
        const f = await fixture({ saveFailure: true }), directory = join(root, 'save-retry');
        try {
            await assert.rejects(execute(f, directory), /SAVE_NOT_CONFIRMED/);
            assert.equal(f.state.resultVisits, 0); assert.equal(f.calls, 1);
            f.state.saveFailure = false;
            await execute(f, directory);
            assert.equal(f.calls, 1); assert.equal(f.state.resultVisits, 1);
        } finally { await f.context.close(); }
    });
    await test('successful save response without persistent values prevents submission', async () => {
        const f = await fixture({ dropWrites: true });
        try {
            await assert.rejects(execute(f, join(root, 'drop-writes')), /PERSISTED_ANSWERS_MISMATCH/);
            assert.equal(f.state.resultVisits, 0);
        } finally { await f.context.close(); }
    });
    await test('ambiguous final dialog is rejected without submitting', async () => {
        const f = await fixture({ ambiguous: true });
        try {
            await assert.rejects(execute(f, join(root, 'ambiguous')), /CONTROL_AMBIGUOUS_submit-confirm/);
            assert.equal(f.state.resultVisits, 0);
        } finally { await f.context.close(); }
    });
} finally { await browser.close(); await rm(root, { recursive: true, force: true }); }
console.log('All ' + passed + ' offline Edge exam workflow groups passed; no real platform or model.');
