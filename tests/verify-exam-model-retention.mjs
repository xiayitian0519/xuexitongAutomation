import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { runExam, textGroups } from '../automation/exam-runner.mjs';
import { saveGroupReceipt } from '../automation/exam-model-recovery.mjs';
import { createCliReceipt, requestAnswers } from '../deepseek-console/wb-cli-request.mjs';
import { digest } from '../listening/transcript-store.mjs';

// Synthetic materials only. These adapters cannot read a browser or contact a service.
const identity = { examId: 'offline-retention', title: 'Offline retention practice', courseKey: 'course:1:2' };
const questions = [
    { id: 1, type: '单选题', question: 'Synthetic choice', options: [{ letter: 'A', text: 'one' }, { letter: 'B', text: 'two' }] },
    { id: 2, type: '填空题', question: 'Synthetic fixed blank', blankCount: 1 },
];
const good = [{ id: 1, letters: ['B'] }, { id: 2, texts: ['two'] }];
const output = answers => JSON.stringify([
    { type: 'provider', providerData: { model: 'offline-fixture', rawUsage: { credit: 0.25 } } },
    { type: 'result', is_error: false, structured_output: { answers }, result: '' },
]);
await mkdir(resolve(import.meta.dirname, '../.tmp'), { recursive: true });
const temp = await mkdtemp(resolve(import.meta.dirname, '../.tmp/exam-model-retention-'));
const json = async file => JSON.parse(await readFile(file, 'utf8'));
let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log('PASS ' + name); };

function environment() {
    let phase = 'in-exam', requests = 0, fills = 0;
    const settings = { raw: { stdout: output(good), exitCode: 0 }, callbackFailure: false, saveFailure: false };
    const clicks = [];
    const snapshot = { fingerprint: 'synthetic-stable-paper', questions: structuredClone(questions),
        map: questions.map(q => ({ id: q.id, qid: 'card-' + q.id, audioIds: [] })), audio: [] };
    const view = () => ({ kind: phase, identityMatches: true, consent: [],
        result: phase === 'submitted' ? { confirmed: true, score: 90 } : null });
    const pageAdapter = { observe: async () => view(), click: async action => {
        clicks.push(action);
        if (action === 'submit') phase = 'submit-confirmation';
        if (action === 'submit-confirm') phase = 'submitted';
        return { performed: true, state: view() };
    } };
    const answerAdapter = { extract: async () => snapshot, refresh: async () => {},
        fill: async (_, answers) => {
            fills++;
            assert.deepEqual(answers, good);
            if (settings.saveFailure) throw new Error('OFFLINE_SAVE_FAILED');
        },
        verifyPersisted: async () => ({ confirmed: true, answers: 2 }),
        verifyCurrent: async () => ({ confirmed: true }),
    };
    const requester = async (groupQuestions, _, options) => {
        requests++;
        if (settings.callbackFailure) {
            await options.onReceipt(createCliReceipt(settings.raw));
            throw new Error('OFFLINE_AFTER_RECEIPT_FAILURE');
        }
        return requestAnswers(groupQuestions, undefined, { ...options, runner: async () => settings.raw });
    };
    return { settings, snapshot, clicks, pageAdapter, answerAdapter, requester,
        get requests() { return requests; }, get fills() { return fills; } };
}
const run = (env, name) => runExam({ identity, directory: join(temp, name), pageAdapter: env.pageAdapter,
    answerAdapter: env.answerAdapter, requester: env.requester, prepareMaterials: async () => [] });
const checkpoint = name => json(join(temp, name, 'exam-checkpoint.json'));
const oneGroup = state => { const groups = Object.entries(state.groups); assert.equal(groups.length, 1); return groups[0]; };
const recordFile = (name, key) => join(temp, name, 'model-receipts', key + '.json');

