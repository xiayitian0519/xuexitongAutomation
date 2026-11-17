import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateAnswers } from '../deepseek-console/answer-contract.mjs';
import { validateManifest, buildListeningQuestions } from './contracts.mjs';
import { prepareListening } from './pipeline.mjs';
import { runtimeDefaults } from './runtime-profile.mjs';
import { checkLocalAsr } from './preflight.mjs';
export { validateManifest, validateTranscript, buildListeningQuestions } from './contracts.mjs';
export { runTranscriber, runRawTranscriber } from './transcriber.mjs';

export async function previewPractice(manifest, options = {}) {
    const prepared = await prepareListening(manifest, options);
    const questions = buildListeningQuestions(manifest, prepared.transcripts);
    let answers = null, usage = null;
    if (options.answer === true) {
        if (options.signal?.aborted) throw new Error('ABORTED');
        const requester = options.requester || (await import('../deepseek-console/wb-cli-request.mjs')).requestAnswers;
        answers = validateAnswers(questions, await requester(questions, undefined, {
            signal: options.signal, onMeta: meta => { usage = meta; },
        }));
    }
    return { schemaVersion: 1, purpose: 'listening-practice-preview', at: new Date().toISOString(),
        phase: answers ? 'answers-previewed' : 'transcribed', submitted: false,
        questionCount: questions.length, audio: prepared.audio, elapsedMs: prepared.elapsedMs,
        concurrency: prepared.concurrency, questions: manifest.questions, answers, usage };
}

async function main() {
    const args = process.argv.slice(2), options = {};
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--answer') options.answer = true;
        else if (['--manifest', '--output', '--python', '--model', '--dependencies', '--cache-dir', '--concurrency', '--threads'].includes(args[i]) &&
            args[i + 1] && !args[i + 1].startsWith('--')) {
            const key = args[i].slice(2); options[key] = args[++i];
        } else throw new Error('参数无效。使用 --manifest 清单.json --output 结果.json [--answer] [--concurrency 1|2]');
    }
    if (!options.manifest || !options.output) throw new Error('必须指定 --manifest 与 --output');
    const manifestPath = resolve(options.manifest), output = resolve(options.output);
    try { await stat(output); throw new Error('输出文件已存在，请使用新文件名，避免重复消耗额度'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await mkdir(dirname(output), { recursive: true });
    const manifest = validateManifest(JSON.parse(await readFile(manifestPath, 'utf8')));
    await checkLocalAsr(options);
    const defaults = await runtimeDefaults(options.model || process.env.LISTENING_MODEL);
    const report = await previewPractice(manifest, { ...defaults, ...options, cacheDir: options['cache-dir'],
        ...(options.concurrency === undefined ? {} : { concurrency: Number(options.concurrency) }),
        ...(options.threads === undefined ? {} : { threads: Number(options.threads) }),
        baseDir: dirname(manifestPath) });
    await writeFile(output, JSON.stringify(report, null, 2), { flag: 'wx' });
    console.log(JSON.stringify({ phase: report.phase, questionCount: report.questionCount, audioCount: report.audio.length,
        elapsedMs: report.elapsedMs, concurrency: report.concurrency,
        model: report.usage?.model || null, credit: report.usage?.credit ?? null, submitted: false }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
    main().catch(error => { console.error(error.message); process.exitCode = 1; });
