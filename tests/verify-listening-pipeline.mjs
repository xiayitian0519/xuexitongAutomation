import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { prepareListening } from '../listening/pipeline.mjs';
import { mergeRepair, repairRanges } from '../listening/transcript-repair.mjs';
import { checkCoverage, inspectTranscript } from '../listening/contracts.mjs';

const root = resolve(import.meta.dirname, '../.tmp');
await mkdir(root, { recursive: true });
const temp = await mkdtemp(join(root, 'pipeline-test-'));
const question = id => ({ id, type: '单选题', question: 'When does the library open?',
    options: [{ letter: 'A', text: 'Eight' }, { letter: 'B', text: 'Nine' }] });
const manifest = count => ({ schemaVersion: 1, purpose: 'listening-practice',
    questions: Array.from({ length: count }, (_, i) => question(i + 1)),
    audio: Array.from({ length: count }, (_, i) => ({ id: 'clip' + i, path: 'audio' + i + '.wav', questionIds: [i + 1] })), unresolved: [] });
const segment = (start, end, text = 'The library opens at nine.') => ({ start, end, text, avgLogprob: -0.1, noSpeechProb: 0.01, words: [] });
const good = () => ({ schemaVersion: 1, engine: 'faster-whisper', language: 'en', duration: 60,
    segments: [segment(0, 5), segment(20, 25, 'Question two. What time does it open?'), segment(50, 55)] });
const bad = () => { const value = good(); value.segments[1].noSpeechProb = 0.8; return value; };
const clip = range => ({ schemaVersion: 1, engine: 'faster-whisper', language: 'en',
    duration: range.end - range.start, sourceDuration: 60, offsetSeconds: range.start,
    segments: [segment(20 - range.start, 25 - range.start, 'Question two. What time does it open?')] });
