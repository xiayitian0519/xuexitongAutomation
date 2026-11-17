// Offline regression for the exact empty-directory layout observed in four real courses.
import assert from 'node:assert/strict';
import { pageSnapshot } from '../automation/page-snapshot.mjs';
import { BrowserDriver } from '../automation/browser-driver.mjs';
const { JSDOM } = await import(new URL('../node_modules/jsdom/lib/api.js', import.meta.url));
const address = 'https://mooc2-ans.chaoxing.com/mooc2-ans/mycourse/studentcourse';
const html = '<div id="fanyaChapter" class="fanyaChapter clearfix"><div class="chapter_head clearfix">已完成任务点: 0/0</div><div class="chapter_body xs_table"><div class="chapter_th">目录</div><div class="nodata"><p>暂无章节内容</p></div><div class="chapter_td"><div class="chapter_verticalLine"></div></div></div></div>';
const snapshot = (body, url = address) => {
    const dom = new JSDOM(body,{ url,runScripts: 'outside-only' });
    try { return dom.window.eval(`(${pageSnapshot.toString()})()`); }
    finally { dom.window.close(); }
};
const empty = snapshot(html);
assert.equal(empty.kind,'chapters'); assert.equal(empty.empty,true); assert.equal(empty.items.length,0);
console.log('PASS 真实路径、空目录容器和明确文案识别为空章节列表');
for (const [label, body, url] of [
    ['其他路径',html,'https://mooc2-ans.chaoxing.com/other'],
    ['缺少目录容器',html.replace('chapter_body xs_table','other-container')],
    ['缺少nodata容器',html.replace('class="nodata"','class="placeholder"')],
    ['只有正文文案','<p>暂无章节内容</p>'],
    ['加载中的相似文案',html.replace('暂无章节内容','暂无章节内容，正在加载')],
    ['只有0/0计数','<div class="chapter_body xs_table">目录</div><p>已完成任务点: 0/0</p>'],
    ['隐藏空提示',html.replace('class="nodata"','class="nodata" style="display:none"')],
    ['hidden空提示',html.replace('class="nodata"','class="nodata" hidden')],
]) {
    assert.notEqual(snapshot(body,url).kind,'chapters',label);
}
console.log('PASS 八类缺少精确证据的页面均不认空章节目录');
const populated = snapshot(html.replace('<div class="chapter_td">','<div class="chapter_item" id="cur300"><span class="catalog_points_yi">1</span></div><div class="chapter_td">'));
assert.equal(populated.kind,'chapters'); assert.equal(populated.empty,false); assert.equal(populated.items.length,1); assert.equal(populated.items[0].status,'pending');
console.log('PASS 存在章节项时不被残留空提示覆盖');
const driver = new BrowserDriver({});
const current = { frame: {},data: empty };
driver.waitKind = async () => current;
assert.deepEqual(await driver.collectPages({},current),[]);
console.log('PASS 总控接受已确认的空目录，不等待加载超时');
console.log('Empty chapter directory: 4 groups passed');
