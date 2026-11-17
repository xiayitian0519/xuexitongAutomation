// Offline regression for the real completed chapter marker. No browser, network or model.
import assert from 'node:assert/strict';
import { pageSnapshot } from '../automation/page-snapshot.mjs';
const { JSDOM } = await import(new URL('../node_modules/jsdom/lib/api.js', import.meta.url));
const address = 'https://mooc2-ans.chaoxing.com/mooc2-ans/mycourse/studentcourse';
const marker = '<div class="catalog_task"><div class="catalog_state icon_yiwanc catalog_tishi56"><span class="bntHoverTips">已完成<i></i></span></div></div>';
const chapter = (content,id='900000001') => `<div class="chapter_item" id="cur${id}" title="静电场力做功"><div class="catalog_title"><div class="catalog_name newCatalog_name">静电场力做功</div>${content}</div></div>`;
const snapshot = (body) => {
    const dom = new JSDOM(body,{ url:address,runScripts:'outside-only' });
    try { return JSON.parse(JSON.stringify(dom.window.eval(`(${pageSnapshot.toString()})()`))); }
    finally { dom.window.close(); }
};
const completed = snapshot(chapter(marker)).items[0];
assert.equal(completed.status,'complete'); assert.equal(completed.remaining,0); assert.equal(completed.reason,'平台明确显示已完成');
console.log('PASS 精确完成容器、icon_yiwanc类和span提示识别为已完成');

for (const [label, content] of [
    ['只有文字','<p>已完成</p>'],
    ['缺少任务容器',marker.replace('class="catalog_task"','class="other"')],
    ['缺少状态类',marker.replace('catalog_state ','')],
    ['缺少完成图标类',marker.replace('icon_yiwanc ','')],
    ['相似图标类',marker.replace('icon_yiwanc ','icon_yiwanc_other ')],
    ['提示元素不是span',marker.replaceAll('span','div')],
    ['缺少提示类',marker.replace('bntHoverTips','other')],
    ['文案不是已完成',marker.replace('已完成','未完成')],
    ['相似但不精确文案',marker.replace('已完成','已完成部分')],
]) {
    const item = snapshot(chapter(content)).items[0];
    assert.equal(item.status,'unavailable',label); assert.equal(item.remaining,null,label);
}
console.log('PASS 九类相似但不精确的证据均不推断已完成');

for (const count of ['1','2','999','加载中']) {
    const item = snapshot(chapter(`<span class="catalog_points_yi">${count}</span>${marker}`)).items[0];
    assert.equal(item.status,'unavailable'); assert.match(item.reason,/冲突/);
    assert.equal(item.remaining,/^\d+$/.test(count)?Number(count):null);
}
console.log('PASS 正数或无法解析的计数与完成标记冲突时拒绝认完成');

const legacy = snapshot(chapter('<span class="catalog_points_yi">0</span>') +
    chapter('<span class="catalog_points_yi">2</span>','400') +
    chapter(`<span class="catalog_points_yi">0</span>${marker}`,'500')).items;
assert.deepEqual(legacy.map(item=>[item.status,item.remaining]),[['complete',0],['pending',2],['complete',0]]);
console.log('PASS 原零计数、正计数以及零计数配完成标记保持正确');

const scoped = snapshot(chapter(chapter(marker,'400')) + chapter('','500')).items;
assert.deepEqual(scoped.map(item=>[item.id,item.status]),[['900000001','unavailable'],['400','complete'],['500','unavailable']]);
console.log('PASS 完成提示只能证明所属章节，不能污染父章节或相邻章节');

const styledMarker = marker.replace('class="bntHoverTips"','class="bntHoverTips" style="display:none"');
assert.equal(snapshot(chapter(styledMarker)).items[0].status,'complete','platform tooltip text is normally hidden until hover');
console.log('PASS 平台悬停提示默认隐藏时仍依据准确状态标记识别');
console.log('Chapter completion marker: 6 groups passed');
