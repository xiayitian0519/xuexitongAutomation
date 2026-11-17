import assert from 'node:assert/strict';
import { BrowserDriver } from '../automation/browser-driver.mjs';

let navigations = 0;
let follows = 0;
let kinds;
const page = { on() {}, off() {} };
const driver = new BrowserDriver({ newPage: async () => page });
driver.navigate = async () => { navigations++; };
driver.waitKind = async (_page, expected) => {
    kinds = expected;
    return { data: { kind: 'work-preview', confirmed: false }, frame: {} };
};
driver.followTaskEntry = async () => { follows++; };
const result = await driver.openItem({ kind: 'work', href: 'https://example.chaoxing.com/work/task' });
assert.ok(kinds.includes('work-preview'));
assert.deepEqual(result, { status: 'blocked', readonlySkip: true,
    reason: '平台仅打开作业预览页，没有确认可作答入口，未填写或提交' });
assert.equal(navigations, 1);
assert.equal(follows, 0);
assert.equal(driver.taskPages.size, 1);
console.log('PASS preview entry is recognized, held before answer injection, and never treated as complete');
