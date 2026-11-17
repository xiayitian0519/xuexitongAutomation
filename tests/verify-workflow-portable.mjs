import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, relative, isAbsolute } from 'node:path';
import { atomicJson } from '../listening/transcript-store.mjs';

// These suites inject fake package runners and browser engines; no setup,
// authentication, actual Edge or paid request is executed by this allowlist.
const scripts = ['verify-workflow-setup', 'verify-session-bootstrap', 'verify-portable-package', 'verify-listening-setup'];
const root = resolve(import.meta.dirname, '..'), execute = promisify(execFile);
const args = process.argv.slice(2), started = performance.now();
if (args.length && (args.length !== 2 || args[0] !== '--report')) throw new Error('USE_OPTIONAL_REPORT_PATH');
const results = await Promise.all(scripts.map(async name => {
    const start = performance.now();
    try {
        const { stdout } = await execute(process.execPath, [resolve(root, 'tests', name + '.mjs')],
            { cwd: root, windowsHide: true, timeout: 60000, maxBuffer: 1024 * 1024 });
        let summary;
        for (const line of stdout.trim().split(/\r?\n/).reverse()) {
            try { const item = JSON.parse(line); if (item.passed === true && Number.isInteger(item.groups)) { summary = item; break; } }
            catch { /* A suite may also print human-readable assertion names. */ }
        }
        if (!summary || summary.groups < 1) throw new Error('TEST_SUMMARY_MISSING');
        return { script: 'tests/' + name + '.mjs', passed: true, groups: summary.groups, elapsedMs: Math.round(performance.now() - start) };
    } catch (error) {
        const stderr = String(error.stderr || '');
        const safeCode = /(?:Error|AssertionError[^:]*):\s*([A-Z][A-Z0-9_]{2,120})(?:\b|$)/.exec(stderr)?.[1];
        const sourceLine = /verify-[a-z-]+\.mjs:(\d+):/.exec(stderr)?.[1];
        return { script: 'tests/' + name + '.mjs', passed: false, groups: 0, code: 'OFFLINE_PORTABLE_CHECK_FAILED',
            exitCode: Number.isInteger(error.code) ? error.code : null,
            ...(safeCode ? { reason: safeCode } : {}), ...(sourceLine ? { line: Number(sourceLine) } : {}) };
    }
}));
const report = { version: 1, at: new Date().toISOString(), revision: '2026-11-17-portable-v1',
    passed: results.every(row => row.passed), scripts: scripts.length, groups: results.reduce((sum, row) => sum + row.groups, 0),
    elapsedMs: Math.round(performance.now() - started), newBrowsers: 0, desktopActions: 0, networkRequests: 0, paidCalls: 0, results,
    limits: ['Injected browser engines and package runners; no actual installation or authentication.', 'A new-machine real browser and real task are not validated by this suite.'] };
if (args.length) {
    const target = resolve(root, args[1]), part = relative(resolve(root, 'deliverables'), target);
    if (!part || part.startsWith('..') || isAbsolute(part) || !target.endsWith('.json')) throw new Error('REPORT_MUST_BE_IN_DELIVERABLES');
    await atomicJson(target, report);
}
console.log(JSON.stringify(report, null, 2));
if (!report.passed) process.exitCode = 1;
