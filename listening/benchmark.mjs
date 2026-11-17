// Explicit local-only benchmark. No model API, browser, download or submission.
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { prepareListening } from './pipeline.mjs';
import { runRawTranscriber } from './transcriber.mjs';
import { atomicJson, digest } from './transcript-store.mjs';

export async function benchmark(manifest, options) {
    const rounds = options.rounds ?? 3;
    if (!Number.isInteger(rounds) || rounds < 3 || rounds > 10 || manifest.audio.length !== 2) throw new Error('BENCHMARK_REQUIRES_TWO_AUDIO_AND_3_TO_10_ROUNDS');
    const records = [];
    for (let round = 1; round <= rounds; round++) {
        for (const concurrency of round % 2 ? [1, 2] : [2, 1]) {
            const runtime = [], threads = concurrency === 1 ? 4 : 2;
            const settings = { ...options, concurrency, threads, cacheDir: join(options.directory, 'round-' + round + '-c' + concurrency),
                transcriber: async (file, args) => {
                    const value = await runRawTranscriber(file, args);
                    runtime.push({ ...value.runtime, textHash: digest(value.segments.map(row => row.text).join(' ')) });
                    return value;
                } };
            const result = await prepareListening(manifest, settings);
            const cached = await prepareListening(manifest, settings);
            const record = { round, concurrency, threadsPerJob: threads, elapsedMs: result.elapsedMs,
                cachedElapsedMs: cached.elapsedMs, cacheHits: cached.audio.filter(row => row.cached).length,
                processes: runtime, qualityPassed: true,
                sumWorkerPeakBytes: runtime.every(row => Number.isFinite(row.peakMemoryBytes)) ?
                    runtime.reduce((sum, row) => sum + row.peakMemoryBytes, 0) : null };
            records.push(record);
            await atomicJson(join(options.directory, 'progress.json'), { records });
            await options.onRound?.({ round, concurrency, elapsedMs: record.elapsedMs, cachedElapsedMs: record.cachedElapsedMs });
        }
    }
    const median = rows => [...rows].sort((a, b) => a - b)[Math.floor(rows.length / 2)];
    const modes = [1, 2].map(concurrency => ({ concurrency, threadsPerJob: concurrency === 1 ? 4 : 2,
        medianMs: median(records.filter(row => row.concurrency === concurrency).map(row => row.elapsedMs)),
        medianCachedMs: median(records.filter(row => row.concurrency === concurrency).map(row => row.cachedElapsedMs)) }));
    const baseline = modes[0], parallel = modes[1];
    const baselineTexts = records[0].processes.map(worker => worker.textHash).sort().join(',');
    const consistentTranscripts = records.every(row => row.processes.map(worker => worker.textHash).sort().join(',') === baselineTexts);
    return { schemaVersion: 1, at: new Date().toISOString(), localOnly: true, paidCalls: 0,
        processStartup: 'Every uncached job starts a new Python process and loads the model; subsequent rounds may benefit from OS file caching.',
        peakMemoryNote: 'sumWorkerPeakBytes is the sum of individual worker peaks, not a sampled concurrent machine peak.',
        rounds, records, modes, consistentTranscripts,
        suggestedConcurrency: consistentTranscripts && parallel.medianMs < baseline.medianMs ? 2 : 1,
        relativeElapsed: parallel.medianMs / baseline.medianMs,
        limitation: 'Two short local synthetic clips; this does not establish performance or accuracy on full-length exams.' };
}

async function main() {
    const args = process.argv.slice(2), options = {};
    for (let i = 0; i < args.length; i++) {
        if (!['--manifest', '--directory', '--model', '--python', '--dependencies'].includes(args[i]) || !args[i + 1]) throw new Error('INVALID_BENCHMARK_ARGUMENT');
        options[args[i].slice(2)] = args[++i];
    }
    if (!options.manifest || !options.directory || !options.model) throw new Error('BENCHMARK_MANIFEST_DIRECTORY_MODEL_REQUIRED');
    const manifestFile = resolve(options.manifest), directory = resolve(options.directory);
    // A new benchmark directory avoids reporting cached ASR as raw speed.
    await mkdir(directory);
    const report = await benchmark(JSON.parse(await readFile(manifestFile, 'utf8')), { ...options,
        directory, baseDir: dirname(manifestFile), onRound: row => console.log(JSON.stringify(row)) });
    await atomicJson(join(directory, 'benchmark.json'), report);
    console.log(JSON.stringify({ complete: true, modes: report.modes, suggestedConcurrency: report.suggestedConcurrency,
        relativeElapsed: report.relativeElapsed, paidCalls: 0 }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
    main().catch(error => { console.error(error.message); process.exitCode = 1; });
