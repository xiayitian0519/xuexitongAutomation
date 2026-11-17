import { hostname, availableParallelism, totalmem } from 'node:os';
import { stat, realpath } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { optionalJson, atomicJson } from './transcript-store.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
export const PROFILE = join(root, '.automation.local/listening-runtime.json');
async function machine(model) {
    const path = await realpath(model), info = await stat(join(path, 'model.bin'));
    return { hostname: hostname(), processors: availableParallelism(), memoryBytes: totalmem(),
        modelPath: path, modelSize: info.size, modelModifiedMs: info.mtimeMs };
}
export async function saveRuntimeProfile(report, model, file = PROFILE) {
    if (report.rounds < 3 || !report.consistentTranscripts || report.records.some(row => !row.qualityPassed)) throw new Error('BENCHMARK_PROFILE_NOT_QUALIFIED');
    const concurrency = report.suggestedConcurrency;
    await atomicJson(file, { schemaVersion: 1, machine: await machine(model), concurrency,
        threads: concurrency === 2 ? 2 : 4, verifiedAt: report.at,
        sample: 'two-local-synthetic-clips', modes: report.modes });
}
export async function runtimeDefaults(model, file = PROFILE) {
    const fallback = { concurrency: 1, threads: 4, profile: 'unverified-default' };
    if (!model) return fallback;
    const profile = await optionalJson(file);
    if (!profile) return fallback;
    if (profile.schemaVersion !== 1 || ![1, 2].includes(profile.concurrency)) throw new Error('LISTENING_RUNTIME_PROFILE_INVALID');
    const current = await machine(model);
    if (JSON.stringify(profile.machine) !== JSON.stringify(current)) return fallback;
    return { concurrency: profile.concurrency, threads: profile.threads, profile: 'local-benchmark' };
}
