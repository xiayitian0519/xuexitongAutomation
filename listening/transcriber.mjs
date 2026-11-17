import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateTranscript } from './contracts.mjs';
import { resolveListeningPaths } from './local-paths.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const transcriberParameters = options => ({
    engine: 'faster-whisper-1.2.1', device: 'cpu', computeType: 'int8',
    threads: options.threads ?? 4, beamSize: 5, wordTimestamps: true, conditionOnPreviousText: false,
});
export function runRawTranscriber(input, options = {}) {
    return new Promise((resolveResult, reject) => {
        if (options.signal?.aborted) return reject(new Error('ABORTED'));
        const { model, dependencies, python } = resolveListeningPaths(options);
        const threads = options.threads ?? 4;
        if (!Number.isInteger(threads) || threads < 1 || threads > 16) return reject(new Error('转写线程数须为1—16'));
        const args = [join(ROOT, 'listening/transcribe.py'), '--input', input, '--model', model,
            '--dependencies', dependencies,
            '--threads', String(threads)];
        if (options.range) {
            const { start, end } = options.range;
            if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > 1200) return reject(new Error('INVALID_REPAIR_RANGE'));
            args.push('--start-seconds', String(start), '--end-seconds', String(end));
        }
        const child = (options.spawn || spawn)(python, args,
            { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
        const chunks = [];
        let bytes = 0, stderrBytes = 0, timedOut = false, tooLarge = false, aborted = false, settled = false, exitCode = null;
        const finish = (error, value) => {
            if (settled) return; settled = true;
            clearTimeout(timer); options.signal?.removeEventListener('abort', abort);
            if (error) error.diagnostics = { stdoutBytes: bytes, stderrBytes, exitCode };
            error ? reject(error) : resolveResult(value);
        };
        const abort = () => { aborted = true; child.kill(); };
        const timer = setTimeout(() => { timedOut = true; child.kill(); }, options.timeoutMs ?? 180000);
        options.signal?.addEventListener('abort', abort, { once: true });
        if (options.signal?.aborted) abort();
        child.stdout.on('data', chunk => {
            bytes += chunk.length;
            if (bytes > 2 * 1024 * 1024) { tooLarge = true; child.kill(); } else chunks.push(chunk);
        });
        child.stderr.on('data', chunk => { stderrBytes += chunk.length; });
        child.once('error', () => finish(new Error('ASR_START_FAILED')));
        child.once('close', code => {
            exitCode = code;
            if (aborted || options.signal?.aborted) return finish(new Error('ABORTED'));
            if (timedOut || tooLarge || code !== 0) return finish(new Error(timedOut ? 'ASR_TIMEOUT' : tooLarge ? 'ASR_OUTPUT_LIMIT' : 'ASR_PROCESS_FAILED'));
            try { finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
            catch { finish(new Error('ASR_INVALID_JSON')); }
        });
    });
}
export async function runTranscriber(input, options = {}) {
    return validateTranscript(await runRawTranscriber(input, options));
}
