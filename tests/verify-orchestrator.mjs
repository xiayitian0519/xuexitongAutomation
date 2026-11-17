// Real headless Edge, with every network request fulfilled by fixtures. No real platform/model traffic.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BrowserDriver, loadBrowserEngine, isPlatformUrl } from '../automation/browser-driver.mjs';
import { pageSnapshot } from '../automation/page-snapshot.mjs';
import { executeQueue, cleanError } from '../automation/task-queue.mjs';
import { parseArgs, STATE_DIR, saveLoginSession, restoreLoginSession } from '../automation/run.mjs';
const { JSDOM } = await import(new URL('../node_modules/jsdom/lib/api.js', import.meta.url));
const snapshot = (html, path = 'https://mooc1.chaoxing.com/mooc2/work/list') => {
    const dom = new JSDOM(html, { url: path, runScripts: 'outside-only' });
    try { return dom.window.eval(`(${pageSnapshot.toString()})()`); } finally { dom.window.close(); }
};
assert.equal(isPlatformUrl('https://chaoxing.com.evil.test/a'), false);
assert.equal(isPlatformUrl('http://i.chaoxing.com/base'), false);
assert.equal(snapshot('<input type="password">').kind, 'login');
assert.equal(snapshot('<p>提交成功</p>', 'https://mooc1.chaoxing.com/mooc-ans/mooc2/work/prompt').confirmed, true);
assert.equal(snapshot('<p>成绩正在加载</p>', 'https://mooc1.chaoxing.com/mooc-ans/mooc2/work/prompt').confirmed, false);
const modernCard = '<ul id="courseList"><li class="course clearfix" id="course_100_200"><a href="https://mooc1.chaoxing.com/mooc-ans/visit/stucoursemiddle?courseid=100&clazzid=200"><img></a><a href="https://mooc1.chaoxing.com/mooc-ans/visit/stucoursemiddle?courseid=100&clazzid=200">新课程页</a></li></ul>';
assert.equal(snapshot(modernCard).items[0].title, '新课程页', 'actual li.course layout uses text anchor instead of empty cover link');
assert.equal(snapshot(modernCard.replace('id="course_100_200"','id="course_999_200"')).items.length, 0, 'card IDs must match navigation IDs');
assert.throws(() => parseArgs(['--run','--scan']));
assert.throws(() => parseArgs(['--task-seconds','-1']));
assert.equal(parseArgs(['--run','--course','物理']).course, '物理');
assert.equal(parseArgs([]).mode, 'scan');
assert.ok(!cleanError(new Error('failed https://mooc1.chaoxing.com/a?enc=SECRET token=SECRET')).includes('SECRET'));

// A temporarily empty course container after sign-in must not close the login window early.
const loadingDriver = new BrowserDriver({ newPage: async () => ({}) });
loadingDriver.navigate = async () => {};
loadingDriver.snapshots = async () => [{ data: { kind: 'courses', path: '/interaction', menus: [], items: [] } }];
let loadingAttempts = 0;
loadingDriver.collectPages = async () => {
    if (++loadingAttempts === 1) throw Object.assign(new Error('list still loading'), { code: 'LIST_NOT_READY' });
    return [{ title: '加载完成的课程' }];
};
assert.equal((await loadingDriver.courses({ loginMs: 5000 }))[0].title, '加载完成的课程');
assert.equal(loadingAttempts, 2);

const one = { key: 'work:1', kind: 'work', title: 'Test', status: 'pending', href: 'https://mooc1.chaoxing.com/a?enc=SECRET' };
let calls = 0;
const checkpointed = [];
let report = await executeQueue({ items: [one,one], previous: [{ key: one.key, status: 'running' }],
    execute: async () => { calls++; }, verify: async () => ({ complete: true }), checkpoint: async (r) => checkpointed.push(JSON.stringify(r)) });
assert.equal(calls, 0); assert.equal(report.items.length, 1); assert.equal(report.items[0].status, 'needs-review');
report = await executeQueue({ items: [one], execute: async () => { calls++; return { status: 'verify' }; },
    verify: async () => ({ complete: false }), checkpoint: async (r) => checkpointed.push(JSON.stringify(r)) });
