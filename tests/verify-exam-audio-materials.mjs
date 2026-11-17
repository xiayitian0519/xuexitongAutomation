import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { prepareExamListening } from '../automation/exam-materials.mjs';
import { validQuestions } from '../deepseek-console/answer-contract.mjs';

// Anonymous in-memory responses and transcripts only. This test does not open a
// browser, contact a server, decode real audio, or invoke a paid model.
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';
const question = id => ({ id, type: '单选题', question: 'Passage sample. Question ' + id,
    options: [{ letter: 'A', text: 'One' }, { letter: 'B', text: 'Two' }] });
function snapshot() {
    const listeningIds = [1, 3, 4, 6];
    return {
        fingerprint: 'synthetic-audio-image-paper',
        questions: Array.from({ length: 6 }, (_, index) => ({ ...question(index + 1),
            ...(listeningIds.includes(index + 1) ? { images: [png, png, png, png] } : {}) })),
        map: Array.from({ length: 6 }, (_, index) => {
            const id = index + 1, local = listeningIds.indexOf(id), first = local < 2;
            return { id, audioIds: local < 0 ? [] : [first ? 'audio-a' : 'audio-b'],
                pageQuestion: false, audioNumber: local % 2 + 1 };
        }),
        audio: [
            { id: 'audio-a', sourceUrl: 'https://pan.chaoxing.com/fixture-a.wav?signature=fixture-only', questionIds: [1, 3] },
            { id: 'audio-b', sourceUrl: 'https://pan.chaoxing.com/fixture-b.wav?signature=fixture-only', questionIds: [4, 6] },
        ],
    };
}
const transcript = label => ({ schemaVersion: 1, engine: 'faster-whisper', language: 'en', duration: 20,
    segments: [
        { start: 0, end: 5, text: label + '. Question one. What is the first number?', avgLogprob: -0.1, noSpeechProb: 0.01 },
        { start: 10, end: 15, text: 'Question two. Which number follows the first?', avgLogprob: -0.1, noSpeechProb: 0.01 },
    ] });
const tempRoot = resolve(import.meta.dirname, '../.tmp');
await mkdir(tempRoot, { recursive: true });
const temp = await mkdtemp(join(tempRoot, 'exam-audio-materials-'));
let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log('PASS ' + name); };

function environment(directory) {
    const counters = { fetch: 0, transcribe: 0, active: 0, maxActive: 0 }, events = [];
    const options = { directory, enabled: true, concurrency: 2, modelIdentity: 'offline-audio-materials-v1',
        fetchImpl: async url => {
            counters.fetch++;
            const label = String(url).includes('fixture-a.wav') ? 'first-fixture-audio' : 'second-fixture-audio';
            return new Response(Buffer.from(label), { status: 200, headers: { 'Content-Type': 'audio/wav' } });
        },
        transcriber: async (file, opts) => {
            assert.equal(opts.range, undefined);
            counters.transcribe++; counters.active++;
            counters.maxActive = Math.max(counters.maxActive, counters.active);
            try {
                await new Promise(resolve => setTimeout(resolve, 25));
                return transcript(file.endsWith('audio-a.wav') ? 'FIRST_SOURCE' : 'SECOND_SOURCE');
            } finally { counters.active--; }
        },
        onEvent: event => { events.push(event); },
    };
    return { options, counters, events };
}