let count = 0;
async function test(name, fn) { await fn(); console.log('PASS ' + name); count++; }
const options = name => ({ baseDir: temp, cacheDir: join(temp, name), modelIdentity: 'offline-model' });
for (let i = 0; i < 2; i++) await writeFile(join(temp, 'audio' + i + '.wav'), 'unique-synthetic-' + i);
try {
    await test('two jobs overlap; concurrency is bounded to two', async () => {
        let active = 0, max = 0, calls = 0;
        const result = await prepareListening(manifest(2), { ...options('parallel'), concurrency: 2,
            transcriber: async () => { active++; calls++; max = Math.max(max, active); await new Promise(r => setTimeout(r, 30)); active--; return good(); } });
        assert.equal(max, 2); assert.equal(calls, 2); assert.equal(result.audio.length, 2);
    });
    await test('same audio hash is decoded once for multiple references', async () => {
        const data = manifest(2); data.audio[1].path = data.audio[0].path; let calls = 0;
        await prepareListening(data, { ...options('dedup'), concurrency: 2, transcriber: async () => { calls++; return good(); } });
        assert.equal(calls, 1);
    });
    await test('raw failure is retained and only the uncertain interval is repaired', async () => {
        const ranges = [], events = [];
        const result = await prepareListening(manifest(1), { ...options('repair'), onEvent: e => events.push(e.phase),
            transcriber: async (_, o) => { if (!o.range) return bad(); ranges.push(o.range); return clip(o.range); } });
        assert.equal(ranges.length, 1); assert.ok(ranges[0].start > 0 && ranges[0].end < 60);
        assert.ok(events.indexOf('asr-raw-saved') < events.indexOf('asr-repair-started'));
        assert.deepEqual(result.audio[0].segments[0], good().segments[0]);
        assert.deepEqual(result.audio[0].segments.at(-1), good().segments.at(-1));
        const dir = join(temp, 'repair', (await readdir(join(temp, 'repair')))[0]);
        const state = JSON.parse(await readFile(join(dir, 'checkpoint.json'), 'utf8'));
        const raw = JSON.parse(await readFile(join(dir, state.raw.file), 'utf8'));
        assert.equal(raw.transcript.segments[1].noSpeechProb, 0.8);
        assert.ok(inspectTranscript(result.audio[0]).ok);
    });
    await test('cache avoids ASR; parameter and model changes invalidate it', async () => {
        let calls = 0; const transcriber = async () => { calls++; return good(); };
        const opts = { ...options('cache'), transcriber };
        await prepareListening(manifest(1), opts); const cached = await prepareListening(manifest(1), opts);
        assert.equal(calls, 1); assert.equal(cached.audio[0].cached, true);
        await prepareListening(manifest(1), { ...opts, threads: 2 });
        await prepareListening(manifest(1), { ...opts, modelIdentity: 'new-model' });
        assert.equal(calls, 3);
    });
    await test('interrupted repair resumes raw instead of repeating the full audio', async () => {
        let fullCalls = 0, repairCalls = 0;
        const transcriber = async (_, o) => {
            if (!o.range) { fullCalls++; return bad(); }
            repairCalls++; if (repairCalls === 1) throw new Error('SIMULATED_INTERRUPTION');
            return clip(o.range);
        };
        const opts = { ...options('resume'), transcriber };
        await assert.rejects(prepareListening(manifest(1), opts));
        await prepareListening(manifest(1), opts);
        assert.equal(fullCalls, 1); assert.equal(repairCalls, 2);
    });
    await test('missing audio question is found and repaired before answering', async () => {
        const data = manifest(1);
        data.audio[0].expectations = [{ questionId: 1, source: 'audio', cue: 'Question two', start: 20, end: 25 }];
        const incomplete = good(); incomplete.segments[1].text = 'The conversation ends.';
        assert.equal(checkCoverage(data.audio[0], data.questions, incomplete).ok, false);
        let repairs = 0;
        const result = await prepareListening(data, { ...options('coverage'), transcriber: async (_, o) => {
            if (!o.range) return incomplete; repairs++; return clip(o.range);
        } });
        assert.equal(repairs, 1); assert.ok(checkCoverage(data.audio[0], data.questions, result.audio[0]).ok);
    });
    await test('page question need not be repeated in the audio', async () => {
        const data = manifest(1); data.audio[0].expectations = [{ questionId: 1, source: 'page' }];
        assert.equal(checkCoverage(data.audio[0], data.questions, good()).ok, true);
    });
    await test('numbered audio questions require a real question after the number', async () => {
        const data = manifest(1); data.audio[0].expectations = [{ questionId: 1, source: 'audio', number: 2 }];
        assert.equal(checkCoverage(data.audio[0], data.questions, good()).ok, true);
        const missing = good(); missing.segments[1].text = 'Question two.';
        const coverage = checkCoverage(data.audio[0], data.questions, missing);
        assert.equal(coverage.ok, false);
        assert.equal(coverage.problems[0].start, 20);
        assert.equal(coverage.problems[0].end, 60);
    });
    await test('duplicate audio references include every question in the repair checks', async () => {
        const data = manifest(2); data.audio[1].path = data.audio[0].path;
        data.audio[1].expectations = [{ questionId: 2, source: 'audio', cue: 'Question two', start: 20, end: 25 }];
        const incomplete = good(); incomplete.segments[1].text = 'The conversation ends.';
        let fullCalls = 0, repairs = 0;
        await prepareListening(data, { ...options('dedup-coverage'), transcriber: async (_, o) => {
            if (!o.range) { fullCalls++; return incomplete; } repairs++; return clip(o.range);
        } });
        assert.equal(fullCalls, 1); assert.equal(repairs, 1);
    });
    await test('a corrupt completed cache is rejected instead of silently accepted or re-run', async () => {
        const opts = { ...options('corrupt'), transcriber: async () => good() };
        await prepareListening(manifest(1), opts);
        const dir = join(temp, 'corrupt', (await readdir(join(temp, 'corrupt')))[0]);
        const state = JSON.parse(await readFile(join(dir, 'checkpoint.json'), 'utf8'));
        await writeFile(join(dir, state.final.ref.file), '{}');
        await assert.rejects(prepareListening(manifest(1), opts), /CACHE_CONTENT_INVALID/);
    });
    await test('unknown missing-question range blocks instead of guessing', async () => {
        const data = manifest(1); data.audio[0].expectations = [{ questionId: 1, source: 'audio', cue: 'never spoken' }];
        let calls = 0;
        await assert.rejects(prepareListening(data, { ...options('unknown-range'), transcriber: async () => { calls++; return good(); } }), /RANGE_UNKNOWN/);
        assert.equal(calls, 1);
    });
    await test('two unsuccessful local rounds stop and remain stopped on resume', async () => {
        let calls = 0;
        const opts = { ...options('bounded'), transcriber: async (_, o) => {
            calls++; if (!o.range) return bad(); const value = clip(o.range); value.segments[0].noSpeechProb = 0.9; return value;
        } };
        await assert.rejects(prepareListening(manifest(1), opts), /NEEDS_REVIEW/);
        await assert.rejects(prepareListening(manifest(1), opts), /NEEDS_REVIEW/);
        assert.equal(calls, 3);
    });
    await test('global timestamp corruption does not trigger arbitrary clip retries', async () => {
        let calls = 0;
        await assert.rejects(prepareListening(manifest(1), { ...options('global'), transcriber: async () => {
            calls++; const value = good(); value.segments[0].end = 90; return value;
        } }), /GLOBAL_FAILURE/);
        assert.equal(calls, 1);
    });
    await test('invalid range offsets and overlapping base timestamps fail', async () => {
        const range = { start: 17, end: 28 }, wrong = clip(range); wrong.offsetSeconds = 0;
        assert.throws(() => mergeRepair(bad(), wrong, range), /OFFSET/);
        const wrongTime = good(); wrongTime.segments[1].start = 0;
        assert.throws(() => repairRanges(wrongTime, { problems: [] }), /GLOBAL/);
    });
    await test('preflight all files before ASR, and abort prevents queued starts', async () => {
        let calls = 0; const data = manifest(2); data.audio[1].path = 'missing.wav';
        await assert.rejects(prepareListening(data, { ...options('preflight'), transcriber: async () => { calls++; return good(); } }));
        assert.equal(calls, 0);
        const controller = new AbortController();
        await assert.rejects(prepareListening(manifest(2), { ...options('cancel'), signal: controller.signal,
            transcriber: async () => { calls++; controller.abort(); return good(); } }), /ABORTED/);
        assert.equal(calls, 1);
    });
} finally { await rm(temp, { recursive: true, force: true }); }
console.log('All ' + count + ' listening pipeline groups passed; no network or paid model.');
