import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { createCliReceipt, inspectReceiptAnswers, requestAnswers, runCli, validateReceiptAnswers } from '../deepseek-console/wb-cli-request.mjs';

// All inputs are synthetic. Only the final transport checks spawn a small local
// Node fixture, never a real CLI, browser, remote page, or paid call.
const questions = [
    { id: 1, type: '单选题', question: 'Synthetic choice', options: [{ letter: 'A', text: 'one' }, { letter: 'B', text: 'two' }] },
    { id: 2, type: '填空题', question: 'Synthetic blank', blankCount: 1 },
];
const good = [{ id: 1, letters: ['B'] }, { id: 2, texts: ['two'] }];
const output = (answers = good, options = {}) => JSON.stringify([
    { type: 'provider', providerData: { model: 'offline-fixture', rawUsage: { credit: 0.12 } } },
    { type: 'provider', providerData: { model: 'offline-fixture', rawUsage: { credit: 0.03 } } },
    { type: 'result', is_error: !!options.isError, result: options.result || '',
        ...(options.noStructured ? {} : { structured_output: { answers } }) },
]);
let checks = 0;
const test = async (name, fn) => { await fn(); checks++; console.log('PASS ' + name); };

await test('receipt is awaited before meta and answer validation', async () => {
    const order = [], saved = [];
    const answers = await requestAnswers(questions, undefined, {
        runner: async () => ({ stdout: output(), stderr: 'synthetic-private-stderr' }),
        onReceipt: async receipt => {
            order.push('receipt-start'); await new Promise(resolve => setTimeout(resolve, 1));
            saved.push(JSON.parse(JSON.stringify(receipt))); order.push('receipt-saved');
        },
        onMeta: meta => { assert.equal(saved.length, 1); order.push('meta'); assert.equal(meta.credit, 0.15); },
    });
    assert.deepEqual(answers, good);
    assert.deepEqual(order, ['receipt-start', 'receipt-saved', 'meta']);
    assert.equal(saved[0].version, 1);
    assert.equal(saved[0].execution.status, 'completed');
    assert.equal(JSON.stringify(saved[0]).includes('synthetic-private-stderr'), false);
});

await test('invalid text retains full output, usage and independently valid choice', async () => {
    let receipt;
    await assert.rejects(requestAnswers(questions, undefined, {
        runner: async () => ({ stdout: output([{ id: 1, letters: ['B'] }, { id: 2, texts: [''] }]) }),
        onReceipt: async value => { receipt = value; },
    }), /文字答案/);
    assert.equal(receipt.execution.status, 'completed');
    assert.equal(receipt.meta.credit, 0.15);
    const inspection = inspectReceiptAnswers(questions, receipt);
    assert.deepEqual(inspection, { answers: [good[0]], invalidIds: [2], complete: false, meta: { model: 'offline-fixture', credit: 0.15 } });
    assert.equal(receipt.parsed[2].structured_output.answers[1].texts[0], '');
});

await test('missing row is incomplete instead of deleting good rows', async () => {
    const partial = inspectReceiptAnswers(questions, createCliReceipt({ stdout: output([good[0]]) }));
    assert.deepEqual(partial.answers, [good[0]]); assert.deepEqual(partial.invalidIds, [2]);
    assert.equal(partial.complete, false);
});

await test('ambiguous duplicate or unknown IDs reject the full inspection', async () => {
    for (const answers of [[good[0], good[0]], [good[0], { id: 99, texts: ['private'] }], [null]]) {
        assert.throws(() => inspectReceiptAnswers(questions, createCliReceipt({ stdout: output(answers) })), { code: 'MODEL_ANSWER_IDS_AMBIGUOUS' });
    }
});

await test('invalid JSON is retained before a safe parsing error', async () => {
    let saved;
    const privateOutput = 'fixture-invalid-output https://fixture.invalid/?signature=private';
    await assert.rejects(requestAnswers(questions, undefined, {
        runner: async () => ({ stdout: privateOutput }), onReceipt: value => { saved = value; },
    }), error => error.code === 'MODEL_OUTPUT_NOT_JSON' && !error.message.includes('signature'));
    assert.equal(saved.stdout, privateOutput); assert.equal(saved.parsed, null); assert.equal(saved.parseStatus, 'invalid-json');
    assert.equal(saved.execution.status, 'completed');
});