try {
    const paper = snapshot(), env = environment(join(temp, 'normal'));
    let groups;
    await test('sixteen listening images split into legal model batches without losing attachments', async () => {
        groups = await prepareExamListening(paper, env.options);
        assert.equal(groups.length, 2);
        assert.deepEqual(groups.map(group => group.sourceIds), [[1, 3, 4], [6]]);
        assert.ok(groups.every(group => validQuestions(group.questions)));
        assert.equal(groups.reduce((sum, group) => sum + group.questions.reduce((n, q) => n + q.images.length, 0), 0), 16);
        for (const group of groups) for (const [index, q] of group.questions.entries()) {
            const original = paper.questions[group.sourceIds[index] - 1];
            assert.deepEqual(q.images, original.images);
            assert.equal(q.id, index + 1);
        }
    });
    await test('ASR material manifest omits attachments and preserves exact two-source numbering', async () => {
        const materialDirs = (await readdir(env.options.directory)).filter(name => name.startsWith('materials-'));
        assert.equal(materialDirs.length, 1);
        const local = JSON.parse(await readFile(join(env.options.directory, materialDirs[0], 'practice.json'), 'utf8'));
        assert.equal(local.questions.length, 4);
        assert.ok(local.questions.every(q => q.images === undefined));
        assert.deepEqual(local.audio.map(audio => audio.questionIds), [[1, 2], [3, 4]]);
        assert.deepEqual(local.audio.map(audio => audio.expectations.map(row => [row.questionId, row.source, row.number])),
            [[[1, 'audio', 1], [2, 'audio', 2]], [[3, 'audio', 1], [4, 'audio', 2]]]);
        assert.ok(local.audio.every(audio => audio.sourceUrl === undefined));
    });
    await test('two audio jobs overlap while transcripts stay with their own source questions', async () => {
        assert.equal(env.counters.fetch, 2); assert.equal(env.counters.transcribe, 2); assert.equal(env.counters.maxActive, 2);
        for (const group of groups) for (const [index, q] of group.questions.entries()) {
            const originalId = group.sourceIds[index], first = [1, 3].includes(originalId);
            assert.ok(q.question.includes(first ? 'FIRST_SOURCE' : 'SECOND_SOURCE'));
            assert.equal(q.question.includes(first ? 'SECOND_SOURCE' : 'FIRST_SOURCE'), false);
        }
        assert.ok(env.events.some(row => row.phase === 'asr-ready'));
    });
    await test('cache recovery performs zero additional downloads or transcriptions and returns every image', async () => {
        const restored = await prepareExamListening(paper, env.options);
        assert.equal(env.counters.fetch, 2); assert.equal(env.counters.transcribe, 2);
        assert.ok(restored.every(group => group.materialStats.cacheHits === 2));
        assert.deepEqual(restored.map(group => group.questions), groups.map(group => group.questions));
        assert.ok(env.events.some(row => row.phase === 'asr-cache-hit'));
    });
    await test('rotated source downloads once again but identical bytes reuse completed ASR', async () => {
        const rotated = snapshot();
        rotated.audio.forEach(audio => { audio.sourceUrl = audio.sourceUrl.replace('fixture-only', 'fixture-rotated'); });
        const restored = await prepareExamListening(rotated, env.options);
        assert.equal(env.counters.fetch, 4); assert.equal(env.counters.transcribe, 2);
        assert.ok(restored.every(group => group.materialStats.cacheHits === 2));
        assert.deepEqual(restored.map(group => group.sourceIds), groups.map(group => group.sourceIds));
    });
    await test('a single over-limit question fails before download or transcription', async () => {
        const invalid = snapshot(), fresh = environment(join(temp, 'invalid-images'));
        invalid.questions[0].images.push(png);
        await assert.rejects(prepareExamListening(invalid, fresh.options), /EXAM_QUESTION_MATERIAL_INVALID/);
        assert.equal(fresh.counters.fetch, 0); assert.equal(fresh.counters.transcribe, 0);
    });
    await test('disabled listening stops before materialization', async () => {
        const fresh = environment(join(temp, 'disabled'));
        await assert.rejects(prepareExamListening(snapshot(), { ...fresh.options, enabled: false }), /LISTENING_DISABLED/);
        assert.equal(fresh.counters.fetch, 0); assert.equal(fresh.counters.transcribe, 0);
    });
} finally {
    assert.ok(resolve(temp).startsWith(resolve(tempRoot) + sep));
    await rm(temp, { recursive: true, force: true });
}
console.log(`All ${passed} listening-image material groups passed; no browser, network or paid model.`);
