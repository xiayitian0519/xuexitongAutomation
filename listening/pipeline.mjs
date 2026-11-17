import { readFile, stat, realpath } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, relative, isAbsolute, join } from 'node:path';
import { validateManifest, validateTranscript, checkCoverage } from './contracts.mjs';
import { runRawTranscriber, transcriberParameters } from './transcriber.mjs';
import { digest, transcriptStore } from './transcript-store.mjs';
import { repairRanges, mergeRepair, transcriptChecks } from './transcript-repair.mjs';
import { resolveListeningPaths } from './local-paths.mjs';

const modelFingerprints = new Map();
const abortCheck = signal => { if (signal?.aborted) throw new Error('ABORTED'); };
export async function resolveListeningModelIdentity(options = {}) {
    if (options.modelIdentity) return options.modelIdentity;
    const { model, modelSource } = resolveListeningPaths(options);
    // Offline transcriber injection remains independent of local model files.
    // The project default must not turn an injected test into a real model read.
    if (modelSource === 'project-default' && options.transcriber) return 'injected:' + digest(String(options.transcriber));
    const io = { realpath, stat, readFile, createReadStream, ...options.modelIo };
    const path = await io.realpath(join(model, 'model.bin')), info = await io.stat(path);
    const configs = [];
    for (const name of ['config.json', 'tokenizer.json', 'vocabulary.json']) {
        try { configs.push([name, digest(await io.readFile(join(model, name)))]); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const identity = path + ':' + info.size + ':' + info.mtimeMs + ':' + digest(configs);
    if (!modelFingerprints.has(identity)) {
        modelFingerprints.set(identity, (async () => {
            const hash = createHash('sha256');
            for await (const chunk of io.createReadStream(path)) hash.update(chunk);
            hash.update(JSON.stringify(configs));
            return hash.digest('hex');
        })());
    }
    return modelFingerprints.get(identity);
}

export async function mapLimited(items, concurrency, fn, signal) {
    if (![1, 2].includes(concurrency)) throw new Error('ASR_CONCURRENCY_MUST_BE_1_OR_2');
    const results = new Array(items.length), errors = [];
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        while (next < items.length && !signal?.aborted) {
            const index = next++;
            try { results[index] = await fn(items[index], index); }
            catch (error) { errors.push({ index, error }); }
        }
    }));
    abortCheck(signal);
    return { results, errors };
}

async function transcribeOne(file, audio, manifest, key, options) {
    const store = transcriptStore(options.cacheDir, key);
    const emit = async (phase, details = {}) => options.onEvent?.({ phase, audioId: audio.id, at: new Date().toISOString(), ...details });
    return store.lock(async () => {
        const state = await store.load(), evidenceKey = digest(audio.expectations || manifest.questions.filter(q => audio.questionIds.includes(q.id)));
        abortCheck(options.signal);
        if (state.final?.evidenceKey === evidenceKey) {
            const cached = await store.get(state.final.ref);
            if (!transcriptChecks(audio, manifest.questions, cached).ok) throw new Error('FINAL_CACHE_INVALID');
            await emit('asr-cache-hit');
            return { transcript: cached, cached: true, repairs: state.repairs.length };
        }
        let transcript;
        const transcriber = options.transcriber || runRawTranscriber;
        const invoke = async range => {
            try { return await transcriber(file, { ...options, range }); }
            catch (error) {
                state.failures ||= [];
                state.failures.push({ at: new Date().toISOString(), phase: range ? 'repair' : 'full',
                    range: range || null, code: /^[A-Z_]+$/.test(error.message) ? error.message : 'ASR_EXECUTION_FAILED',
                    ...(error.diagnostics ? { diagnostics: {
                        stdoutBytes: Number.isFinite(error.diagnostics.stdoutBytes) ? error.diagnostics.stdoutBytes : null,
                        stderrBytes: Number.isFinite(error.diagnostics.stderrBytes) ? error.diagnostics.stderrBytes : null,
                        exitCode: Number.isInteger(error.diagnostics.exitCode) ? error.diagnostics.exitCode : null,
                    } } : {}) });
                state.failures = state.failures.slice(-100);
                await store.save(state); throw error;
            }
        };
        if (state.raw) { transcript = await store.get(state.raw); await emit('asr-raw-resumed'); }
        else {
            await emit('asr-started');
            transcript = await invoke(undefined);
            // Persist before quality checking, including valid JSON that fails
            // strict confidence checks.
            state.raw = await store.put('raw', { transcript, parameters: transcriberParameters(options),
                modelIdentity: options.resolvedModelIdentity, audioHash: options.audioHash,
                completedAt: new Date().toISOString() });
            await store.save(state);
            await emit('asr-raw-saved');
            transcript = (await store.get(state.raw)).transcript;
        }
        if (transcript?.transcript) transcript = transcript.transcript;
        let checks = transcriptChecks(audio, manifest.questions, transcript);
        state.quality = await store.put('quality', checks);
        await store.save(state);
        // Successfully completed repairs may be resumed after cancellation.
        for (const repair of state.repairs.filter(row => row.evidenceKey === evidenceKey && row.merged)) {
            transcript = await store.get(repair.merged);
            checks = transcriptChecks(audio, manifest.questions, transcript);
        }
        let rounds = state.repairs.filter(row => row.evidenceKey === evidenceKey).length;
        const incomplete = state.repairs.find(row => row.evidenceKey === evidenceKey && !row.merged);
        let resuming = incomplete;
        while (!checks.ok && (resuming || rounds < (options.maxRepairRounds ?? 2))) {
            abortCheck(options.signal);
            const ranges = resuming?.ranges || repairRanges(transcript, checks.coverage, options.contextSeconds ?? 3);
            const entry = resuming || { evidenceKey, ranges, clips: [], startedAt: new Date().toISOString() };
            if (!resuming) { state.repairs.push(entry); rounds++; await store.save(state); }
            resuming = null;
            for (const range of ranges) {
                abortCheck(options.signal);
                const previous = entry.clips.find(row => row.range.start === range.start && row.range.end === range.end);
                let clip;
                if (previous) clip = await store.get(previous.ref);
                else {
                    await emit('asr-repair-started', { start: range.start, end: range.end, round: rounds });
                    clip = await invoke(range);
                    entry.clips.push({ range, ref: await store.put('repair', clip) });
                    await store.save(state);
                }
                try { transcript = mergeRepair(transcript, clip, range); }
                catch (error) {
                    if (!['REPAIR_OFFSET_INVALID', 'REPAIR_OUTSIDE_RANGE'].includes(error.message) && !error.message.includes('可信度')) throw error;
                    entry.failure = error.message.includes('可信度') ? 'REPAIR_LOW_CONFIDENCE' : error.message;
                    break;
                }
            }
            checks = transcriptChecks(audio, manifest.questions, transcript);
            entry.merged = await store.put('final', transcript);
            state.quality = await store.put('quality', checks);
            await store.save(state);
        }
        if (!checks.ok) {
            await emit('asr-needs-review', { issueCount: checks.quality.issues.length + checks.coverage.problems.length });
            throw new Error('LISTENING_NEEDS_REVIEW');
        }
        validateTranscript(transcript);
        state.final = { evidenceKey, ref: await store.put('final', transcript) };
        await store.save(state);
        await emit('asr-ready');
        return { transcript, cached: false, repairs: state.repairs.length };
    });
}