await test('known envelope and model errors keep usage without echoing provider error', async () => {
    for (const stdout of ['[]', output(good, { isError: true, result: 'https://fixture.invalid/?signature=private' })]) {
        let saved;
        await assert.rejects(requestAnswers(questions, undefined, {
            runner: async () => ({ stdout }), onReceipt: receipt => { saved = receipt; },
        }), error => !error.message.includes('signature'));
        assert.equal(saved.stdout, stdout); assert.equal(saved.execution.status, 'completed');
    }
});

await test('receipt save failure stops once and reports an explicit unknown-save state', async () => {
    let calls = 0, meta = 0;
    await assert.rejects(requestAnswers(questions, undefined, {
        runner: async () => { calls++; return { stdout: output() }; },
        onReceipt: async () => { throw new Error('fixture-disk-full-private'); }, onMeta: () => { meta++; },
    }), error => error.code === 'MODEL_RECEIPT_SAVE_FAILED' && !error.message.includes('disk-full'));
    assert.equal(calls, 1); assert.equal(meta, 0);
});

await test('meta consumer failure still permits zero-call strict recovery', async () => {
    let saved, calls = 0;
    await assert.rejects(requestAnswers(questions, undefined, {
        runner: async () => { calls++; return { stdout: output() }; },
        onReceipt: value => { saved = value; }, onMeta: () => { throw new Error('OFFLINE_META_CONSUMER_FAILED'); },
    }), /OFFLINE_META_CONSUMER_FAILED/);
    assert.deepEqual(validateReceiptAnswers(questions, JSON.parse(JSON.stringify(saved))), good);
    assert.equal(calls, 1);
});

await test('timeout, nonzero, overflow and thrown runner remain uncertain with no resend', async () => {
    const cases = [
        { error: 'timeout', detail: 'secret-private', stdout: output() },
        { exitCode: 2, stdout: output() },
        { error: 'output-limit', detail: 'secret-private', stdout: 'partial' },
        { error: 'exit-code', detail: 'secret-private', stdout: output() },
    ];
    for (const raw of cases) {
        let calls = 0, receipt;
        await assert.rejects(requestAnswers(questions, undefined, {
            runner: async () => { calls++; return raw; }, onReceipt: value => { receipt = value; },
        }), error => !error.message.includes('secret-private'));
        assert.equal(receipt.execution.status, 'uncertain'); assert.equal(calls, 1);
        assert.throws(() => validateReceiptAnswers(questions, receipt), { code: 'MODEL_OUTCOME_UNKNOWN' });
    }
    let receipt;
    await assert.rejects(requestAnswers(questions, undefined, {
        runner: async () => { throw new Error('secret-private'); }, onReceipt: value => { receipt = value; },
    }), error => !error.message.includes('secret-private'));
    assert.equal(receipt.execution.status, 'uncertain');
});

await test('cancellation after response is recorded before the abort reaches caller', async () => {
    const controller = new AbortController(); let saved;
    await assert.rejects(requestAnswers(questions, undefined, {
        signal: controller.signal,
        runner: async () => { controller.abort(); return { stdout: output() }; },
        onReceipt: value => { saved = value; },
    }), { name: 'AbortError' });
    assert.equal(saved.execution.status, 'completed');
    assert.deepEqual(validateReceiptAnswers(questions, saved), good);
    const uncertain = createCliReceipt({ error: 'aborted', stdout: output() });
    assert.equal(uncertain.execution.status, 'uncertain');
});

await test('authentication diagnosis excludes stderr contents from receipt', async () => {
    let saved;
    await assert.rejects(requestAnswers(questions, undefined, {
        runner: async () => ({ stdout: '', stderr: 'Authentication required token=fixture-secret' }),
        onReceipt: value => { saved = value; },
    }), /未登录/);
    assert.equal(saved.authenticationRequired, true);
    assert.equal(JSON.stringify(saved).includes('fixture-secret'), false);
});

