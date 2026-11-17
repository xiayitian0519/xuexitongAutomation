// Offline BrowserDriver tests with DOM snapshots and a fake page. No browser, network or model.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { BrowserDriver } from '../automation/browser-driver.mjs';
import { pageSnapshot } from '../automation/page-snapshot.mjs';

// Same local fixture dependency used by verify-orchestrator.mjs.
const { JSDOM } = await import(new URL('../node_modules/jsdom/lib/api.js', import.meta.url));
const snapshot = (html) => {
    const dom = new JSDOM(html, { url: 'https://i.chaoxing.com/interaction', runScripts: 'outside-only' });
    try { return dom.window.eval(`(${pageSnapshot.toString()})()`); }
    finally { dom.window.close(); }
};
const validCard = '<div class="learnCourse" id="c_100"><h3><a href="https://mooc1.chaoxing.com/visit/stucoursemiddle?courseid=100&clazzid=200">课程甲</a></h3></div>';
const badCards = {
    invalidId: '<div class="learnCourse" id="unknown">无编号</div>',
    noAnchor: '<div class="learnCourse" id="c_101">没有入口</div>',
    rejectedUrl: '<div class="learnCourse" id="c_101"><h3><a href="https://other.test/">外域入口</a></h3></div>',
    missingIds: '<div class="learnCourse" id="c_101"><h3><a href="https://mooc1.chaoxing.com/visit/stucoursemiddle?courseid=101">缺班级编号</a></h3></div>',
};
for (const [field, card] of Object.entries(badCards)) {
    const data = snapshot(`<div id="courseList">${validCard}${card}</div>`);
    assert.equal(data.items.length, 1, 'fixture has one valid card, so the prior implementation would silently return a subset');
    assert.equal(data.diagnostics[field], 1);
    const driver = new BrowserDriver({});
    driver.waitKind = async () => ({ frame: {}, data });
    await assert.rejects(driver.collectPages({}, { frame: {}, data }), (error) =>
        error.code === 'LIST_INCOMPLETE' && error.message.includes(`${field}=1`) && error.message.includes('未启动执行'));
}
console.log('PASS 同页部分卡片解析失败：四种诊断均拒绝部分成功');

// An all-invalid list is incomplete, rather than a falsely successful empty list or login timeout.
{
    const data = snapshot(`<div id="courseList">${badCards.noAnchor}</div>`);
    const driver = new BrowserDriver({});
    driver.waitKind = async () => ({ frame: {}, data });
    await assert.rejects(driver.collectPages({}, { frame: {}, data }), { code: 'LIST_INCOMPLETE' });
    console.log('PASS 全部卡片无法解析时明确报列表不完整');
}

const chapter = (id, status = 'pending') => ({
    kind: 'chapter', id, key: `chapter:${id}`, status, selector: `#cur${id}`, title: `章节${id}`,
});
const course = { key: 'course:100:200', href: 'https://mooc1.chaoxing.com/mycourse/stu?courseid=100&clazzid=200' };
const makeFixture = (pages) => {
    const tally = { entries: [], next: 0, menus: [] };
    const page = new EventEmitter();
    page.index = 0;
    page.mode = 'course-home';
    page.address = course.href;
    page.url = () => page.address;
    page.isClosed = () => false;
    const frame = {
        getByRole(role, { name }) {
            const count = role === 'link' && name === '下一页' && page.index < pages.length - 1 ? 1 : 0;
            return {
                count: async () => count,
                or(other) {
                    return {
                        count: async () => count + await other.count(),
                        click: async () => { assert.equal(count, 1); page.index++; tally.next++; },
                    };
                },
            };
        },
        locator(selector) {
            return { click: async () => {
                const row = pages[page.index].find((item) => item.selector === selector);
                assert.ok(row, 'click must refer to the currently visible page');
                assert.equal(row.status, 'pending', 'completed/unavailable chapter must never be clicked');
                tally.entries.push(selector);
                page.mode = 'player';
                page.address = `https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=${row.id}`;
            } };
        },
    };
    const current = () => ({ frame, data: {
        kind: page.mode, path: '/chapters', menus: ['章节','作业'],
        items: pages[page.index], empty: false,
        next: page.index < pages.length - 1 ? { label: '下一页' } : null,
    } });
    const driver = new BrowserDriver({ newPage: async () => page });
    driver.navigate = async (_page, href) => { assert.equal(href, course.href); page.mode = 'course-home'; page.index = 0; };
    driver.clickMenu = async (_page, label) => { tally.menus.push(label); assert.equal(label, '章节'); page.mode = 'chapters'; };
    driver.waitKind = async (_page, kinds) => { assert.ok(kinds.includes(page.mode)); return current(); };
    driver.snapshots = async () => [current()];
    return { driver, page, current, tally };
};
const target = (id) => ({ ...chapter(id), key: `${course.key}:chapter:${id}`, course, courseTitle: '课程甲' });

{
    const { driver, tally } = makeFixture([[chapter('300')], [chapter('400')]]);
    assert.equal(await driver.openItem(target('400')), null);
    assert.deepEqual(tally.entries, ['#cur400']);
    assert.equal(tally.next, 1);
    assert.deepEqual(tally.menus, ['章节']);
    console.log('PASS 第二页待完成章节可精确定位，只点击目标编号');
}
{
    const { driver, tally } = makeFixture([[chapter('300')], [chapter('400','complete')]]);
    assert.equal((await driver.openItem(target('400'))).status, 'verify');
    assert.equal(tally.next, 1);
    assert.deepEqual(tally.entries, []);
    console.log('PASS 第二页已完成章节不点击，交给平台状态复核');
}
{
    const { driver, tally } = makeFixture([[chapter('300')], [chapter('400')]]);
    const result = await driver.openItem(target('999'));
    assert.equal(result.status, 'blocked');
    assert.match(result.reason, /遍历章节分页/);
    assert.equal(tally.next, 1);
    assert.deepEqual(tally.entries, []);
    console.log('PASS 未知章节编号遍历分页后阻止，不点击其他任务');
}
{
    const { driver, page, current, tally } = makeFixture([[chapter('300')], [chapter('400')]]);
    page.mode = 'chapters';
    assert.deepEqual((await driver.collectPages(page, current())).map((item) => item.id), ['300','400']);
    assert.equal(tally.next, 1);
    assert.deepEqual(tally.entries, []);
    console.log('PASS 扫描仍可收集所有分页，未点击章节任务');
}
{
    const { driver, tally } = makeFixture([[chapter('300')], [chapter('400'),chapter('400')]]);
    assert.equal((await driver.openItem(target('400'))).status, 'blocked');
    assert.deepEqual(tally.entries, []);
    console.log('PASS 当前页章节编号重复时阻止，不点击歧义入口');
}
console.log('BrowserDriver pagination/completeness: 7 groups passed');
