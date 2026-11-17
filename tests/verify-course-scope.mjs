import assert from 'node:assert/strict';
import { BrowserDriver } from '../automation/browser-driver.mjs';
import { parseArgs, selectRunItems, executeSelectedQueue } from '../automation/run.mjs';

const A = 'course:100:200', B = 'course:101:201', CLOSED = 'course:99:199';
const courses = [
    { key: A, status: 'available', title: 'Course A' },
    { key: CLOSED, status: 'available', title: 'Old course still accessible' },
    { key: B, status: 'available', title: 'Course B' },
];
const options = parseArgs(['--run', '--questions-only', '--course-key', A, '--course-key', B]);
assert.deepEqual(options.courseKeys, [A, B]);
assert.equal(options.questionsOnly, true);
for (const argv of [
    ['--run', '--course-key'], ['--run', '--course-key', '100'],
    ['--run', '--course-key', `${A}:work:1`], ['--run', '--course-key', A, '--course-key', A],
    ['--status', '--course-key', A], ['--scan', '--questions-only'],
]) assert.throws(() => parseArgs(argv));

const calls = [];
const driver = new BrowserDriver({});
driver.courses = async () => courses;
driver.courseList = async (course, kind) => {
    calls.push([course.key, kind]);
    return [{ key: `${kind}:1`, kind, id: '1', title: 'Synthetic', status: 'pending' }];
};
const plan = await driver.discover({ courseKeys: [A, B] });
assert.deepEqual(calls, [[A, 'work'], [A, 'chapter'], [B, 'work'], [B, 'chapter']]);
assert.equal(plan.courseCount, 2);
assert.equal(plan.items.length, 4);
calls.length = 0;
await assert.rejects(driver.discover({ courseKeys: [A, 'course:999:999'] }), /未扫描或执行/);
assert.equal(calls.length, 0, 'unknown selected course fails before any course navigation');

const foreign = { ...plan.items[0], key: `${CLOSED}:work:1`, courseTitle: 'Old course' };
const selection = selectRunItems({ items: [foreign, ...plan.items], courseKeys: [A, B] });
assert.equal(selection.items.length, 4);
assert.ok(selection.items.every(item => !item.key.startsWith(CLOSED)));
await assert.rejects(executeSelectedQueue({ items: [foreign, ...plan.items], options: { ...options, taskKeys: [foreign.key] },
    checkpoint: async () => {}, execute: async () => assert.fail('No execution'), verify: async () => ({ complete: true }) }), /范围内/);
const executed = [];
const report = await executeSelectedQueue({ items: [foreign, ...plan.items], options,
    execute: async item => { executed.push(item.key); return { status: 'verify' }; },
    verify: async () => ({ complete: true }), checkpoint: async () => {},
});
assert.equal(executed.length, 4);
assert.deepEqual(report.runScope.courseKeys, [A, B]);
assert.ok(executed.every(key => !key.startsWith(CLOSED)));
console.log('PASS exact course allowlist: discovery, selection, execution and unknown-course rejection; no browser/model/platform traffic');
