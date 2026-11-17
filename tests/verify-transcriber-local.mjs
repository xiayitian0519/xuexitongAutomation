// Requires the explicitly prepared local synthetic audio/model. No downloads.
import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { runRawTranscriber } from '../listening/transcriber.mjs';
import { validateTranscript } from '../listening/contracts.mjs';
import { atomicJson } from '../listening/transcript-store.mjs';
const root = resolve(import.meta.dirname, '..');
const result = await runRawTranscriber(join(root, '.tmp/workflow-benchmark-input/library.wav'), {
    python: process.env.LISTENING_PYTHON || 'python',
    model: process.env.LISTENING_MODEL || join(root, '.tmp/listening-model-small'),
    threads: 2, range: { start: 2, end: 10 },
});
validateTranscript(result);
assert.equal(result.offsetSeconds, 2);
assert.ok(Math.abs(result.duration - 8) < 0.05);
assert.ok(result.sourceDuration > 10);
assert.ok(result.segments.every(row => row.start >= 0 && row.end <= result.duration + 0.1));
assert.match(result.segments.map(row => row.text).join(' '), /closes|morning|six/i);
const summary = { localOnly: true, paidCalls: 0, offsetSeconds: result.offsetSeconds,
    duration: result.duration, sourceDuration: result.sourceDuration,
    segments: result.segments.length, strictQualityPassed: true, runtime: result.runtime };
await atomicJson(join(root, '.tmp/workflow-benchmark-run/clip-verification.json'), summary);
console.log('PASS actual local ASR interval: original offset retained, eight seconds recognized, strict quality and source duration verified.');