export async function prepareListening(manifest, options = {}) {
    validateManifest(manifest);
    const started = performance.now(), base = await realpath(options.baseDir || process.cwd());
    const concurrency = options.concurrency ?? 1;
    if (![1, 2].includes(concurrency)) throw new Error('ASR_CONCURRENCY_MUST_BE_1_OR_2');
    if (!Number.isInteger(options.maxRepairRounds ?? 2) || (options.maxRepairRounds ?? 2) < 0 || (options.maxRepairRounds ?? 2) > 2)
        throw new Error('INVALID_REPAIR_LIMIT');
    if (!Number.isFinite(options.contextSeconds ?? 3) || (options.contextSeconds ?? 3) < 0 || (options.contextSeconds ?? 3) > 10)
        throw new Error('INVALID_REPAIR_CONTEXT');
    // Preflight the entire batch before decoding or spawning any processes.
    const files = [];
    for (const audio of manifest.audio) {
        abortCheck(options.signal);
        const file = await realpath(resolve(base, audio.path)), inside = relative(base, file);
        if (inside.startsWith('..') || isAbsolute(inside)) throw new Error('音频路径超出练习目录');
        const info = await stat(file);
        if (!info.isFile() || !info.size || info.size > 30 * 1024 * 1024) throw new Error('音频为空或超过 30 MiB');
        files.push({ audio, file, sha256: digest(await readFile(file)) });
    }
    const identity = await resolveListeningModelIdentity(options), jobs = new Map();
    for (const file of files) {
        const key = digest({ audioHash: file.sha256, modelIdentity: identity, parameters: transcriberParameters(options) });
        file.key = key;
        if (!jobs.has(key)) jobs.set(key, []);
        jobs.get(key).push(file);
    }
    const groups = [...jobs.values()];
    const run = await mapLimited(groups, concurrency, async group => {
        // A single decode for duplicate files. Coverage of every reference is
        // checked below; differing expectations never silently reuse an answer.
        const first = group[0];
        // Aggregate every reference before repairing, so a missing question on
        // the second reference cannot be overlooked by hash deduplication.
        const questionIds = [...new Set(group.flatMap(row => row.audio.questionIds))];
        const expectations = group.flatMap(row => row.audio.expectations ||
            row.audio.questionIds.map(questionId => ({ questionId, source: 'page' })));
        const byQuestion = new Map();
        for (const row of expectations) {
            if (byQuestion.has(row.questionId) && digest(byQuestion.get(row.questionId)) !== digest(row)) throw new Error('DUPLICATE_AUDIO_EXPECTATION_CONFLICT');
            byQuestion.set(row.questionId, row);
        }
        const combined = { ...first.audio, questionIds, expectations: [...byQuestion.values()] };
        return transcribeOne(first.file, combined, manifest, first.key, { ...options, audioHash: first.sha256,
            cacheDir: options.cacheDir || join(base, '.transcripts'), resolvedModelIdentity: identity });
    }, options.signal);
    if (run.errors.length) {
        const error = new Error('LISTENING_PIPELINE_FAILED: ' + run.errors.map(row => row.error.message).join('; '));
        error.audioIds = run.errors.flatMap(row => groups[row.index].map(file => file.audio.id));
        throw error;
    }
    const transcripts = {}, audio = [];
    for (const file of files) {
        const result = run.results[groups.findIndex(group => group[0].key === file.key)];
        if (!checkCoverage(file.audio, manifest.questions, result.transcript).ok) throw new Error('DUPLICATE_AUDIO_COVERAGE_INCOMPLETE');
        transcripts[file.audio.id] = result.transcript;
        audio.push({ id: file.audio.id, questionIds: file.audio.questionIds, sha256: file.sha256,
            ...result.transcript, cached: result.cached, repairs: result.repairs });
    }
    return { transcripts, audio, elapsedMs: Math.round(performance.now() - started), concurrency };
}