assert.equal(calls, 1); assert.equal(report.items[0].status, 'needs-review', 'filling/submission without platform evidence is not completion');
assert.ok(checkpointed.every((row) => !row.includes('SECRET') && !row.includes('href')));
let stop = false;
report = await executeQueue({ items: [one,{...one,key:'work:2'}], stopped: () => stop,
    execute: async () => { stop = true; }, verify: async () => { throw new Error('should not verify after stop'); }, checkpoint: async () => {} });
assert.equal(report.phase, 'stopped'); assert.equal(report.items[0].status, 'interrupted');
assert.equal(report.items[1].status, 'queued');
console.log('PASS contracts: URL boundary, login/results, args, redaction, duplicate/interrupted queue, stop, completion evidence');

const engine = await loadBrowserEngine();
mkdirSync(STATE_DIR, { recursive: true });
const sessionTest = mkdtempSync(join(STATE_DIR, 'session-test-'));
let sessionContext;
try {
    const sessionFile = join(sessionTest, 'session.json');
    sessionContext = await engine.chromium.launchPersistentContext(join(sessionTest, 'first'), { channel: 'msedge', headless: true });
    await sessionContext.setOffline(true);
    await sessionContext.addCookies([
        { name: 'fixture_session', value: 'FAKE_SESSION_FOR_OFFLINE_TEST', domain: '.chaoxing.com', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' },
        { name: 'unrelated', value: 'DO_NOT_PRESERVE', domain: 'other.test', path: '/', expires: -1 },
    ]);
    await saveLoginSession(sessionContext, sessionFile);
    const saved = JSON.parse(readFileSync(sessionFile, 'utf8'));
    assert.equal(saved.cookies.length, 1);
    assert.equal(saved.cookies[0].expires, -1, 'do not extend or rewrite server expiry');
    saved.cookies.push({ ...saved.cookies[0], name: 'expired', expires: 1 });
    saved.cookies.push({ ...saved.cookies[0], name: 'wrong_host', domain: 'chaoxing.com.evil.test' });
    writeFileSync(sessionFile, JSON.stringify(saved));
    await sessionContext.close(); sessionContext = null;
    sessionContext = await engine.chromium.launchPersistentContext(join(sessionTest, 'second'), { channel: 'msedge', headless: true });
    await sessionContext.setOffline(true);
    await restoreLoginSession(sessionContext, sessionFile);
    const restored = await sessionContext.cookies();
    assert.equal(restored.length, 1);
    assert.equal(restored[0].value, 'FAKE_SESSION_FOR_OFFLINE_TEST');
    console.log('PASS private session: survives browser restart; unrelated and expired cookies rejected; original expiry preserved');
} finally {
    await sessionContext?.close();
    if (dirname(sessionTest) !== STATE_DIR) throw new Error('refusing test cleanup outside private state directory');
    rmSync(sessionTest, { recursive: true, force: true });
}
const browser = await engine.chromium.launch({ channel: 'msedge', headless: true });
try {
    const context = await browser.newContext();
    await context.setOffline(true); // Fail closed even if a redirect or browser service bypasses routing.
    const tally = { answers: 0, submitWork: 0, submitChapter: 0, blockedRequests: 0 };
    const workDone = new Set(), chapterDone = new Set();
    const jquery = readFileSync(new URL('../node_modules/jquery/dist/jquery.js', import.meta.url),'utf8');
    const question = '<section><div>【单选题】1+1=?</div><label><span>A</span><input name="q" type="radio"><span>1</span></label><label><span>B</span><input name="q" type="radio"><span>2</span></label></section>';
    const workItem = (id, status, extraPath = 'task') => `<li role="link" onclick="goTask(this)" data="https://mooc1.chaoxing.com/mooc-ans/mooc2/work/${extraPath}?workId=${id}" aria-label="测试作业${id} ; ${status}"><h3>测试作业${id}</h3><p class="status">${status}</p></li>`;
    const chapterItem = (id, remaining) => `<div class="chapter_item" id="cur${id}" title="测试章节${id}" onclick="window.open('https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=${id}','_blank')"><div class="catalog_title"><a class="clicktitle">测试章节${id}</a><span class="catalog_points_yi">${remaining}</span><span>1个待完成任务点</span></div></div>`;
    await context.route('**/*', async (route) => {
        const u = new URL(route.request().url());
        let html = '';
        const json = (body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body),
            headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Private-Network': 'true' } });
        if (u.hostname === '127.0.0.1') {
            if (route.request().method() === 'OPTIONS') return json({});
            if (u.pathname === '/health') return json({ ok: true });
            if (u.pathname === '/answer') { tally.answers++; return json({ answers: [{ id: 1, letters: ['B'] }] }); }
        }
        if (u.hostname === 'i.chaoxing.com') html = `<title>个人空间</title><div name="课程" title="课程" onclick="document.querySelector('iframe').src='https://mooc2-ans.chaoxing.com/interaction'">课程</div><iframe></iframe>`;
        else if (u.pathname === '/interaction') html = `<div id="courseList">${[100,101].map(id=>`<div class="learnCourse" id="c_${id}"><h3><a href="https://mooc1.chaoxing.com/visit/stucoursemiddle?courseid=${id}&clazzid=200">测试课程${id}</a></h3></div>`).join('')}<div id="isState"><div class="learnCourse" id="c_999"><h3><a href="https://mooc1.chaoxing.com/visit/stucoursemiddle?courseid=999&clazzid=200">旧课程</a></h3>课程已结束</div></div></div>`;
        else if (u.pathname === '/visit/stucoursemiddle') html = `<script>location.replace('https://mooc2-ans.chaoxing.com/mooc2-ans/mycourse/stu?courseid=${u.searchParams.get('courseid')}&clazzid=200')</script>`;
        else if (u.pathname === '/mooc2-ans/mycourse/stu') html = `<a title="作业" href="javascript:;" onclick="document.querySelector('iframe').src='https://mooc1.chaoxing.com/mooc2/work/list?courseid=${u.searchParams.get('courseid')}'">作业</a><a title="章节" href="javascript:;" onclick="document.querySelector('iframe').src='https://mooc2-ans.chaoxing.com/chapters?courseid=${u.searchParams.get('courseid')}'">章节</a><iframe></iframe>`;
        else if (u.pathname === '/mooc2/work/list') html = `<div id="workFocus"></div><ul>${u.searchParams.get('courseid') === '101' ? workItem(11,workDone.has('11')?'待批阅':'未交')+workItem(12,'已完成') : workItem(1,workDone.has('1')?'待批阅':'未交')+workItem(2,'已完成')+workItem(3,'未知状态')+workItem(4,'待互评','eval-list')}</ul>`;
        else if (u.pathname === '/chapters') html = u.searchParams.get('courseid') === '101' ? chapterItem(400,chapterDone.has('400')?0:1) : chapterItem(300,chapterDone.has('300')?0:1)+chapterItem(301,1)+chapterItem(302,0);
        else if (u.pathname.endsWith('/work/task')) html = `<a target="_blank" href="/mooc-ans/mooc2/work/dowork?workId=${u.searchParams.get('workId')}">开始作答</a>`;
        else if (u.pathname.endsWith('/work/dowork')) html = `<div>题量：1</div>${question}<button onclick="fetch('/__test/work?id=${u.searchParams.get('workId')}',{method:'POST'}).then(()=>location.href='/mooc-ans/mooc2/work/prompt?workId=${u.searchParams.get('workId')}')">提交</button>`;
        else if (u.pathname.endsWith('/work/prompt')) html = '<p>提交成功，待批阅</p>';
        else if (u.pathname === '/__test/work') { workDone.add(u.searchParams.get('id')); tally.submitWork++; return json({ok:true}); }
        else if (u.pathname === '/__test/chapter') { chapterDone.add(u.searchParams.get('id')); tally.submitChapter++; return json({ok:true}); }
        else if (u.pathname.includes('/mycourse/studentstudy')) {
            html = `<script>${jquery.replace(/<\/script/gi,'<\\/script')}</script><div id="coursetree"></div>`;
            if (['300','400'].includes(u.searchParams.get('chapterId'))) html += `<div class="prev_title" title="章节测验">章节测验</div><div>题量：1</div>${question}<button onclick="fetch('/__test/chapter?id=${u.searchParams.get('chapterId')}',{method:'POST'}).then(()=>{const e=document.createElement('p');e.textContent='本次成绩100分 我的答案：';document.body.append(e)})">提交</button>`;
            else html += '<div class="prev_title" title="资料">资料</div><p>此处不是视频或测验</p>';
        } else { tally.blockedRequests++; return route.abort(); }
        return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: `<!doctype html><html><body>${html}</body></html>` });
    });
    const driver = new BrowserDriver(context, { timeoutMs: 30000 });
    const plan = await driver.discover({ loginMs: 1000 });
    assert.equal(plan.courseCount, 2, 'both available courses found; closed course excluded');
    assert.equal(plan.issues.length, 0, JSON.stringify(plan.issues));
    assert.equal(plan.items.length, 9, 'peer-review is excluded');
    assert.equal(plan.items.filter((row) => row.status === 'pending').length, 5);
    assert.equal(tally.answers, 0, 'scanning never calls model');
    assert.equal(tally.submitWork+tally.submitChapter, 0, 'scanning never submits');
    console.log('PASS real browser scan: portal → course iframe → course home → work list + chapter list; no model/submission');
    const pendingWork = plan.items.find(item => item.kind === 'work' && item.status === 'pending');
    await assert.rejects(driver.execute({ ...pendingWork, id: '9999' }), /作业编号与队列不一致/);
    assert.equal(tally.answers, 0, 'wrong work identity is rejected before model calls');
    const missingIdDriver = new BrowserDriver(context, { timeoutMs: 30000 });
    missingIdDriver.openItem = async () => {
        missingIdDriver.worker = missingIdDriver.trackTaskPage(await context.newPage());
        await missingIdDriver.navigate(missingIdDriver.worker, 'https://mooc1.chaoxing.com/mycourse/studentstudy');
        return null;
    };
    await assert.rejects(missingIdDriver.execute(plan.items.find(item => item.kind === 'chapter')), /没有可核实的章节编号/);
    assert.equal(tally.answers, 0, 'missing chapter identity is rejected before injection');
    let unrelated;
    const originalOpen = driver.openItem.bind(driver);
    driver.openItem = async item => {
        const value = await originalOpen(item);
        if (!unrelated) { unrelated = await context.newPage(); await unrelated.setContent('<title>Unrelated tab</title>'); }
        return value;
    };
    report = await executeQueue({ items: plan.items, execute: (item) => driver.execute(item), verify: (item) => driver.verify(item), checkpoint: async () => {} });
    assert.equal(tally.answers, 4, 'both courses: one work and one chapter quiz each call model once');
    assert.equal(tally.submitWork, 2); assert.equal(tally.submitChapter, 2);
    assert.equal(report.items.filter((row) => row.status === 'complete').length, 4, JSON.stringify(report));
    assert.equal(report.items.filter((row) => row.status === 'blocked').length, 1, 'unsupported document remains unresolved');
    assert.equal(report.phase, 'finished-with-unresolved');
    assert.equal(unrelated.isClosed(), false, 'unrelated tab opened during execution is preserved');
    assert.equal(context.pages().length, 3, 'all task popups cleaned up; only navigation/catalog/unrelated remain');
    assert.equal(tally.blockedRequests, 0);
    console.log('PASS real browser execution: two courses in sequence; popup work/chapter; real script fill/submit; fresh-list verification; wrong/missing task ID blocked; unrelated tab preserved');
} finally { await browser.close(); }
console.log('All controller checks passed. All browser traffic was intercepted locally; no real model, course, or submission requests.');
