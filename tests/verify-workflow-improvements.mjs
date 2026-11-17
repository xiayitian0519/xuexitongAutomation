// Reproducible offline gate. Tests use fake network/model implementations.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
const execute = promisify(execFile), root = resolve(import.meta.dirname, '..');
await mkdir(join(root, '.tmp'), { recursive: true });
const directory = await mkdtemp(join(root, '.tmp/workflow-checks-'));
const tests = ['verify-listening-pipeline.mjs', 'verify-exam-recovery.mjs', 'verify-exam-workflow.mjs',
    'verify-listening.mjs', 'verify-cli-long-prompt.mjs', 'verify-wb-cli.mjs',
    'verify-text-questions.mjs', 'verify-request-cancel.mjs'];
const results = [];
for (const file of tests) {
    const started = performance.now();
    try {
        const output = await execute(process.execPath, [join(root, 'tests', file)],
            { cwd: root, windowsHide: true, timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
        await writeFile(join(directory, file + '.log'), output.stdout + output.stderr);
        results.push({ file, passed: true, elapsedMs: Math.round(performance.now() - started) });
        console.log('PASS ' + file);
    } catch (error) {
        await writeFile(join(directory, file + '.log'), String(error.stdout || '') + String(error.stderr || ''));
        results.push({ file, passed: false, elapsedMs: Math.round(performance.now() - started) });
        console.error('FAIL ' + file + '; diagnostic retained under .tmp');
        process.exitCode = 1; break;
    }
}
await writeFile(join(directory, 'summary.json'), JSON.stringify({ at: new Date().toISOString(), localOnly: true,
    realPlatformRequests: 0, paidModelCalls: 0, results }, null, 2));
console.log(JSON.stringify({ passed: results.filter(row => row.passed).length, expected: tests.length,
    diagnostics: directory, realPlatformRequests: 0, paidModelCalls: 0 }));
