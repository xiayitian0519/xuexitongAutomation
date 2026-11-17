import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { runExam } from '../automation/exam-runner.mjs';
import { validateExamSpec } from '../automation/exam.mjs';
import { withFileLock } from '../listening/transcript-store.mjs';
const identity = { examId: 'offline', title: 'Offline practice', courseKey: 'course:1:2' };
const q = (id, text) => ({ id, type: '单选题', question: text, options: [{ letter: 'A', text: 'One' }, { letter: 'B', text: 'Two' }] });
await mkdir(resolve(import.meta.dirname, '../.tmp'), { recursive: true });
const temp = await mkdtemp(resolve(import.meta.dirname, '../.tmp/exam-recovery-'));
let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log('PASS ' + name); };
function environment() {
    let phase = 'entry-ready', checked = false, time = Date.parse('2026-11-17T01:00:00Z'), requests = 0, pending = 0, maxRequests = 0;
    const clicks = [], order = [], snapshot = {
        fingerprint: 'stable', questions: [q(1, 'Text question'), q(2, 'Listening question')],
        map: [{ id: 1, audioIds: [] }, { id: 2, child: 1, audioIds: ['clip'] }], audio: [{ id: 'clip', questionIds: [2] }],
    };
    const settings = {};
    let resolveText;
    const textFilled = new Promise(resolve => { resolveText = resolve; });
    const view = () => ({ kind: phase, identityMatches: true, consent: [{ checked }],
        result: phase === 'submitted' ? { confirmed: true, score: 90 } : null });
    const api = {
        observe: async () => view(),
        click: async action => {
            clicks.push(action);
            if (action === 'consent') checked = true;
            if (action === 'entry') phase = 'entry-confirmation';
            if (action === 'entry-confirm') phase = 'in-exam';
            if (action === 'submit') phase = 'submit-confirmation';
            if (action === 'submit-confirm' && !settings.unknownFinal) phase = 'submitted';
            return { performed: !(settings.timeoutEntry && action === 'entry-confirm'), state: view(),
                error: settings.timeoutEntry && action === 'entry-confirm' ? 'TimeoutError' : null };
        },
    };
    const adapter = {
        extract: async () => snapshot, refresh: async () => {},
        fill: async (_, answers) => { order.push('fill-' + answers[0].id); if (answers[0].id === 1) resolveText(); },
        verifyPersisted: async () => ({ confirmed: true, answers: 2 }),
        verifyCurrent: async () => { if (settings.drift) throw new Error('EXAM_PERSISTED_ANSWERS_MISMATCH'); return { confirmed: true }; },
    };
    return {
        api, adapter, settings, clicks, order, snapshot,
        now: () => time, advance: ms => { time += ms; }, get requests() { return requests; }, get maxRequests() { return maxRequests; },
        setPhase: value => { phase = value; },
        requester: async questions => {
            requests++; pending++; maxRequests = Math.max(maxRequests, pending);
            order.push('request-' + questions[0].question);
            await new Promise(resolve => setTimeout(resolve, 1));
            pending--;
            if (settings.modelFailure) throw new Error('MODEL_UNCERTAIN');
            return questions.map(question => ({ id: question.id, letters: ['B'] }));
        },
        materials: async () => {
            order.push('materials-start');
            if (settings.waitForText) await textFilled;
            await new Promise(resolve => setTimeout(resolve, 10));
            if (settings.materialFailure) throw new Error('LISTENING_NEEDS_REVIEW');
            order.push('materials-ready');
            return [{ name: 'listening', sourceIds: [2], questions: [q(1, 'Reliable transcript question')] }];
        },
    };
}
const run = (env, name, options = {}) => runExam({ identity, directory: join(temp, name),
    pageAdapter: env.api, answerAdapter: env.adapter, prepareMaterials: env.materials,
    requester: env.requester, now: env.now, observationTimeoutMs: 15, ...options });