try {
    await test('semantic failure retains full stdout, usage, valid answers and invalid ids', async () => {
        const env = environment();
        env.settings.raw.stdout = output([{ id: 1, letters: ['B'] }, { id: 2, texts: [''] }]);
        await assert.rejects(run(env, 'partial'), /文字答案/);
        const [key, group] = oneGroup(await checkpoint('partial'));
        assert.equal(group.status, 'known-validation-failed');
        assert.deepEqual(group.answers, [good[0]]); assert.deepEqual(group.invalidIds, [2]);
        assert.equal(group.usage.credit, 0.25);
        const record = await json(recordFile('partial', key));
        assert.equal(record.receipt.stdout, env.settings.raw.stdout);
        assert.equal(record.receipt.meta.credit, 0.25);
        assert.equal(digest(record.receipt), record.sha256);
        assert.equal(env.requests, 1); assert.equal(env.fills, 0); assert.deepEqual(env.clicks, []);
    });
    await test('partial response resume performs no new request, fill or submit', async () => {
        const env = environment();
        env.settings.raw.stdout = output([{ id: 1, letters: ['B'] }, { id: 2, texts: [''] }]);
        await assert.rejects(run(env, 'partial-resume'));
        env.settings.raw.stdout = output(good);
        await assert.rejects(run(env, 'partial-resume'), /MODEL_ANSWERS_NEED_REVIEW/);
        assert.equal(env.requests, 1); assert.equal(env.fills, 0); assert.deepEqual(env.clicks, []);
    });
    await test('post-receipt local failure recovers a complete answer without another model call', async () => {
        const env = environment(); env.settings.callbackFailure = true;
        await assert.rejects(run(env, 'callback'), /OFFLINE_AFTER_RECEIPT_FAILURE/);
        assert.equal(oneGroup(await checkpoint('callback'))[1].status, 'response-received');
        assert.equal(env.fills, 0);
        const result = await run(env, 'callback');
        assert.equal(result.submitted, true); assert.equal(result.modelCalls, 1);
        assert.equal(result.observedCredit, 0.25); assert.equal(result.uncertainModelCalls, 0);
        assert.equal(env.requests, 1); assert.equal(env.fills, 1);
        assert.deepEqual(env.clicks, ['submit', 'submit-confirm']);
        assert.equal(oneGroup(await checkpoint('callback'))[1].recoveredLocally, true);
    });
    await test('repeated completion reads do not double count calls, credit or submission', async () => {
        const env = environment(); const first = await run(env, 'completion');
        const second = await run(env, 'completion');
        assert.equal(first.modelCalls, 1); assert.equal(second.modelCalls, 1);
        assert.equal(second.observedCredit, 0.25); assert.equal(env.requests, 1); assert.equal(env.fills, 1);
        assert.deepEqual(env.clicks, ['submit', 'submit-confirm']);
    });
    await test('uncertain process result retains evidence and never resends on resume', async () => {
        const env = environment(); env.settings.raw = { error: 'timeout', stdout: output(good) };
        await assert.rejects(run(env, 'uncertain'));
        const [key, group] = oneGroup(await checkpoint('uncertain'));
        assert.equal(group.status, 'request-started');
        assert.equal((await json(recordFile('uncertain', key))).receipt.execution.status, 'uncertain');
        env.settings.raw = { stdout: output(good), exitCode: 0 };
        await assert.rejects(run(env, 'uncertain'), /MODEL_OUTCOME_UNKNOWN/);
        assert.equal(env.requests, 1); assert.equal(env.fills, 0); assert.deepEqual(env.clicks, []);
    });
    await test('completed non-JSON output is retained and not requested again', async () => {
        const env = environment(); env.settings.raw.stdout = 'synthetic invalid output';
        await assert.rejects(run(env, 'invalid-json'));
        const [key, group] = oneGroup(await checkpoint('invalid-json'));
        assert.equal(group.status, 'known-validation-failed');
        assert.deepEqual(group.invalidIds, [1, 2]);
        assert.equal((await json(recordFile('invalid-json', key))).receipt.stdout, 'synthetic invalid output');
        await assert.rejects(run(env, 'invalid-json'), /MODEL_ANSWERS_NEED_REVIEW/);
        assert.equal(env.requests, 1); assert.equal(env.fills, 0);
    });
    await test('orphan durable receipt recovers the gap before checkpoint reference update', async () => {
        const env = environment(), directory = join(temp, 'orphan');
        const group = textGroups(env.snapshot)[0], key = digest({ sourceIds: group.sourceIds, questions: group.questions });
        await saveGroupReceipt(directory, key, digest(identity), createCliReceipt(env.settings.raw));
        const result = await run(env, 'orphan');
        assert.equal(env.requests, 0); assert.equal(env.fills, 1);
        assert.equal(result.modelCalls, 1); assert.equal(result.observedCredit, 0.25);
        assert.equal(oneGroup(await checkpoint('orphan'))[1].recoveredLocally, true);
    });
    await test('changed paper fingerprint stops before old response reuse', async () => {
        const env = environment(); env.settings.callbackFailure = true;
        await assert.rejects(run(env, 'changed-paper'));
        env.snapshot.fingerprint = 'synthetic-changed-paper';
        await assert.rejects(run(env, 'changed-paper'), /EXAM_CHANGED_SINCE_CHECKPOINT/);
        assert.equal(env.requests, 1); assert.equal(env.fills, 0); assert.deepEqual(env.clicks, []);
    });
    await test('group material mutation with unchanged paper marker is rejected', async () => {
        const env = environment(); env.settings.callbackFailure = true;
        await assert.rejects(run(env, 'changed-group'));
        env.snapshot.questions[0].question = 'Changed synthetic question';
        await assert.rejects(run(env, 'changed-group'), /EXAM_GROUP_MATERIAL_CHANGED/);
        assert.equal(env.requests, 1); assert.equal(env.fills, 0);
    });
    await test('corrupted stored receipt hash stops before local reuse or a new request', async () => {
        const env = environment(); env.settings.callbackFailure = true;
        await assert.rejects(run(env, 'corrupt'));
        const [key] = oneGroup(await checkpoint('corrupt'));
        const file = recordFile('corrupt', key), record = await json(file);
        record.receipt.stdout += ' edited';
        await writeFile(file, JSON.stringify(record));
        await assert.rejects(run(env, 'corrupt'), /MODEL_RECEIPT_CONTENT_INVALID/);
        assert.equal(env.requests, 1); assert.equal(env.fills, 0); assert.deepEqual(env.clicks, []);
    });
    await test('save failure resumes with ready answers and one total charged request', async () => {
        const env = environment(); env.settings.saveFailure = true;
        await assert.rejects(run(env, 'save-failure'), /OFFLINE_SAVE_FAILED/);
        assert.equal(oneGroup(await checkpoint('save-failure'))[1].status, 'ready');
        assert.equal(env.requests, 1); assert.deepEqual(env.clicks, []);
        env.settings.saveFailure = false;
        const result = await run(env, 'save-failure');
        assert.equal(result.modelCalls, 1); assert.equal(result.observedCredit, 0.25);
        assert.equal(env.requests, 1); assert.equal(env.fills, 2);
        assert.deepEqual(env.clicks, ['submit', 'submit-confirm']);
    });
} finally { await rm(temp, { recursive: true, force: true }); }
console.log('All ' + passed + ' private model retention groups passed; no browser, network or paid calls.');
