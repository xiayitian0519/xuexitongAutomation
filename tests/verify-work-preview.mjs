import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { pageSnapshot } from '../automation/page-snapshot.mjs';

const { JSDOM } = await import(new URL('../node_modules/jsdom/lib/api.js', import.meta.url));
let groups = 0;
function snapshot(path, body = '', hostname = 'mooc1-api.chaoxing.com') {
    const dom = new JSDOM(`<body>${body}</body>`, {
        url: `https://${hostname}${path}`, runScripts: 'outside-only',
    });
    try { return dom.window.eval(`(${pageSnapshot.toString()})()`); }
    finally { dom.window.close(); }
}
function check(label, run) {
    run(); groups++; console.log(`PASS ${label}`);
}
const assertPreview = result => {
    assert.equal(result.kind, 'work-preview');
    assert.equal(result.readOnly, true);
    assert.equal(result.confirmed, false);
    assert.equal(result.entry, undefined);
    assert.equal(result.items.length, 0);
};

check('exact preview endpoint is a separate read-only class without a form', () => {
    assertPreview(snapshot('/mooc-ans/mooc2/work/preview', '<div class="mark_table"><div class="questionLi">模拟题目</div></div>'));
});
check('completion words inside preview content never confirm a submission', () => {
    assertPreview(snapshot('/mooc-ans/mooc2/work/preview',
        '<div class="questionLi">模拟文本：已完成、已提交、提交时间、待批阅、待批改、提交成功</div>'));
});
check('decoy controls and answer labels cannot turn preview into an answer page', () => {
    assertPreview(snapshot('/mooc-ans/mooc2/work/preview',
        '<form><input type="radio"><textarea></textarea><button>开始作答</button><button>提交</button></form>'));
});
check('query strings do not change the exact preview classification', () => {
    assertPreview(snapshot('/mooc-ans/mooc2/work/preview?workId=100&courseId=200', '<p>模拟内容</p>'));
});
for (const path of ['/mooc-ans/mooc2/work/preview-extra', '/mooc-ans/mooc2/work/preview/', '/other/work/preview']) {
    check('nearby paths are not broadened into a preview or answer page', () => {
        const result = snapshot(path, '<p>已完成</p>');
        assert.equal(result.kind, 'unknown');
        assert.notEqual(result.confirmed, true);
    });
}
check('original task entry keeps its existing classification and entry label', () => {
    const result = snapshot('/mooc-ans/mooc2/work/task', '<button>开始作答</button>');
    assert.equal(result.kind, 'work-entry'); assert.equal(result.entry, '开始作答');
    assert.equal(result.confirmed, false); assert.notEqual(result.readOnly, true);
});
check('original task completion state remains available on its own endpoint', () => {
    const result = snapshot('/mooc-ans/mooc2/work/task', '<p>已提交</p>');
    assert.equal(result.kind, 'work-entry'); assert.equal(result.confirmed, true);
});
check('original dowork endpoint remains an answer page', () => {
    const result = snapshot('/mooc-ans/mooc2/work/dowork', '<input type="radio">');
    assert.equal(result.kind, 'work'); assert.notEqual(result.readOnly, true);
});
check('original prompt endpoint requires its existing positive completion evidence', () => {
    const result = snapshot('/mooc-ans/mooc2/work/prompt', '<p>提交成功</p>');
    assert.equal(result.kind, 'work-result'); assert.equal(result.confirmed, true);
    const pending = snapshot('/mooc-ans/mooc2/work/prompt', '<p>模拟状态</p>');
    assert.equal(pending.kind, 'work-result'); assert.equal(pending.confirmed, false);
});
check('foreign hosts cannot acquire a platform preview classification', () => {
    const result = snapshot('/mooc-ans/mooc2/work/preview', '<p>已完成</p>', 'example.com');
    assert.equal(result.kind, 'unknown'); assert.notEqual(result.confirmed, true);
});
console.log(`All ${groups} work-preview fixture groups passed. Zero real browser, model or platform requests.`);