try {
    await test('reading runs while audio is preparing; paid calls stay sequential', async () => {
        const env = environment(); env.settings.waitForText = true; await run(env, 'parallel');
        assert.ok(env.order.indexOf('materials-start') < env.order.indexOf('request-Text question'));
        assert.ok(env.order.indexOf('fill-1') < env.order.indexOf('materials-ready'));
        assert.equal(env.requests, 2); assert.equal(env.maxRequests, 1);
    });
    await test('entry timeout with successful navigation is not clicked twice', async () => {
        const env = environment(); env.settings.timeoutEntry = true;
        const result = await run(env, 'timeout');
        assert.equal(env.clicks.filter(action => action === 'entry-confirm').length, 1);
        assert.equal(result.fullyAutomated, false); assert.equal(result.unknownActions, 1);
    });
    await test('minimum time is waited and deadline is checked with a controlled clock', async () => {
        const env = environment(), start = env.now(); let waits = 0;
        await run(env, 'minimum', { minimumMinutes: 10, deadline: new Date(start + 900000).toISOString(),
            wait: async ms => { assert.ok(!env.clicks.includes('submit')); waits++; env.advance(ms); } });
        assert.ok(waits > 0); assert.ok(env.now() - start >= 600000);
    });
    await test('an impossible submission window never sends submit', async () => {
        const env = environment();
        await assert.rejects(run(env, 'deadline', { minimumMinutes: 10, deadline: new Date(env.now() + 10000).toISOString() }), /DEADLINE/);
        assert.ok(!env.clicks.includes('submit'));
    });
    await test('unknown final send is not retried; manually completed result is recognized', async () => {
        const env = environment(); env.settings.unknownFinal = true;
        await assert.rejects(run(env, 'uncertain'), /TIMEOUT/);
        await assert.rejects(run(env, 'uncertain'), /SUBMIT_OUTCOME_UNKNOWN/);
        assert.equal(env.clicks.filter(action => action === 'submit-confirm').length, 1);
        env.setPhase('submitted');
        const result = await run(env, 'uncertain', { manualActions: [{ action: 'submit-confirm', at: new Date(env.now()).toISOString() }] });
        assert.equal(result.manualInterventions, 1); assert.equal(result.fullyAutomated, false); assert.equal(env.requests, 2);
    });
    await test('uncertain model outcome is not requested again after resume', async () => {
        const env = environment(); env.settings.modelFailure = true;
        await assert.rejects(run(env, 'model'), /MODEL_UNCERTAIN/);
        await assert.rejects(run(env, 'model'), /MODEL_OUTCOME_UNKNOWN/);
        assert.equal(env.requests, 1); assert.ok(!env.clicks.includes('submit'));
    });
    await test('failed listening keeps completed text and prevents partial submission', async () => {
        const env = environment(); env.settings.materialFailure = true;
        await assert.rejects(run(env, 'audio-failure'), /NEEDS_REVIEW/);
        assert.equal(env.requests, 1); assert.ok(!env.clicks.includes('submit'));
        env.settings.materialFailure = false;
        await run(env, 'audio-failure');
        assert.equal(env.requests, 2);
    });
    await test('answer drift before submission blocks the submit button', async () => {
        const env = environment(); env.settings.drift = true;
        await assert.rejects(run(env, 'drift'), /PERSISTED_ANSWERS/);
        assert.ok(!env.clicks.includes('submit'));
    });
    await test('cancellation during minimum-time wait sends no submit', async () => {
        const env = environment(), controller = new AbortController();
        await assert.rejects(run(env, 'cancel', { minimumMinutes: 10, signal: controller.signal,
            wait: async () => { controller.abort(); } }), /ABORTED/);
        assert.ok(!env.clicks.includes('submit'));
    });
    await test('notification failure leaves a durable outbox without duplicate sends', async () => {
        const env = environment(); let notices = 0;
        const notify = () => { notices++; throw new Error('CONSUMER_FAILED'); };
        const result = await run(env, 'notice', { onCompletion: notify });
        assert.equal(result.notification, 'delivery-unknown');
        await run(env, 'notice', { onCompletion: notify });
        assert.equal(notices, 1);
        const event = JSON.parse(await readFile(join(temp, 'notice/completion-event.json'), 'utf8'));
        assert.equal(event.submitted, true);
    });
    await test('live writer is protected; dead process lock can be recovered without deletion', async () => {
        const file = join(temp, 'lock-test/writer.lock');
        await withFileLock(file, async () => { await assert.rejects(withFileLock(file, async () => {}), /BUSY/); });
        // A child process has definitely exited, avoiding guesses about an unused PID.
        const { spawn } = await import('node:child_process');
        const child = spawn(process.execPath, ['-e', ''], { windowsHide: true });
        await new Promise(resolve => child.once('exit', resolve));
        await writeFile(file, JSON.stringify({ pid: child.pid, token: 'old-owner' }));
        await withFileLock(file, async () => {});
    });
    await test('configuration refuses mismatched URL, unknown deadline and invalid thread count', async () => {
        const spec = { schemaVersion: 1, identity, url: 'https://fixture.chaoxing.com/exam?examId=offline',
            minimumMinutes: 10, deadline: '2026-11-17T04:00:00Z' };
        assert.equal(validateExamSpec(spec), spec);
        assert.throws(() => validateExamSpec({ ...spec, url: spec.url + '-other' }), /MISMATCH/);
        assert.throws(() => validateExamSpec({ ...spec, deadline: null }), /DEADLINE/);
        assert.throws(() => validateExamSpec({ ...spec, listening: { threads: 0 } }), /THREADS/);
    });
} finally { await rm(temp, { recursive: true, force: true }); }
console.log('All ' + passed + ' exam recovery groups passed; no platform or paid model.');