await test('fallback result JSON recovers and edited parsed field is ignored', async () => {
    const receipt = createCliReceipt({ stdout: output(good, { noStructured: true, result: JSON.stringify({ answers: good }) }) });
    receipt.parsed[2].result = 'edited-untrusted';
    assert.deepEqual(validateReceiptAnswers(questions, receipt), good);
    assert.equal(inspectReceiptAnswers(questions, receipt).complete, true);
});

await test('question contract, schema and tool whitelist remain enforced', async () => {
    let calls = 0;
    await assert.rejects(requestAnswers([], undefined, { runner: async () => { calls++; return {}; } }), /题目格式/);
    assert.equal(calls, 0);
    await requestAnswers(questions, undefined, { runner: async args => {
        assert.equal(args[args.indexOf('--tools') + 1], 'StructuredOutput');
        assert.equal(args[args.indexOf('--permission-mode') + 1], 'dontAsk');
        assert.ok(args.includes('--json-schema'));
        return { stdout: output() };
    } });
    assert.throws(() => validateReceiptAnswers(questions, { version: 9 }), { code: 'MODEL_RECEIPT_INVALID' });
});

await test('choice validation never mutates the retained original answer', async () => {
    const choice = [questions[0]], receipt = createCliReceipt({ stdout: output([{ id: 1, letters: [' b '] }]) });
    const original = JSON.stringify(receipt);
    assert.deepEqual(validateReceiptAnswers(choice, receipt), [{ id: 1, letters: ['B'] }]);
    assert.equal(JSON.stringify(receipt), original);
    assert.throws(() => validateReceiptAnswers(choice, createCliReceipt({ stdout: output([{ id: 1, letters: ['B'], extra: 'private' }]) })), /未知字段/);
});

const tempRoot = resolve(import.meta.dirname, '../.tmp');
await mkdir(tempRoot, { recursive: true });
const temp = await mkdtemp(join(tempRoot, 'receipt-transport-'));
try {
    const fixture = join(temp, 'fake-process.mjs');
    await writeFile(fixture, `
const mode = process.argv[2];
if(mode === 'overflow') { process.stdout.write('x'.repeat(200)); setInterval(()=>{},1000); }
else { process.stdout.write(${JSON.stringify(output())});
  if(mode === 'nonzero') process.exitCode = 7;
  if(mode === 'timeout') setInterval(()=>{},1000);
}
`);
    await test('nonzero fixture retains partial evidence and rejects strict reuse', async () => {
        const raw = await runCli(['nonzero'], 3000, '', { cliPath: fixture });
        assert.equal(raw.error, 'exit-code'); assert.equal(raw.exitCode, 7); assert.equal(raw.stdout, undefined);
        const receipt = createCliReceipt(raw);
        assert.equal(receipt.stdout, output()); assert.equal(receipt.execution.status, 'uncertain');
        assert.equal(receipt.meta.credit, 0.15);
        assert.throws(() => validateReceiptAnswers(questions, receipt), { code: 'MODEL_OUTCOME_UNKNOWN' });
    });
    await test('timeout fixture records complete-looking partial text as uncertain', async () => {
        const raw = await runCli(['timeout'], 250, '', { cliPath: fixture });
        assert.equal(raw.error, 'timeout');
        const receipt = createCliReceipt(raw);
        assert.equal(receipt.execution.status, 'uncertain'); assert.equal(receipt.parseStatus, 'json');
        assert.throws(() => inspectReceiptAnswers(questions, receipt), { code: 'MODEL_OUTCOME_UNKNOWN' });
    });
    await test('overflow fixture never returns oversized answer as successful output', async () => {
        const raw = await runCli(['overflow'], 3000, '', { cliPath: fixture, maxOutputBytes: 100 });
        assert.equal(raw.error, 'output-limit'); assert.equal(raw.stdout, undefined);
        assert.ok(Buffer.byteLength(raw.partialStdout || '') <= 100);
        assert.equal(createCliReceipt(raw).execution.status, 'uncertain');
    });
} finally {
    assert.ok(resolve(temp).startsWith(resolve(tempRoot) + sep));
    await rm(temp, { recursive: true, force: true });
}

console.log(`PASS ${checks} private model receipt checks; no browsers, real CLI processes or paid calls`);
