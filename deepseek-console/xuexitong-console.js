(function xuexitongMain() {
const PAGE = window;
const $ = (...args) => PAGE.jQuery(...args);
const APP_KEY = '__xuexitongConsoleDeepSeek';
const BOOT_TIMER_KEY = '__xuexitongConsoleDeepSeekBootTimer';
const INSTANCE_KEY = '__xuexitongConsoleDeepSeekInstance';
const instance = {};
const managed = PAGE.__xuexitongManaged === true;
function reportManaged(phase, message) {
if (managed && PAGE[INSTANCE_KEY] === instance) PAGE.__xuexitongManagedState = { phase, message, at: Date.now() };
}
const LOCAL_URL = 'http://127.0.0.1:37841';
const LOCAL_TOKEN = '__LOCAL_TOKEN__';
const startedByKeeper = PAGE.__xuexitongAutoInjected === true;
const initialMode = PAGE.__xuexitongRequestedMode === 'auto' ? 'auto' : 'preview';
delete PAGE.__xuexitongRequestedMode;
delete PAGE.__xuexitongAutoInjected;
let navigationKeeper = PAGE.__xuexitongKeeperRef || null;
// 只允许两类页面，且都必须是 chaoxing.com 域：
//   course —— 课程播放页，走视频 + 章节测验流程
//   work   —— 独立作业页 /mooc-ans/mooc2/work/dowork，只做题目识别与答案预览
const originOk = /^https:\/\/([a-z0-9-]+\.)*chaoxing\.com$/i.test(location.origin);
const pageKind = !originOk ? ''
: location.pathname.includes('/mycourse/studentstudy') ? 'course'
: /\/mooc-ans\/mooc2\/work\/dowork/i.test(location.pathname) ? 'work'
: '';
if (!pageKind) {
console.error('本脚本只支持两个页面：学习通课程播放页（/mycourse/studentstudy）和独立作业页（/mooc-ans/mooc2/work/dowork）。当前地址不在支持范围：', location.href);
return;
}
if (LOCAL_TOKEN === '__LOCAL_TOKEN__') {
console.error('请先启动 DeepSeek 本地服务，再复制更新后的 xuexitong-console.js');
return;
}
PAGE[INSTANCE_KEY] = instance;

const previousApp = PAGE[APP_KEY];
if (previousApp && typeof previousApp.destroy === 'function') {
previousApp.destroy();
}
if (PAGE.__xuexitongPlayerV3 && typeof PAGE.__xuexitongPlayerV3.destroy === 'function') {
PAGE.__xuexitongPlayerV3.destroy();
}
if (PAGE.__xuexitongPlayerV4DeepSeek && typeof PAGE.__xuexitongPlayerV4DeepSeek.destroy === 'function') {
PAGE.__xuexitongPlayerV4DeepSeek.destroy();
}
if (PAGE[BOOT_TIMER_KEY]) {
clearInterval(PAGE[BOOT_TIMER_KEY]);
PAGE[BOOT_TIMER_KEY] = null;
}
// 作业页不需要“整页跳转后重新注入脚本”的辅助窗口，避免多余弹窗
if (pageKind === 'course' && !startedByKeeper && !managed) installNavigationKeeper();
fetch(`${LOCAL_URL}/health`, {
headers: { 'X-Xuexitong-Token': LOCAL_TOKEN },
signal: AbortSignal.timeout(5000),
}).then((response) => {
if (PAGE[INSTANCE_KEY] !== instance) return;
if (!response.ok) throw new Error(`HTTP ${response.status}`);
console.log('DeepSeek 本地服务已连接');
if (pageKind === 'work') {
// 作业页不需要 jQuery、课程目录和播放器，直接进入预览模式
startWorkPreview();
return;
}
if (typeof PAGE.jQuery === 'undefined') {
const script = document.createElement('script');
script.src = 'https://code.jquery.com/jquery-3.6.0.min.js';
script.type = 'text/javascript';
script.onload = function () {
if (PAGE[INSTANCE_KEY] !== instance) return;
console.log('jQuery loaded.');
waitForCoursePage();
};
script.onerror = () => console.error('jQuery 加载失败，脚本无法启动');
document.head.appendChild(script);
} else {
waitForCoursePage();
}
}).catch((error) => {
if (PAGE[INSTANCE_KEY] !== instance) return;
reportManaged('blocked', `本地服务不可用：${error.message}`);
console.error('DeepSeek 本地服务不可用，请先启动服务并检查 Edge 本地网络权限:', error);
});

function installNavigationKeeper() {
let keeper;
try {
keeper = PAGE.open('', 'xuexitongConsoleKeeper', 'width=360,height=150');
if (!keeper) throw new Error('浏览器阻止了辅助窗口');
navigationKeeper = keeper;
keeper.document.title = '学习通自动任务辅助窗口';
keeper.document.body.innerHTML = '<p style="font:16px sans-serif;padding:12px">学习通自动任务正在运行。请保持此窗口打开；课程页整页跳转后，它会重新启动脚本。</p>';
keeper.__xuexitongSource = `(${xuexitongMain.toString()})();`;
keeper.__xuexitongMode = initialMode;
keeper.__xuexitongLastUrl = location.href;
keeper.__xuexitongLastInjectionAt = Date.now();
if (!keeper.__xuexitongKeeperTimer) {
keeper.eval(`window.__xuexitongKeeperTimer = setInterval(function () {
                    try {
                        var page = window.opener;
                        if (!page || page.closed) { clearInterval(window.__xuexitongKeeperTimer); window.close(); return; }
                        if (!/^https:\\/\\/([a-z0-9-]+\\.)*chaoxing\\.com\\/mycourse\\/studentstudy/i.test(page.location.href)) return;
                        if (page.location.href !== window.__xuexitongLastUrl) {
                            window.__xuexitongLastUrl = page.location.href;
                            window.__xuexitongLastInjectionAt = Date.now() - 30000;
                        }
                        if (page.document.readyState !== 'complete' || !page.document.querySelector('#coursetree')) return;
                        if (page.__xuexitongConsoleDeepSeek || page.__xuexitongConsoleDeepSeekBootTimer) return;
                        if (Date.now() - window.__xuexitongLastInjectionAt < 30000) return;
                        window.__xuexitongLastInjectionAt = Date.now();
                        page.__xuexitongAutoInjected = true;
                        page.__xuexitongRequestedMode = window.__xuexitongMode;
                        page.__xuexitongKeeperRef = window;
                        page.eval(window.__xuexitongSource);
                    } catch (error) {
                        if (Date.now() - (window.__xuexitongLastErrorAt || 0) > 30000) {
                            window.__xuexitongLastErrorAt = Date.now();
                            window.document.body.textContent = '整页跳转后的自动恢复遇到错误：' + error.message;
                            console.warn('学习通整页跳转后的自动恢复暂不可用:', error);
                        }
                    }
                }, 1000);`);
}
keeper.blur();
PAGE.focus();
console.log('整页跳转辅助窗口已启动；请保持它打开');
} catch (error) {
console.warn('整页跳转后无法自动重新启动脚本；请允许此站点打开弹出窗口，或在新页面重新粘贴脚本。', error);
}
}
function waitForCoursePage() {
let attempts = 0;
const maxAttempts = 20;
PAGE[BOOT_TIMER_KEY] = setInterval(() => {
if (PAGE[INSTANCE_KEY] !== instance) return;
if ($('#coursetree').length > 0) {
clearInterval(PAGE[BOOT_TIMER_KEY]);
PAGE[BOOT_TIMER_KEY] = null;
initializePlayer();
return;
}
attempts++;
if (attempts >= maxAttempts) {
clearInterval(PAGE[BOOT_TIMER_KEY]);
PAGE[BOOT_TIMER_KEY] = null;
console.error('%c脚本启动超时：未检测到课程目录（#coursetree）。请确认当前处于课程播放页。', 'color:#F44336;font-weight:bold');
reportManaged('blocked', '未检测到课程目录，未启动自动处理');
}
}, 1000);
}
const mediaSource = (video) => video?.getAttribute?.('src') ||
video?.querySelector?.('source[src]')?.getAttribute('src') || video?.currentSrc || video?.src || '';

// Read the loaded content as well as the card address: adjacent steps can share a label.
function learningStepSnapshot(app) {
const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
const shown = (el) => Boolean(el && el.isConnected && el.getClientRects().length &&
el.ownerDocument.defaultView.getComputedStyle(el).visibility !== 'hidden');
const address = (value, base = location.href) => {
try {
const url = new URL(value, base);
const params = new Map(Array.from(url.searchParams, ([key, entry]) => [key.toLowerCase(), entry]));
return { chapter: params.get('chapterid') || params.get('knowledgeid') || '', index: params.get('num') ?? '',
key: `${url.origin}${url.pathname}|${params.get('chapterid') || params.get('knowledgeid') || ''}|${params.get('num') ?? ''}` };
} catch (_) { return { chapter: '', index: '', key: '' }; }
};
const frames = Array.from(document.querySelectorAll('iframe[src*="/knowledge/cards"]')).filter(shown);
const frame = frames.length === 1 ? frames[0] : null;
const source = frame ? address(frame.getAttribute('src')) : { chapter: '', index: '', key: '' };
let cardDocument = null;
try { cardDocument = frame?.contentDocument || null; } catch (_) {}
const loaded = cardDocument ? address(cardDocument.location.href) : { key: '' };
const documents = [];
const visit = (doc, depth = 0) => {
if (!doc || depth > 3 || documents.includes(doc)) return;
documents.push(doc);
for (const child of doc.querySelectorAll('iframe')) {
if (!shown(child)) continue;
try { visit(child.contentDocument, depth + 1); } catch (_) {}
}
};
visit(frame ? cardDocument : document);
const videos = documents.flatMap((doc) => Array.from(doc.querySelectorAll('video'))).filter(shown);
let video = videos.includes(app._videoEl) ? app._videoEl : videos[0] || null;
// Keep the existing no-card player fallback, but never use its stale cache for a card.
if (!frame && !frames.length && !video) {
const candidate = app._getVideoEl();
if (candidate && candidate.isConnected !== false && (!candidate.ownerDocument || documents.includes(candidate.ownerDocument))) video = candidate;
}
const labels = Array.from(document.querySelectorAll('#prev_tab .prev_white,#prev_tab .prev_blue,.prev_ul .prev_white,.prev_ul .prev_blue'));
const indexedLabel = /^\d+$/.test(source.index) ? labels[Number(source.index)] : null;
const labelKind = (value) => {
const label = clean(value).replace(/^\d+\s*[.、]?\s*/, '');
return /^(教学)?视频$/.test(label) ? '视频' : /^(章节)?测验$/.test(label) ? '章节测验' : '';
};
const hint = labelKind(indexedLabel?.textContent) || labelKind(cardDocument?.title) ||
labelKind(document.querySelector('.prev_title')?.title || document.querySelector('.prev_title')?.textContent);
const quizDocuments = documents.filter((doc) => /[\[【（(](单选题|多选题|判断题|填空题|简答题|计算题)(?:\s*[,，、]?\s*\d+(?:\.\d+)?\s*分)?[\]】）)]/.test(doc.body?.innerText || '') ||
/本次成绩\s*\d+(?:\.\d+)?\s*分/.test(doc.body?.innerText || ''));
const kind = indexedLabel && !labelKind(indexedLabel.textContent) ? '' :
hint || (quizDocuments.length ? '章节测验' : video ? '视频' : '');
const documentReady = frames.length <= 1 && (!frame || (cardDocument &&
['interactive', 'complete'].includes(cardDocument.readyState) && source.key === loaded.key && Boolean(cardDocument.body)));
const mediaReady = Boolean(video && !video.ended && !video.error && video.networkState !== 3 &&
(!video.ownerDocument || ['interactive', 'complete'].includes(video.ownerDocument.readyState)) &&
(typeof video.readyState !== 'number' || video.readyState >= 1 || mediaSource(video)));
let quizReady = quizDocuments.some((doc) => /本次成绩\s*\d+(?:\.\d+)?\s*分/.test(doc.body?.innerText || ''));
if (!quizReady && quizDocuments.length) {
try { quizReady = (app.inspectQuiz?.().length || 0) > 0; } catch (_) { /* Editors may still be loading. */ }
}
const activeId = document.querySelector('.posCatalog_active[id^="cur"]')?.id.match(/^cur(\d+)$/)?.[1] || '';
const chapterIds = [address(location.href).chapter, source.chapter, activeId].filter(Boolean);
return { frame, cardDocument, cardKey: source.key, index: source.index, kind, video, videos,
videoSource: mediaSource(video), quizDocument: quizDocuments[0] || null,
chapterIds, ready: Boolean(documentReady && ((kind === '视频' && mediaReady) || (kind === '章节测验' && quizReady))) };
}

function attachQuizAutomation(app) {
const attemptedQuizzes = new Set();
const activeRequests = new Set();
const managedChapter = managed && pageKind === 'course' ? learningStepSnapshot(app).chapterIds[0] || '' : '';
let quizBusy = false;
let stopped = false;
const leftManagedChapter = (step) => managed && managedChapter && step.chapterIds.some((id) => id !== managedChapter);
function finishManagedChapter(message) {
stopped = true;
app._automationStopped = true;
app._isPlaying = false;
app._clearCheckInterval();
app._detachVideoEvents?.();
reportManaged('verify', message);
}
const originalPlay = app.play?.bind(app);
if (originalPlay) app.play = function (...args) {
if (blockPolicyVideo(this)) return null;
if (stopped || this._nextUnitPending || PAGE[INSTANCE_KEY] !== instance) return;
if (leftManagedChapter(learningStepSnapshot(app))) {
finishManagedChapter('已离开当前小节，等待目录核实完成状态');
return;
}
return originalPlay(...args);
};
function stoppedError() {
const error = new Error('脚本已停止，已取消模型请求');
error.name = 'AbortError';
return error;
}
const originalDestroy = app.destroy.bind(app);
app.destroy = function () {
stopped = true;
this._automationStopped = true;
for (const controller of activeRequests) controller.abort(stoppedError());
activeRequests.clear();
reportManaged('stopped', '当前执行器已停止，未完成的模型请求已取消');
originalDestroy();
};

// ===== 预览模式（默认） =====
// 只读题目、只调模型、只打印结果；不勾选、不提交、不处理确认框、不跳下一节。
const previewState = { busy: false, lastSignature: '', lastAnswers: null, prompted: false, pending: new Map() };
const PREVIEW_COMMAND = 'app.previewQuiz()';
const questionSignature = (questions) => JSON.stringify(questions.map((q) =>
({ kind: q.kind, sourceKind: q.sourceKind || q.kind, title: q.title, options: q.options.map((o) => [o.letter, o.text]),
blankCount: q.editors?.length || 0, images: (q.images || []).map((img) =>
[img.currentSrc || img.src, img.naturalWidth, img.naturalHeight]) })));

function answerPolicy() {
const policy = PAGE.__xuexitongAnswerPolicy || window.__xuexitongAnswerPolicy;
return { questionsOnly: policy?.questionsOnly === true, skipWorkedSolutions: policy?.skipWorkedSolutions === true };
}

function blockPolicyVideo(controller) {
if (!answerPolicy().questionsOnly || controller._isChapterTest?.()) return false;
controller._isPlaying = false;
controller._clearCheckInterval?.();
reportManaged('blocked', '本轮仅处理题目，视频任务已跳过；请由总控进入章节测验');
return true;
}

app._blockPolicyVideo = () => blockPolicyVideo(app);

function assertAnswerPolicy(questions = null) {
if (!answerPolicy().skipWorkedSolutions) return;
const workedKinds = /^(?:简答题|计算题|解答题|证明题|论述题)$/;
const typeLabel = /[\[【（(]\s*(?:简答题|计算题|解答题|证明题|论述题)(?:\s*[,，、]?\s*\d+(?:\.\d+)?\s*分)?\s*[\]】）)]|(?:题型|题目类型)\s*[:：]\s*(?:简答题|计算题|解答题|证明题|论述题)|^(?:\d+\s*[.、．]?\s*)?(?:简答题|计算题|解答题|证明题|论述题)(?:\s|[:：,，]|$)/;
const needsSteps = (value) => {
const text = clean(value).replace(/(?:无需|不必|不需要|不用|不要求)[^。！？;；]{0,12}(?:步骤|过程|推导|证明|论证)/g, '');
return /(?:写出|写明|写|给出|列出|列明|展示|说明|描述|提供|要求|必须|需要|应当|需|请)[^。！？;；]{0,24}(?:步骤|过程|推导|证明|论证)|(?:解题|计算|推导|证明|论证)(?:过程|步骤)|(?:详细|完整|具体)(?:地)?(?:说明|解释|分析|推导|证明|解答)|^(?:\d+\s*[.、．]?\s*)?(?:请|试)?(?:证明|求证|推导|论证)(?:\s|[:：]|下列|以下|公式|结论|关系|该|此)/.test(text);
};
const reject = () => {
const error = new Error('本轮跳过需要步骤、推导或长文字的题目；当前整份题目已停止，未继续作答或提交 [ANSWER_POLICY_WORKED_SOLUTION]');
error.code = 'ANSWER_POLICY_WORKED_SOLUTION';
throw error;
};
for (const question of questions || []) {
if (workedKinds.test(question.sourceKind || question.kind) || needsSteps(question.title)) reject();
}
for (const doc of courseDocuments({ visibleOnly: true })) {
if (!doc.body) continue;
const clone = doc.body.cloneNode(true);
clone.querySelectorAll('textarea,input,select,iframe,[contenteditable],.edui-editor,.edui-toolbar,.tox,.cke,script,style,noscript,template').forEach((element) => element.remove());
const walker = doc.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
let node;
while ((node = walker.nextNode())) if (typeLabel.test(clean(node.textContent)) || needsSteps(node.textContent)) reject();
// Also catches a process requirement split between inline text elements.
if (typeLabel.test(clean(clone.textContent)) || needsSteps(clone.textContent)) reject();
}
}

function isPreview() {
return (app.configs.mode || 'preview') !== 'auto';
}

function blockInPreview(action) {
if (!isPreview()) return false;
console.warn(`%c预览模式已拦截：${action}。本模式不会改动页面，如需全自动请先执行 app.setMode('auto')`, 'color:#FF9800;font-weight:bold');
return true;
}

function enterPreviewWait() {
app._videoEl = null;
app._isPlaying = false;
app._clearCheckInterval();
if (previewState.prompted) return null;
previewState.prompted = true;
console.log('%c=== 预览模式：已识别到章节测验 ===', 'color:#2196F3;font-size:15px;font-weight:bold');
console.log('%c本模式不会勾选选项、不会提交、不会处理确认框、不会跳到下一节，页面保持原样。', 'color:#607D8B');
console.log(`%c确认要分析时，在控制台执行一次：${PREVIEW_COMMAND}`, 'color:#4CAF50;font-weight:bold');
console.log('%c同一组题目只会分析一次，重复执行不会再次调用模型。', 'color:#607D8B');
return null;
}

const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const visible = (el) => Boolean(el && el.isConnected && el.getClientRects().length &&
el.ownerDocument.defaultView.getComputedStyle(el).visibility !== 'hidden');
const kindPattern = /[\[【（(](单选题|多选题|判断题|填空题|简答题|计算题)(?:\s*[,，、]?\s*\d+(?:\.\d+)?\s*分)?[\]】）)]/;
const isTextKind = (kind) => kind === '填空题' || kind === '简答题';

function answerEditors(card) {
const result = [];
// Prefer managed editor APIs, which synchronize the hidden form field too.
const w = card.ownerDocument.defaultView;
for (const editor of Object.values(w.UE?.instants || {})) {
const container = editor.container;
if (container && card.contains(container) && typeof editor.setContent === 'function' && typeof editor.getContentTxt === 'function')
result.push({ type: 'ueditor', element: container, editor });
}
for (const editor of w.tinymce?.editors || []) {
const element = editor.getElement?.();
if (element && card.contains(element) && typeof editor.setContent === 'function')
result.push({ type: 'tinymce', element, editor });
}
const managed = result.map((item) => item.editor.container || item.editor.getContainer?.() || item.element);
for (const element of card.querySelectorAll('textarea,input[type="text"],input:not([type]),[contenteditable="true"]')) {
if (element.disabled || element.readOnly || managed.some((container) => container.contains(element)) || result.some((item) => item.element === element)) continue;
if (element.closest('.edui-toolbar,.tox-toolbar,.cke_top') || !visible(element)) continue;
if (result.some((item) => item.element.contains(element))) continue;
result.push({ type: element.matches('[contenteditable="true"]') ? 'contenteditable' : 'input', element });
}
for (const frame of card.querySelectorAll('iframe')) {
if (managed.some((container) => container.contains(frame))) continue;
let body;
try { body = frame.contentDocument?.body; } catch (_) { continue; }
if (!body || !(body.isContentEditable || body.getAttribute('contenteditable') === 'true' || frame.contentDocument.designMode === 'on')) continue;
// Unknown iframe editors may maintain a hidden form value: do not silently fill those.
result.push({ type: 'unmanaged-iframe', element: frame, body });
}
return result;
}

function questionImages(card) {
return Array.from(card.querySelectorAll('img')).filter((img) =>
!img.closest('.edui-editor,.edui-toolbar,.tox,.cke,[contenteditable],script,style,noscript,template'));
}

function textWithImageRefs(root, imageNumbers, excluded = new Set()) {
const visit = (node) => {
if (excluded.has(node)) return '';
if (node.nodeType === 3) return node.textContent || '';
if (node.nodeType !== 1 || node.matches('textarea,input,iframe,[contenteditable],.edui-editor,.edui-toolbar,.tox,.cke,script,style,noscript,template')) return '';
if (node.tagName === 'IMG') {
const number = imageNumbers.get(node);
if (!number) throw new Error('题目图片缺少位置编号，已停止；不会丢弃图片后作答');
return ` [图${number}] `;
}
const text = Array.from(node.childNodes).map(visit).join('');
return /^(DIV|P|LI|LABEL|SECTION|BR)$/.test(node.tagName) ? ` ${text} ` : text;
};
return clean(visit(root));
}

function textQuestion(node, kind, seenCards, sourceKind = kind) {
let card = node.parentElement;
for (let depth = 0; card && depth < 10; depth++, card = card.parentElement) {
const markers = clean(card.innerText).match(new RegExp(kindPattern.source, 'g')) || [];
if (markers.length > 1) break;
const editors = answerEditors(card);
if (!editors.length) continue;
if (seenCards.has(card)) return null;
if (kind === '简答题' && editors.length !== 1) throw new Error('简答题检测到多个编辑区，需确认页面结构后再提交');
const images = questionImages(card);
const imageNumbers = new Map(images.map((image, index) => [image, index + 1]));
const title = textWithImageRefs(card, imageNumbers).replace(/^\d+\s*[.、．]?\s*/, '').replace(kindPattern, '').trim();
if (!title || title.length > 12000) throw new Error('文字题题干为空或过长');
seenCards.add(card);
return { kind, sourceKind, title, options: [], editors, images, card, doc: card.ownerDocument };
}
return null;
}

function courseDocuments({ visibleOnly = false } = {}) {
const result = [];
const visit = (doc, depth) => {
if (!doc || depth > 3 || result.includes(doc)) return;
result.push(doc);
for (const frame of doc.querySelectorAll('iframe')) {
if (visibleOnly && !visible(frame)) continue;
try { visit(frame.contentDocument, depth + 1); } catch (_) { /* cross origin */ }
}
};
visit(document, 0);
return result;
}

function quizCompleted() {
if (pageKind === 'work' && /\/work\/prompt(?:[/?]|$)/i.test(location.pathname)) return true;
if (pageKind === 'work' && /提交时间/.test(clean(document.body?.innerText)) && /\d+(?:\.\d+)?\s*分/.test(clean(document.body?.innerText))) return true;
const scoreShown = courseDocuments().some((doc) => {
const text = clean(doc.body?.innerText);
const hasGrade = /本次成绩\s*\d+(?:\.\d+)?\s*分/.test(text);
return hasGrade && (/章节测验\s*已完成/.test(text) || /我的答案\s*[:：]/.test(text));
});
if (scoreShown) return true;
const cardsFrame = Array.from(document.querySelectorAll('iframe[src*="/knowledge/cards"]'))
.find((frame) => frame.getClientRects().length > 0);
const isQuizStep = cardsFrame && new URL(cardsFrame.getAttribute('src'), location.href).searchParams.get('num') === '1';
return Boolean(isQuizStep && document.querySelector('.posCatalog_active .icon_Completed'));
}

function optionElements(card) {
const explicit = Array.from(card.querySelectorAll('[class*="num_option"]')).filter((el) =>
Array.from(el.classList).some((name) => /^num_option(?:_|$)/.test(name)) && /^[A-H]$/.test(clean(el.textContent)));
const labels = explicit.length ? explicit : Array.from(card.querySelectorAll('span,div,label,li,p,b,i,strong,a'))
.filter((el) => /^[A-H]$/.test(clean(el.textContent)) &&
!Array.from(el.children).some((child) => /^[A-H]$/.test(clean(child.textContent))));
const images = questionImages(card);
const imageNumbers = new Map(images.map((image, index) => [image, index + 1]));
const found = new Map();
for (const label of labels) {
const letter = clean(label.textContent);
if (found.has(letter)) continue;
let target = label;
for (let n = 0; n < 5; n++) {
const parent = target.parentElement;
if (!parent || parent === card) break;
const otherLetters = labels.filter((el) => parent.contains(el) && el !== label);
if (otherLetters.some((el) => !el.contains(label) && !label.contains(el))) break;
target = parent;
if (clean(target.innerText).length > 1) break;
}
const text = textWithImageRefs(target, imageNumbers).replace(new RegExp(`^${letter}[.、．]?\\s*`), '');
if (text) found.set(letter, { letter, text, element: target });
}
return Array.from(found.values()).sort((a, b) => a.letter.localeCompare(b.letter));
}

function extractQuestions() {
const questions = [];
for (const doc of courseDocuments()) {
if (!doc.body) continue; // Audio frames may still be loading or inaccessible.
const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
const seenCards = new Set();
let node;
while ((node = walker.nextNode())) {
const markedKind = clean(node.textContent).match(kindPattern)?.[1];
if (!markedKind || !visible(node.parentElement)) continue;
// Calculation questions use the same single-editor answer contract as short answers.
const kind = markedKind === '计算题' ? '简答题' : markedKind;
if (isTextKind(kind)) {
const question = textQuestion(node, kind, seenCards, markedKind);
if (question) questions.push(question);
continue;
}
let card = node.parentElement;
let options = [];
for (let depth = 0; card && depth < 9; depth++, card = card.parentElement) {
const cardText = clean(card.innerText);
const kinds = cardText.match(new RegExp(kindPattern.source, 'g')) || [];
if (kinds.length > 1) break;
options = optionElements(card);
if (options.length >= 2 && options.length <= 8) break;
}
if (!card || options.length < 2 || options.length > 8 || seenCards.has(card)) continue;
seenCards.add(card);
const images = questionImages(card);
const imageNumbers = new Map(images.map((image, index) => [image, index + 1]));
const title = textWithImageRefs(card, imageNumbers, new Set(options.map((option) => option.element)))
.replace(/^\d+\s*[.、．]?\s*/, '').replace(kindPattern, '').trim();
if (!title || title.length > 500 || options.some((option) => !option.text || option.text.length > 500)) continue;
questions.push({ kind, sourceKind: markedKind, title, options, images, card, doc });
}
}
return questions;
}

function buttonDisabled(element) {
return Boolean(element.disabled || element.matches(':disabled') ||
element.closest(':disabled,[inert],[aria-disabled="true" i]'));
}

function findButton(doc, label, { includeDisabled = false } = {}) {
const candidates = Array.from(doc.querySelectorAll('button,a,input[type="button"],input[type="submit"],[role="button"],div,span'))
.filter((el) => visible(el) && (includeDisabled || !buttonDisabled(el)) && clean(el.value || el.innerText) === label);
return candidates.find((el) => /^(BUTTON|A|INPUT)$/.test(el.tagName)) ||
candidates.find((el) => !Array.from(el.children).some((child) => clean(child.innerText) === label)) || null;
}

function assertQuizAvailable(questions = null, { submit = 'if-present' } = {}) {
assertAnswerPolicy(questions);
// Read-only inspection and preview remain available for existing/closed results.
if (isPreview()) return;
const docs = courseDocuments({ visibleOnly: true });
if (!questions) {
try { questions = extractQuestions(); } catch (_) { questions = []; }
}
const questionCards = questions.map((question) => question.card).filter(Boolean);
const questionDocs = Array.from(new Set(questions.map((question) => question.doc))).filter((doc) => docs.includes(doc));
// Course navigation may list unrelated tasks as unavailable. Only the current quiz document
// (or a loaded work document before questions appear) supplies its availability state.
const quizDocs = questionDocs.length ? questionDocs : docs.filter((doc) => {
if (pageKind === 'work' && doc === document) return true;
const path = doc.defaultView?.location.pathname || '';
return /\/(?:api\/work|work\/(?:doHomeWorkNew|dowork))(?:[/?]|$)/i.test(path) ||
Boolean(findButton(doc, '提交', { includeDisabled: true }));
});
const unavailable = /^(?:(?:本次|当前|该|本)?(?:作业|章节测验|测验|测试|任务)\s*)?(已截止|已过截止时间|已结束|尚未开始|未到开始时间|未到作业开始时间|未开始)(?:[，,。！!：:\s].*)?$/;
const statusRoots = [...quizDocs.map((doc) => doc.body).filter(Boolean), ...docs.flatMap((doc) =>
Array.from(doc.querySelectorAll('#popcontent,[role="dialog"],[role="alertdialog"],.layui-layer-dialog,.el-message-box,.modal')))];
for (const root of new Set(statusRoots)) {
for (const element of [root, ...root.querySelectorAll('*')]) {
if (!visible(element) || element.closest('script,style,noscript,template,textarea,input,[contenteditable],.edui-editor,.tox,.cke') ||
questionCards.some((card) => card === element || card.contains(element))) continue;
// Only the element's own status text counts; question/option text cannot poison a parent status.
const text = clean(Array.from(element.childNodes).filter((node) => node.nodeType === 3).map((node) => node.textContent).join(' '));
let state = text.match(unavailable)?.[1];
if (!state && element.children.length) {
const descendants = Array.from(element.querySelectorAll('*'));
// Status labels may split a word across inline tags, e.g. 已<span>截止</span>.
// Never join hidden template text or the broader page/question layout.
if (descendants.every((node) => /^(SPAN|B|I|STRONG|EM|SMALL)$/.test(node.tagName) && visible(node)))
state = clean(element.textContent).match(unavailable)?.[1];
}
if (!state) continue;
if (/未开始|尚未开始|未到/.test(state)) throw new Error('当前作业或测验尚未开始，自动作答已停止');
throw new Error('当前作业或测验已截止或已结束，自动作答已停止');
}
}
if (submit === false) return;
const submitDocs = questionDocs.length ? questionDocs : quizDocs;
const usable = submitDocs.some((doc) => findButton(doc, '提交'));
if (usable) return;
const disabled = submitDocs.some((doc) => {
const button = findButton(doc, '提交', { includeDisabled: true });
return button && buttonDisabled(button);
});
if (disabled) throw new Error('当前作业或测验的提交按钮已禁用，自动作答已停止');
if (submit === 'required') throw new Error('未找到可用的提交按钮，自动作答已停止');
}

function findNextButton() {
for (const doc of courseDocuments()) {
const known = doc.querySelector('#prevNextFocusNext, #right1, .nextChapter');
if (visible(known) && clean(known.innerText || known.title).includes('下一节')) return known;
const generic = findButton(doc, '下一节');
if (generic) return generic;
}
return null;
}

async function revealQuizQuestions() {
const docs = courseDocuments();
const submit = docs.map((doc) => findButton(doc, '提交')).find(Boolean);
if (!submit) return;
let scroller = submit.parentElement;
while (scroller && scroller !== submit.ownerDocument.body) {
const style = scroller.ownerDocument.defaultView.getComputedStyle(scroller);
if (/(auto|scroll)/.test(style.overflowY) && scroller.scrollHeight > scroller.clientHeight + 100) break;
scroller = scroller.parentElement;
}
if (!scroller || scroller === submit.ownerDocument.body) {
scroller = submit.ownerDocument.scrollingElement;
}
if (!scroller || scroller.scrollHeight <= scroller.clientHeight + 100) return;
scroller.scrollTop = 0;
await sleep(150);
for (let step = 0; step < 50; step++) {
const bottom = scroller.scrollHeight - scroller.clientHeight;
if (scroller.scrollTop >= bottom - 2) break;
scroller.scrollTop = Math.min(bottom, scroller.scrollTop + Math.max(300, scroller.clientHeight * 0.75));
await sleep(120);
}
}

async function waitForQuizQuestions() {
const requireSubmit = app.configs.requireSubmitButton !== false;
const detectCompleted = app.configs.detectQuizCompleted !== false;
let submitDoc = null;
if (requireSubmit) {
for (let attempt = 0; attempt < 240; attempt++) {
if (stopped) throw new Error('脚本已停止');
if (detectCompleted && quizCompleted()) return null;
assertQuizAvailable();
submitDoc = courseDocuments().find((doc) => findButton(doc, '提交'));
if (submitDoc) break;
if (attempt > 0 && attempt % 30 === 0) console.log(`测验提交按钮仍在加载，已等待 ${attempt / 2} 秒`);
await sleep(500);
}
if (!submitDoc) throw new Error('进入章节测验后等待 120 秒，仍未找到“提交”按钮。请检查题目框架是否正常加载');
} else {
// 独立作业页找不到固定的“提交”按钮，识别到题目就直接进入稳定性判定
for (let attempt = 0; attempt < 20; attempt++) {
if (stopped) throw new Error('脚本已停止');
assertQuizAvailable();
if (extractQuestions().length) break;
await sleep(300);
}
if (!extractQuestions().length) {
throw new Error('页面上没有识别到支持的题目（单选/多选/判断/填空/简答/计算）。请先执行 app.inspectPageDom() 看识别统计，并把输出发给开发者');
}
submitDoc = courseDocuments()[0] || document;
}

await revealQuizQuestions();
let previousSignature = '';
let stableCount = 0;
for (let attempt = 0; attempt < 240; attempt++) {
if (stopped) throw new Error('脚本已停止');
if (detectCompleted && quizCompleted()) return null;
assertAnswerPolicy();
const questions = extractQuestions();
assertAnswerPolicy(questions);
assertQuizAvailable(questions, { submit: requireSubmit ? 'required' : 'if-present' });
const countText = submitDoc?.body ? clean(submitDoc.body.innerText).match(/题量\s*[:：]\s*(\d+)/) : null;
const expected = countText ? Number(countText[1]) : null;
if (questions.length && (!expected || questions.length === expected)) {
const signature = questions.map((q) => `${q.kind}:${q.title}:${q.options.length}`).join('|');
stableCount = signature === previousSignature ? stableCount + 1 : 0;
previousSignature = signature;
if (stableCount >= 3) return questions;
} else {
stableCount = 0;
previousSignature = '';
}
if (attempt > 0 && attempt % 30 === 0) console.log(`测验题目仍在加载，已等待 ${attempt / 2} 秒；当前识别 ${questions.length} 道`);
await sleep(500);
}
throw new Error('测验框架已打开，但等待 120 秒仍未识别完整题目。可运行 app.inspectQuiz() 查看当前识别结果');
}

function imageFailure(code, message, details = {}) {
const safe = {};
for (const key of ['question', 'image', 'sheet', 'width', 'height', 'expectedWidth', 'expectedHeight', 'sheetWidth', 'sheetHeight', 'chars', 'bytes']) {
if (Number.isFinite(details[key]) && details[key] >= 0) safe[key] = details[key];
}
const error = new Error(`${message} [${code}${Object.entries(safe).map(([key, value]) => ` ${key}=${value}`).join('')}]`);
error.code = code; error.imageCode = code; error.imageMessage = message; error.imageDetails = safe;
return error;
}

function imageContext(error, details, code = 'IMAGE_PROCESSING', message = '题目图片处理失败，已停止；不会丢弃图片后作答') {
return error?.imageCode
? imageFailure(error.imageCode, error.imageMessage, { ...error.imageDetails, ...details })
: imageFailure(code, message, details);
}

function imageSize(image) {
const width = Number(image.naturalWidth), height = Number(image.naturalHeight);
if (!image.complete || !Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1)
throw imageFailure('IMAGE_NOT_READY', '题目图片尚未加载或已经损坏，已停止；不会仅凭文字作答', { width, height });
return { width, height };
}

function assertImageDimensions(actual, expected) {
const details = { width: actual.width, height: actual.height, expectedWidth: expected.width, expectedHeight: expected.height };
if (actual.width < expected.width || actual.height < expected.height)
throw imageFailure('IMAGE_RESOLUTION', '图片实际分辨率不足，已停止', details);
// Allow at most a source-pixel rounding difference; never stretch a different aspect ratio.
if (Math.abs(actual.width * expected.height - expected.width * actual.height) > Math.max(expected.width, expected.height))
throw imageFailure('IMAGE_ASPECT_RATIO', '图片解码后的宽高比例不一致，已停止；不会拉伸图片', details);
}

async function decodeQuestionImage(data, doc) {
const image = new doc.defaultView.Image();
try {
if (typeof image.decode === 'function') {
image.src = data;
await image.decode();
} else {
await new Promise((resolve, reject) => {
image.onload = resolve; image.onerror = reject; image.src = data;
});
}
imageSize(image);
return image;
} catch (error) { throw imageContext(error, {}, 'IMAGE_DECODE', '题目图片解码失败，已停止；不会丢弃图片后作答'); }
}

function checkedImageData(data) {
if (typeof data !== 'string' || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(data))
throw imageFailure('IMAGE_ENCODING', '题目图片编码失败，已停止', { chars: typeof data === 'string' ? data.length : 0 });
if (data.length > 1500000)
throw imageFailure('IMAGE_SIZE_LIMIT', '题目图片过大，已停止', { chars: data.length });
return data;
}

async function readSingleQuestionImage(image, details = {}) {
try {
const size = imageSize(image);
const canvas = image.ownerDocument.createElement('canvas');
const scale = Math.min(1, 1600 / Math.max(size.width, size.height));
canvas.width = Math.max(1, Math.round(size.width * scale));
canvas.height = Math.max(1, Math.round(size.height * scale));
let data;
try {
const context = canvas.getContext('2d');
if (!context) throw new Error('图片画布不可用');
context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
context.drawImage(image, 0, 0, canvas.width, canvas.height);
data = canvas.toDataURL('image/png');
} catch (_) {
// Browser same-origin/CORS rules still apply. Never ask the local server to fetch arbitrary URLs.
try {
const response = await fetch(image.currentSrc || image.src, { credentials: 'same-origin', signal: AbortSignal.timeout(10000) });
if (!response.ok) throw imageFailure('IMAGE_FETCH', '题目图片下载失败，已停止');
const blob = await response.blob();
const mime = blob.type.toLowerCase();
if (!['image/png', 'image/jpeg', 'image/jpg', 'image/webp'].includes(mime))
throw imageFailure('IMAGE_MIME', '题目图片格式不支持，已停止', { bytes: blob.size });
if (blob.size > 1000000) throw imageFailure('IMAGE_FETCH_SIZE', '下载的题目图片过大，已停止', { bytes: blob.size });
data = await new Promise((resolve, reject) => {
const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(blob);
});
// Some platform JPEG responses use image/jpg. Normalize only this explicit MIME alias.
if (mime === 'image/jpg' && typeof data === 'string') data = data.replace(/^data:image\/jpg;base64,/i, 'data:image/jpeg;base64,');
const decoded = await decodeQuestionImage(checkedImageData(data), image.ownerDocument);
assertImageDimensions(imageSize(decoded), size);
// The first canvas may be tainted. Always use a new clean canvas for decoded bytes.
const cleanCanvas = image.ownerDocument.createElement('canvas');
cleanCanvas.width = canvas.width; cleanCanvas.height = canvas.height;
try {
const context = cleanCanvas.getContext('2d');
if (!context) throw new Error('canvas unavailable');
context.fillStyle = '#fff'; context.fillRect(0, 0, cleanCanvas.width, cleanCanvas.height);
context.drawImage(decoded, 0, 0, cleanCanvas.width, cleanCanvas.height);
data = cleanCanvas.toDataURL('image/png');
} catch (error) { throw imageContext(error, { width: cleanCanvas.width, height: cleanCanvas.height }, 'IMAGE_NORMALIZE', '题目图片归一化失败，已停止'); }
} catch (error) { throw imageContext(error, {}, 'IMAGE_FETCH', '浏览器无法读取题目图片（跨域或资源受限），已停止；不会仅凭文字提交'); }
}
return checkedImageData(data);
} catch (error) { throw imageContext(error, details); }
}

async function readQuestionImages(question, questionNumber) {
const images = question.images || [];
if (images.length <= 4) return Promise.all(images.map((image, index) => readSingleQuestionImage(image, { question: questionNumber, image: index + 1 })));
// Keep formula resolution: pack numbered source images without cropping, lossy encoding,
// or shrinking a whole long sheet to the old 1600-pixel single-image boundary.
if (images.length > 32) throw new Error('单题图片过多，无法生成清晰图集，已停止');
const sizes = images.map((image, index) => {
try { return imageSize(image); } catch (error) { throw imageContext(error, { question: questionNumber, image: index + 1 }); }
});
if (sizes.reduce((sum, size) => sum + size.width * size.height, 0) > 32000000)
throw new Error('题目图片总像素过大，无法生成清晰图集，已停止');
const padding = 16, heading = 34, gap = 16, maxSide = 2048;
const plans = [];
for (let index = 0; index < images.length; index++) {
const size = sizes[index];
const scale = Math.min(1, 1600 / Math.max(size.width, size.height));
if (scale < 0.65) throw new Error('题目图片过大，合图会导致公式不可读，已停止');
const width = Math.max(1, Math.round(size.width * scale));
const height = Math.max(1, Math.round(size.height * scale));
let plan = plans[plans.length - 1];
if (!plan || plan.height + heading + height + gap > maxSide) {
plan = { width: 0, height: padding, items: [] }; plans.push(plan);
}
plan.items.push({ index, width, height, y: plan.height });
plan.width = Math.max(plan.width, width + padding * 2);
plan.height += heading + height + gap;
}
if (plans.length > 4 || plans.some((plan) => plan.width > maxSide || plan.height > maxSide || plan.width * plan.height > 4000000))
throw new Error('题目图片无法在四张清晰图集内完整呈现，已停止；不会丢图或降低可读性');
const result = [];
for (const [sheetIndex, plan] of plans.entries()) {
const canvas = images[0].ownerDocument.createElement('canvas');
canvas.width = plan.width; canvas.height = plan.height;
try {
const context = canvas.getContext('2d');
if (!context) throw new Error('图片画布不可用');
context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
context.font = 'bold 24px sans-serif'; context.textBaseline = 'top';
for (const item of plan.items) {
try {
const source = await readSingleQuestionImage(images[item.index]);
const decoded = await decodeQuestionImage(source, images[item.index].ownerDocument);
const decodedSize = imageSize(decoded);
assertImageDimensions(decodedSize, item);
context.fillStyle = '#111'; context.fillText(`Image ${item.index + 1}`, padding, item.y);
context.drawImage(decoded, padding, item.y + heading, item.width, item.height);
} catch (error) { throw imageContext(error, { image: item.index + 1 }); }
}
result.push(checkedImageData(canvas.toDataURL('image/png')));
} catch (error) { throw imageContext(error, { question: questionNumber, sheet: sheetIndex + 1, sheetWidth: canvas.width, sheetHeight: canvas.height }, 'ATLAS_CANVAS', '题目图集合成失败，已停止；不会丢弃图片后作答'); }
}
return result;
}

function editorText(target) {
if (target.type === 'ueditor') return target.editor.getContentTxt();
if (target.type === 'tinymce') return target.editor.getContent({ format: 'text' });
return target.type === 'input' ? target.element.value : target.element.textContent;
}

async function fillTextAnswers(question, texts, questions) {
const normal = (text) => String(text || '').replace(/\r\n/g, '\n').replace(/\u00a0/g, ' ').trim();
const escape = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
for (let i = 0; i < question.editors.length; i++) {
if (stopped || isPreview()) throw new Error('自动作答已停止');
assertQuizAvailable(questions, { submit: 'required' });
const target = question.editors[i], text = texts[i];
if (!target.element.isConnected) throw new Error('答题编辑器已变化，已停止提交');
if (target.type === 'unmanaged-iframe') throw new Error('检测到未支持的 iframe 编辑器，无法确认保存状态，已停止提交');
if (target.type === 'ueditor' || target.type === 'tinymce') {
const html = text.split('\n').map((line) => `<p>${escape(line) || '<br>'}</p>`).join('');
target.editor.setContent(html);
if (target.type === 'ueditor') {
if (typeof target.editor.sync !== 'function') throw new Error('UEditor 缺少同步接口，已停止提交');
target.editor.fireEvent?.('contentchange'); target.editor.sync();
} else {
if (typeof target.editor.save !== 'function') throw new Error('TinyMCE 缺少保存接口，已停止提交');
target.editor.fire?.('change'); target.editor.save();
}
} else {
if (target.type === 'input') {
const proto = target.element.tagName === 'TEXTAREA' ? target.element.ownerDocument.defaultView.HTMLTextAreaElement.prototype : target.element.ownerDocument.defaultView.HTMLInputElement.prototype;
Object.getOwnPropertyDescriptor(proto, 'value').set.call(target.element, text);
} else target.element.textContent = text;
const w = target.element.ownerDocument.defaultView;
target.element.dispatchEvent(new w.Event('input', { bubbles: true }));
target.element.dispatchEvent(new w.Event('change', { bubbles: true }));
target.element.dispatchEvent(new w.Event('blur', { bubbles: true }));
}
await sleep(150);
if (normal(editorText(target)).replace(/\s+/g, '') !== normal(text).replace(/\s+/g, ''))
throw new Error('文字答案写入后回读不一致，已停止提交');
}
}

async function askDeepSeek(questions) {
const listening = app.inspectListening();
if (listening.audioCount || listening.unresolved.length)
throw new Error('LISTENING_REQUIRES_TRANSCRIPT：检测到听力音频，先导出听力练习并转写核对；当前文字答题入口不猜听力答案');
assertQuizAvailable(questions, { submit: 'required' });
assertQuestionCoverage(questions);
const payload = await Promise.all(questions.map(async (q, i) => ({
id: i + 1,
type: q.kind,
question: q.title + (q.images.length > 4 ? '\n本题图片已合成为编号图集，请按图中“Image N”对应题干和选项里的[图N]。' :
q.images.length ? '\n本题[图N]按所附图片的顺序编号。' : ''),
options: q.options.map((o) => ({ letter: o.letter, text: o.text })),
...(isTextKind(q.kind) ? { blankCount: q.editors.length } : {}),
images: await readQuestionImages(q, i + 1),
})));
if (payload.reduce((sum, q) => sum + q.images.length, 0) > 12 ||
payload.reduce((sum, q) => sum + q.images.reduce((count, image) => count + image.length, 0), 0) > 8000000)
throw new Error('本次题目图片超过总数或总大小限制，已停止；请减少本次题目数量，不会截断图片');
console.log('本次发送给模型的题目（图片仅显示数量）：', payload.map(({images, ...q}) => ({...q, imageCount: images.length})));
if (stopped) throw new Error('脚本已停止，取消发送题目');
assertQuizAvailable(questions, { submit: 'required' });
reportManaged('running', `模型开始：${questions.length} 题`);
const controller = new AbortController();
const timeoutSignal = AbortSignal.timeout(900000);
const onTimeout = () => controller.abort(timeoutSignal.reason);
timeoutSignal.addEventListener('abort', onTimeout, { once: true });
if (timeoutSignal.aborted) onTimeout();
activeRequests.add(controller);
try {
let response;
try {
response = await fetch(`${LOCAL_URL}/answer`, {
method: 'POST',
headers: { 'Content-Type': 'application/json', 'X-Xuexitong-Token': LOCAL_TOKEN },
body: JSON.stringify({ questions: payload }),
signal: controller.signal,
});
} catch (error) {
if (stopped || PAGE[INSTANCE_KEY] !== instance) throw stoppedError();
throw new Error(`无法连接本地 DeepSeek 服务。请确认启动窗口仍在运行，且 Edge 允许本地网络访问。详情：${error.message}`);
}
const data = await response.json().catch(() => null);
if (stopped || PAGE[INSTANCE_KEY] !== instance) throw stoppedError();
if (!response.ok) throw new Error(data?.error || `本地 DeepSeek 服务返回 HTTP ${response.status}`);
return data.answers;
} finally {
timeoutSignal.removeEventListener('abort', onTimeout);
activeRequests.delete(controller);
}
}

function assertQuestionCoverage(questions) {
let marked = 0;
for (const doc of courseDocuments()) {
const clone = doc.body.cloneNode(true);
clone.querySelectorAll('textarea,input,iframe,[contenteditable],.edui-editor,.tox,.cke,script,style,noscript,template').forEach((el) => el.remove());
const text = clone.textContent || '';
if (/[\[【（(](论述题|阅读题|匹配题|排序题)(?:\s*[,，、]?\s*\d+(?:\.\d+)?\s*分)?[\]】）)]/.test(text)) throw new Error('存在未支持题型，已停止提交');
marked += (text.match(new RegExp(kindPattern.source, 'g')) || []).length;
}
if (marked !== questions.length) throw new Error(`页面有 ${marked} 个题型标记，但只识别 ${questions.length} 道题，已停止提交`);
for (const q of questions) if (isTextKind(q.kind) && q.editors.some((target) => target.type === 'unmanaged-iframe'))
throw new Error('检测到未支持的 iframe 编辑器，已停止；请提供编辑器结构以完成适配');
}

function validateAnswers(questions, answers) {
if (!Array.isArray(answers) || answers.length !== questions.length) throw new Error('AI 返回的题目数量不匹配');
const result = new Map();
for (const item of answers) {
if (!Number.isInteger(item.id) || result.has(item.id))
throw new Error('AI 答案格式错误');
const q = questions[item.id - 1];
if (!q) throw new Error('AI 返回未知题号');
if (isTextKind(q.kind)) {
if (!Array.isArray(item.texts) || item.texts.length !== q.editors.length ||
item.texts.some((text) => typeof text !== 'string' || !text.trim() || text.length > 20000))
throw new Error(`第 ${item.id} 题文字答案或空位数量不正确，已停止提交`);
result.set(item.id, { texts: item.texts.map((text) => text.trim()) });
continue;
}
if (!Array.isArray(item.letters)) throw new Error('AI 答案格式错误');
const letters = item.letters.map((letter) => clean(letter).toUpperCase());
if (!letters.length) throw new Error(`第 ${item.id} 题 AI 未给出选项，已停止提交`);
if (new Set(letters).size !== letters.length) throw new Error(`第 ${item.id} 题答案包含重复选项，已停止提交`);
if (q.kind !== '多选题' && letters.length !== 1)
throw new Error(`第 ${item.id} 题是${q.kind}，但 AI 返回了 ${letters.length} 个选项，已停止提交`);
const invalidLetters = letters.filter((letter) => !q.options.some((option) => option.letter === letter));
if (invalidLetters.length)
throw new Error(`第 ${item.id} 题 AI 返回了页面中不存在的选项：${invalidLetters.join('、')}，已停止提交`);
result.set(item.id, letters);
}
return result;
}

function platformOptionSelected(element, letter, questionNumber) {
// Chapter quizzes use li; the current standalone work page uses div.answerBg.
// Both expose a label data value and the platform's saved hidden answer.
const rowSelector = 'li[qid],div.answerBg[qid][qtype]';
const row = element.closest(rowSelector);
if (!row) return undefined;
const fail = () => { throw new Error(`第 ${questionNumber} 题平台选项与保存字段不一致，已停止提交`); };
const qid = row.getAttribute('qid');
if (!/^\d+$/.test(qid || '')) return fail();
const card = row.closest('.singleQuesId') || row.closest('.TiMu.newTiMu');
if (!card) return fail();
const markers = Array.from(card.querySelectorAll('span[data]')).filter((node) => node.classList.contains(`choice${qid}`));
const savedName = `answer${qid}`;
const saved = Array.from(card.querySelectorAll('input[type="hidden"]')).filter((input) => input.id === savedName || input.name === savedName);
if (markers.length < 2 || markers.length > 8 || saved.length !== 1) return fail();
if ((saved[0].id && saved[0].id !== savedName) || (saved[0].name && saved[0].name !== savedName)) return fail();
const letters = [], values = [];
for (const marker of markers) {
const owner = marker.closest(rowSelector), display = clean(marker.textContent), data = marker.getAttribute('data');
if (!owner || owner.getAttribute('qid') !== qid || !Array.from(marker.classList).some((name) => /^num_option(?:_|$)/.test(name)) ||
!/^[A-H]$/.test(display) || typeof data !== 'string' || !data || data.length > 32 || /\s/.test(data)) return fail();
letters.push(display); values.push(data);
}
if (new Set(letters).size !== markers.length || new Set(values).size !== markers.length) return fail();
const multi = markers.every((marker) => marker.classList.contains('num_option_dx'));
if (!multi && markers.some((marker) => marker.classList.contains('num_option_dx'))) return fail();
const selectedClass = multi ? 'check_answer_dx' : 'check_answer';
if (markers.some((marker) => marker.classList.contains(multi ? 'check_answer' : 'check_answer_dx'))) return fail();
const selectedData = markers.filter((marker) => marker.classList.contains(selectedClass)).map((marker) => marker.getAttribute('data'));
if (!multi && selectedData.length > 1) return fail();
if (multi) {
const savedData = [...saved[0].value];
if (values.some((value) => !/^[A-H]$/.test(value)) || new Set(savedData).size !== savedData.length ||
savedData.some((value) => !values.includes(value)) || [...savedData].sort().join('') !== [...selectedData].sort().join('')) return fail();
} else if (saved[0].value !== selectedData.join('')) return fail();
const own = markers.filter((marker) => row.contains(marker));
if (own.length !== 1 || clean(own[0].textContent) !== letter || !element.contains(own[0])) return fail();
return own[0].classList.contains(selectedClass);
}

function optionSelected(option, questionNumber) {
const element = option?.element;
if (!element?.isConnected) throw new Error(`第 ${questionNumber} 题选项已变化`);
const inputs = element.matches('input[type="radio"],input[type="checkbox"]')
? [element] : Array.from(element.querySelectorAll('input[type="radio"],input[type="checkbox"]'));
if (inputs.length > 1) throw new Error(`第 ${questionNumber} 题 ${option.letter} 选项包含多个选择控件，已停止提交`);
const states = inputs.map((input) => input.checked);
const platformState = platformOptionSelected(element, option.letter, questionNumber);
if (platformState !== undefined) states.push(platformState);
const ariaElements = [element, ...element.querySelectorAll('[aria-checked],[aria-pressed]')]
.filter((item) => item.hasAttribute('aria-checked') || item.hasAttribute('aria-pressed'));
for (const item of ariaElements) {
for (const attribute of ['aria-checked', 'aria-pressed']) {
if (!item.hasAttribute(attribute)) continue;
const value = item.getAttribute(attribute);
if (value !== 'true' && value !== 'false') throw new Error(`第 ${questionNumber} 题 ${option.letter} 选项状态不明确，已停止提交`);
states.push(value === 'true');
}
}
// A class is evidence only when it explicitly declares a selected/unselected state.
// Missing classes, hover styles and unrelated DOM changes never imply a selection.
if (!states.length) {
const stateElements = [element, ...element.querySelectorAll('[role="radio"],[role="checkbox"]')];
for (const item of stateElements) for (const [yes, no] of [
['is-checked', 'is-unchecked'], ['is-selected', 'is-unselected'],
['checked', 'unchecked'], ['selected', 'unselected'],
]) {
if (item.classList.contains(yes)) states.push(true);
if (item.classList.contains(no)) states.push(false);
}
}
if (!states.length || states.some((value) => value !== states[0]))
throw new Error(`第 ${questionNumber} 题 ${option.letter} 无法确认选中状态，已停止提交`);
return states[0];
}

function assertChoiceStateAvailable(questions) {
// Read every choice before spending a model call. Unknown platform state must
// fail here, rather than after an answer has been generated or a click attempted.
for (let i = 0; i < questions.length; i++) {
if (isTextKind(questions[i].kind)) continue;
for (const option of questions[i].options) optionSelected(option, i + 1);
}
}

function assertSelectedAnswers(questions, answers) {
for (let i = 0; i < questions.length; i++) {
const question = questions[i];
if (isTextKind(question.kind)) continue;
const selected = question.options.filter((option) => optionSelected(option, i + 1)).map((option) => option.letter).sort();
const expected = [...answers.get(i + 1)].sort();
if (selected.length !== expected.length || selected.some((letter, index) => letter !== expected[index]))
throw new Error(`第 ${i + 1} 题实际选中项与答案不一致，已停止提交`);
}
}

async function selectAnswers(questions, answers) {
if (blockInPreview('自动勾选选项')) throw new Error('预览模式禁止勾选选项');
assertQuizAvailable(questions, { submit: 'required' });
for (let i = 0; i < questions.length; i++) {
const q = questions[i];
if (isTextKind(q.kind)) {
await fillTextAnswers(q, answers.get(i + 1).texts, questions);
continue;
}
// Existing checkbox answers must be reconciled, rather than blindly toggled.
if (q.kind === '多选题') {
for (const option of q.options) {
const selected = optionSelected(option, i + 1);
if (selected && !answers.get(i + 1).includes(option.letter)) {
if (stopped || isPreview()) throw new Error('自动作答已停止');
assertQuizAvailable(questions, { submit: 'required' });
option.element.click();
await sleep(150);
if (optionSelected(option, i + 1))
throw new Error(`第 ${i + 1} 题旧选项未取消，已停止提交`);
}
}
}
for (const letter of answers.get(i + 1)) {
if (stopped || isPreview()) throw new Error('自动作答已停止');
assertQuizAvailable(questions, { submit: 'required' });
const option = q.options.find((item) => item.letter === letter);
if (!option?.element?.isConnected) throw new Error(`第 ${i + 1} 题选项已变化`);
if (optionSelected(option, i + 1)) continue;
option.element.scrollIntoView({ block: 'center' });
option.element.click();
await sleep(150);
if (!optionSelected(option, i + 1)) throw new Error(`第 ${i + 1} 题 ${letter} 选项未确认选中，已停止提交`);
}
}
assertSelectedAnswers(questions, answers);
}

async function confirmSubmitDialog(questions) {
if (blockInPreview('处理提交确认框')) throw new Error('预览模式禁止处理提交确认框');
for (let i = 0; i < 20; i++) {
if (stopped || isPreview()) throw new Error('自动作答已停止');
assertQuizAvailable(questions, { submit: false });
const dialogs = courseDocuments().flatMap((doc) =>
Array.from(doc.querySelectorAll('#popok,[role="dialog"],[role="alertdialog"],.layui-layer-dialog,.el-message-box,.modal')));
const platformButton = dialogs.find((el) => el.id === 'popok' && visible(el));
if (platformButton) {
if (buttonDisabled(platformButton)) throw new Error('提交确认按钮已禁用，自动作答已停止');
const message = clean(platformButton.ownerDocument.querySelector('#popcontent')?.innerText);
if (/未作答|请选择|请作答|答完/.test(message) && !/确定提交|确认提交/.test(message))
throw new Error(`平台拒绝提交：${message}`);
console.log(`确认平台提交窗口：${message || '提交'}`);
platformButton.click();
return;
}
const dialog = dialogs.find((el) => el.id !== 'popok' && visible(el) && /提交|交卷/.test(clean(el.innerText)));
if (dialog) {
const confirm = findButton(dialog, '确定') || findButton(dialog, '确认') || findButton(dialog, '提交');
if (!confirm) throw new Error('提交确认窗口未找到确认按钮');
confirm.click();
return;
}
await sleep(250);
}
}

async function submitQuiz(doc, questions, answers) {
if (blockInPreview('点击章节测验的提交按钮')) throw new Error('预览模式禁止提交');
if (stopped) throw new Error('脚本已停止');
assertQuizAvailable(questions, { submit: 'required' });
const submit = findButton(doc, '提交');
if (!submit) throw new Error('未找到测验提交按钮');
const beforeUrl = location.href;
submit.scrollIntoView({ block: 'center' });
assertSelectedAnswers(questions, answers);
console.log('选项已选择，点击章节测验的提交按钮');
submit.click();
await confirmSubmitDialog(questions);
console.log('提交已确认，等待学习通生成成绩或任务完成标记；确认后再点击“下一节”');
let elapsedHalfSeconds = 0;
while (!stopped) {
await sleep(500);
elapsedHalfSeconds++;
if (pageKind === 'work' && location.href !== beforeUrl && /\/work\/prompt(?:[/?]|$)/i.test(location.pathname)) return;
if (quizCompleted()) return;
if (elapsedHalfSeconds >= 240) throw new Error('提交后等待 120 秒仍未确认成绩或完成标记，已停止；请手动检查提交状态，不要重复提交');
if (elapsedHalfSeconds % 30 === 0) console.log(`成绩页仍在加载，已等待 ${elapsedHalfSeconds / 2} 秒`);
}
throw new Error('脚本已停止');
}

async function goToNextStep() {
if (answerPolicy().questionsOnly) return finishManagedChapter('本轮章节题目已处理，等待平台复核；不切换到视频');
if (blockInPreview('点击“下一节”跳转')) throw new Error('预览模式禁止跳到下一节');
if (stopped) throw new Error('脚本已停止');
const previous = learningStepSnapshot(app);
if (managed && !managedChapter) throw new Error('无法核实当前章节编号，已停止切换');
if (leftManagedChapter(previous)) {
finishManagedChapter('已离开当前小节，等待目录核实完成状态');
return;
}
// A card may contain several separate video iframes. Advance those only after natural end.
if (previous.kind === '视频' && previous.video?.ended) {
app._completedMedia.set(previous.video, previous.videoSource);
const nextVideo = previous.videos.find((video) => !video.ended &&
app._completedMedia.get(video) !== mediaSource(video));
if (nextVideo) {
app._clearCheckInterval();
app._detachVideoEvents?.();
app._videoEl = nextVideo;
app._isPlaying = false;
app._nextUnitPending = true;
let ready = false;
for (let attempt = 0; attempt < 240; attempt++) {
if (stopped || PAGE[INSTANCE_KEY] !== instance) throw stoppedError();
const current = learningStepSnapshot(app);
if (leftManagedChapter(current)) { finishManagedChapter('已离开当前小节，等待目录核实完成状态'); return; }
if (current.ready && current.video === nextVideo && current.cardDocument === previous.cardDocument) { ready = true; break; }
await sleep(500);
}
if (!ready) throw new Error('同一学习步骤的下一个视频等待 120 秒仍未就绪，已停止');
app._nextUnitPending = false;
reportManaged('running', `步骤切换成功：视频 ${previous.index || '0'}-${previous.videos.indexOf(previous.video) + 1} → 视频 ${previous.index || '0'}-${previous.videos.indexOf(nextVideo) + 1}`);
app.play();
return;
}
}
if (previous.kind === '视频' && previous.videos.length > 1 && !previous.video?.ended)
throw new Error('当前视频尚未自然结束，已停止切换，避免跳过同页视频');
const next = findNextButton();
if (!next) {
if (managed) {
finishManagedChapter('当前学习步骤结束，等待目录核实任务点是否完成');
return;
}
throw new Error('未找到页面下方的“下一节”按钮');
}
app._nextUnitPending = true;
const previousStep = previous.kind;
app._clearCheckInterval();
app._videoEl = null;
app._isPlaying = false;
next.scrollIntoView({ block: 'center' });
if (leftManagedChapter(learningStepSnapshot(app))) {
finishManagedChapter('已离开当前小节，等待目录核实完成状态');
return;
}
console.log(`${previousStep || '当前学习步骤'}完成，点击页面“下一节”，等待新内容加载`);
next.click();
let currentStep = '';
let stepReady = false;
let current = previous;
for (let attempt = 0; attempt < 240; attempt++) {
if (stopped || PAGE[INSTANCE_KEY] !== instance) throw stoppedError();
await sleep(500);
if (stopped || PAGE[INSTANCE_KEY] !== instance) throw stoppedError();
current = learningStepSnapshot(app);
if (leftManagedChapter(current)) {
finishManagedChapter('已离开当前小节，等待目录核实完成状态');
return;
}
currentStep = current.kind;
const contentChanged = current.frame !== previous.frame || current.cardDocument !== previous.cardDocument ||
current.cardKey !== previous.cardKey || current.video !== previous.video || current.videoSource !== previous.videoSource ||
current.quizDocument !== previous.quizDocument;
if (contentChanged && current.ready) {
stepReady = true;
break;
}
if (attempt > 0 && attempt % 30 === 0) console.log(`下一学习步骤仍在加载，已等待 ${attempt / 2} 秒；当前页签：${currentStep || '未显示'}`);
}
if (!stepReady) {
throw new Error(`点击“下一节”后等待 120 秒，新学习步骤仍未加载完成；当前页签：${currentStep || '未显示'}`);
}
app._nextUnitPending = false;
app._videoEl = current.video;
app._initCellData();
reportManaged('running', `步骤切换成功：${previousStep || '未知'} ${previous.index || '0'} → ${current.kind} ${current.index || '0'}`);
app.play();
}

app.nextUnit = function () {
if (blockInPreview('切换到下一小节/章节')) return;
if (stopped || this._nextUnitPending) return;
this._nextUnitPending = true;
goToNextStep().catch((error) => {
this._nextUnitPending = false;
if (stopped || PAGE[INSTANCE_KEY] !== instance) return;
reportManaged('blocked', error.message);
console.error('切换下一学习步骤失败:', error);
});
};

async function sharedQuizAnswers(questions, { force = false } = {}) {
const signature = questionSignature(questions);
if (previewState.pending.has(signature)) {
console.log('同一组题正在分析，等待现有请求结果（不会重复调用模型）。');
return previewState.pending.get(signature);
}
if (!force && signature === previewState.lastSignature && previewState.lastAnswers) {
return validateAnswers(questions, Array.from(previewState.lastAnswers, ([id, value]) =>
Array.isArray(value) ? { id, letters: value } : { id, texts: value.texts }));
}
const task = (async () => {
const response = await askDeepSeek(questions);
if (stopped || PAGE[INSTANCE_KEY] !== instance) throw stoppedError();
const answers = validateAnswers(questions, response);
previewState.lastSignature = signature;
previewState.lastAnswers = answers;
return answers;
})();
previewState.pending.set(signature, task);
try { return await task; }
finally { if (previewState.pending.get(signature) === task) previewState.pending.delete(signature); }
}

app.previewQuiz = async function (options = {}) {
if (stopped) throw new Error('脚本已停止');
if (previewState.busy) {
console.warn('%c上一次分析还在进行中，已忽略本次请求', 'color:#FF9800');
return null;
}
if (!app._isChapterTest()) {
console.warn('%c当前不在章节测验页，预览取消（未调用模型）', 'color:#FF9800');
return null;
}
previewState.busy = true;
try {
const questions = await waitForQuizQuestions();
if (!questions || questions.length === 0) {
console.warn('%c没有识别到题目，预览结束（未调用模型）', 'color:#FF9800');
return null;
}
const signature = questionSignature(questions);
if (!options.force && signature === previewState.lastSignature) {
console.warn('%c这组题目已经分析过，为避免重复消耗额度已跳过；确需重来请执行 app.previewQuiz({ force: true })', 'color:#FF9800');
return previewState.lastAnswers;
}
console.log(`识别到 ${questions.length} 道题，正在调用模型生成预览（本次会消耗一次额度）`);
const answers = await sharedQuizAnswers(questions, options);
const rows = questions.map((q, i) => {
const letters = answers.get(i + 1);
return {
题号: i + 1,
题型: q.kind,
题干: q.title,
建议选项: isTextKind(q.kind) ? '文字答案' : letters.join(''),
选项原文: isTextKind(q.kind) ? letters.texts.map((text, n) => `第${n + 1}空/答：${text}`).join('\n') : letters.map((letter) => `${letter}. ${q.options.find((o) => o.letter === letter)?.text || ''}`).join(' / '),
};
});
console.log('%c=== 答案预览（未勾选、未提交） ===', 'color:#4CAF50;font-size:15px;font-weight:bold');
console.table(rows);
for (const row of rows) {
console.log(`第 ${row.题号} 题【${row.题型}】${row.题干}\n  建议：${row.选项原文}`);
}
console.log('%c预览结束，页面保持原样：未勾选任何选项、未点击提交、未跳转下一节。', 'color:#607D8B');
return answers;
} catch (error) {
if (stopped || PAGE[INSTANCE_KEY] !== instance) return null;
console.error('答案预览失败：', error.message);
return null;
} finally {
previewState.busy = false;
}
};

app.setMode = function (mode) {
if (!['preview', 'auto'].includes(mode)) throw new Error('模式只能是 preview 或 auto');
this.configs.mode = mode;
try {
if (navigationKeeper && !navigationKeeper.closed) navigationKeeper.__xuexitongMode = mode;
} catch (_) { /* mode still applies to this page */ }
if (mode === 'auto') {
previewState.prompted = false;
console.warn('%c已切换到 auto 模式：启动后会自动填写并直接提交。', 'color:#F44336;font-weight:bold');
return mode;
}
previewState.prompted = false;
console.log('%c已切换到 preview 模式：只分析，不改动页面', 'color:#4CAF50');
if (this._isChapterTest()) enterPreviewWait();
return mode;
};

app.startAuto = function () {
if (stopped) throw new Error('脚本已停止，请重新粘贴脚本');
this.setMode('auto');
reportManaged('running', '正在执行当前作业或章节任务');
return pageKind === 'work' ? this._advanceChapterTest() : this.play();
};
app.stopAuto = function () {
const video = this._videoEl;
this.setMode('preview');
this.destroy();
reportManaged('stopped', '自动任务已停止');
try { if (video) video.pause(); } catch (_) {}
if (pageKind === 'course') {
try {
const keeper = navigationKeeper;
if (keeper) { keeper.clearInterval(keeper.__xuexitongKeeperTimer); keeper.close(); }
} catch (_) {}
}
console.log('自动任务已停止；已发出的提交无法撤回。重新启动请重新粘贴脚本。');
};

app.inspectQuiz = function () {
return extractQuestions().map((q, i) => ({
id: i + 1, type: q.kind, question: q.title,
options: q.options.map((o) => `${o.letter}. ${o.text}`),
blankCount: q.editors?.length || 0, imageCount: q.images?.length || 0,
}));
};

// Read-only listening export: neither fetch nor play audio. No oral recording/upload.
app.exportListeningPractice = function () {
const questions = extractQuestions();
const audio = [], unresolved = [], imageIssues = [], byUrl = new Map(), assigned = new Set();
const safeUrl = (value, doc) => {
try {
const url = new URL(value, doc.baseURI);
return url.protocol === 'https:' && !url.username && !url.password ? url.href : '';
} catch (_) { return ''; }
};
const scan = (root, id, depth = 0) => {
if (!root || depth > 3) return;
for (const element of root.querySelectorAll('audio')) {
assigned.add(element);
const urls = [element.currentSrc, element.getAttribute('src'), ...Array.from(element.querySelectorAll('source'), el => el.getAttribute('src'))]
.filter(Boolean).map(url => safeUrl(url, element.ownerDocument)).filter(Boolean);
const unique = [...new Set(urls)];
if (unique.length !== 1) { unresolved.push({ questionId: id, reason: 'audio-source-missing-or-ambiguous' }); continue; }
const url = unique[0];
if (!byUrl.has(url)) {
const row = { id: `audio-${audio.length + 1}`, questionIds: [], sourceUrl: url, path: '' };
audio.push(row); byUrl.set(url, row);
}
const row = byUrl.get(url);
if (!row.questionIds.includes(id)) row.questionIds.push(id);
}
for (const frame of root.querySelectorAll('iframe')) {
assigned.add(frame);
let child;
try { child = frame.contentDocument; } catch (_) {}
const audioFrame = /(?:\/audio(?:[/.?]|$)|type=audio|audio\.html)/i.test(frame.getAttribute('src') || '');
if (child?.body && child.body.querySelector('audio,iframe')) scan(child.body, id, depth + 1);
else if (audioFrame) unresolved.push({ questionId: id, reason: 'audio-iframe-needs-source-resolution' });
}
};
questions.forEach((question, index) => {
scan(question.card, index + 1);
if (question.images?.length) imageIssues.push({ questionId: index + 1, reason: 'question-images-need-export' });
if (/听(?:力|录音)|listen(?:ing)?|hear the|audio clip/i.test(question.title) &&
!audio.some(row => row.questionIds.includes(index + 1)))
unresolved.push({ questionId: index + 1, reason: 'listening-question-without-mapped-audio' });
});
for (const doc of courseDocuments()) {
for (const element of doc.querySelectorAll('audio,iframe')) {
if (assigned.has(element)) continue;
if (element.tagName === 'AUDIO' || /(?:\/audio(?:[/.?]|$)|type=audio|audio\.html)/i.test(element.getAttribute('src') || ''))
unresolved.push({ reason: 'shared-audio-needs-explicit-question-mapping' });
}
}
return { schemaVersion: 1, purpose: 'listening-practice', questions: questions.map((q, index) => ({
id: index + 1, type: q.kind, question: q.title,
options: q.options.map(option => ({ letter: option.letter, text: option.text })),
...(isTextKind(q.kind) ? { blankCount: q.editors.length } : {}),
})), audio, unresolved: audio.length || unresolved.length ? [...unresolved, ...imageIssues] : [] };
};
app.inspectListening = function () {
const manifest = app.exportListeningPractice();
return { questionCount: manifest.questions.length, audioCount: manifest.audio.length,
mapping: manifest.audio.map(({ id, questionIds }) => ({ id, questionIds })), unresolved: manifest.unresolved };
};

// 只读诊断：识别不到题目时用它定位问题，不猜选择器、不发请求、不改页面
app.inspectPageDom = function () {
const docs = courseDocuments();
const supported = { 单选题: 0, 多选题: 0, 判断题: 0, 填空题: 0, 简答题: 0, 计算题: 0 };
const unsupported = {};
let candidateCount = 0;
for (const doc of docs) {
const text = clean(doc.body?.innerText);
for (const match of text.matchAll(/[\[【（(]([^\]】）)]{1,8}题)(?:\s*[,，、]?\s*\d+(?:\.\d+)?\s*分)?[\]】）)]/g)) {
const label = match[1];
if (label in supported) supported[label] += 1;
else unsupported[label] = (unsupported[label] || 0) + 1;
}
candidateCount += doc.querySelectorAll('span,div,label,li,p,b,i,strong,a').length;
}
const questions = extractQuestions();
console.table({
文档数含同源iframe: docs.length,
候选元素总数: candidateCount,
识别到的题目数: questions.length,
单选题标记: supported.单选题,
多选题标记: supported.多选题,
判断题标记: supported.判断题,
});
if (Object.keys(unsupported).length) console.warn('页面里还有这些未支持的题型标记：', unsupported);
return {
文档数: docs.length,
识别到的题目数: questions.length,
题型标记: supported,
未支持的题型: unsupported,
题目: questions.map((q, i) => ({
题号: i + 1, 题型: q.kind, 题干: q.title,
选项: q.options.map((o) => `${o.letter}. ${o.text}`),
})),
};
};

app._advanceChapterTest = function () {
if (stopped || quizBusy) return;
if (isPreview()) {
enterPreviewWait();
return;
}
quizBusy = true;
return (async () => {
if (quizCompleted()) {
console.log('检测到当前章节测验已完成，点击“下一节”进入新视频');
await goToNextStep();
return;
}
console.log('已进入章节测验，等待题目和提交按钮加载');
const questions = await waitForQuizQuestions();
if (questions === null) {
console.log('检测到当前章节测验已完成，点击“下一节”进入新视频');
await goToNextStep();
return;
}
if (questions.length > 30) throw new Error('题目数量超过 30，已停止自动提交');
const docs = new Set(questions.map((q) => q.doc));
if (docs.size !== 1) throw new Error('题目跨多个框架，已停止自动提交');
const countText = clean(questions[0].doc.body.innerText).match(/题量\s*[:：]\s*(\d+)/);
if (countText && Number(countText[1]) !== questions.length)
throw new Error(`页面显示 ${countText[1]} 道题，脚本只识别 ${questions.length} 道，已停止提交`);
const unsupported = clean(questions[0].doc.body.innerText).match(/[\[【（(](论述题|阅读题|匹配题|排序题)(?:\s*[,，、]?\s*\d+(?:\.\d+)?\s*分)?[\]】）)]/);
if (unsupported) throw new Error(`存在未支持的${unsupported[1]}，已停止自动提交`);
const signature = questionSignature(questions);
if (attemptedQuizzes.has(signature)) throw new Error('本次测验已尝试过，已停止重复提交');
assertQuestionCoverage(questions);
assertChoiceStateAvailable(questions);
console.log(`识别到 ${questions.length} 道题，正在调用 DeepSeek`);
const answers = await sharedQuizAnswers(questions);
if (stopped || isPreview()) throw new Error('自动作答已停止');
if (questionSignature(extractQuestions()) !== signature) throw new Error('模型返回期间题目或选项发生变化，已停止提交');
console.table(questions.map((q, i) => ({ 题号: i + 1, 题型: q.kind, 答案: isTextKind(q.kind) ? answers.get(i + 1).texts.join('\n') : answers.get(i + 1).join('') })));
await selectAnswers(questions, answers);
for (let i = 0; i < questions.length; i++) {
const q = questions[i];
if (!isTextKind(q.kind)) continue;
const texts = answers.get(i + 1).texts;
if (q.editors.some((target, n) => String(editorText(target)).replace(/\s+/g, '') !== texts[n].replace(/\s+/g, '')))
throw new Error(`第 ${i + 1} 题文字在填写后发生变化，已停止提交`);
}
reportManaged('running', `填写后校验通过：${questions.length} 题`);
attemptedQuizzes.add(signature);
await submitQuiz(questions[0].doc, questions, answers);
if (pageKind === 'work') {
reportManaged('submitted', '已观察到当前作业提交完成，等待作业列表复核');
console.log('独立作业提交已确认，自动任务结束。');
return true;
}
reportManaged('running', '章节测验提交已确认');
console.log('章节测验提交已确认，点击“下一节”进入新视频');
quizBusy = false;
await goToNextStep();
})().catch((error) => {
app._nextUnitPending = false;
if (stopped || PAGE[INSTANCE_KEY] !== instance) return false;
reportManaged('blocked', error.message);
console.error('章节测验自动作答停止:', error);
return false;
})
.finally(() => { quizBusy = false; });
};

}
// 独立作业页：默认预览；startAuto 作答并提交当前作业，不做章节导航。
function startWorkPreview() {
const workApp = {
configs: {
mode: 'preview',
// 预览阶段允许没有提交按钮；自动提交阶段仍须找到提交按钮并确认完成。
requireSubmitButton: false,
detectQuizCompleted: false,
},
_videoEl: null,
_isPlaying: false,
_nextUnitPending: false,
_clearCheckInterval() {},
_isChapterTest() {
// 作业页本身就是题目页，预览入口恒为可用
return true;
},
destroy() {},
};
attachQuizAutomation(workApp);
workApp.nextUnit = function () {
console.warn('%c独立作业页不提供章节跳转（预览模式）', 'color:#FF9800');
};
PAGE.app = workApp;
PAGE[APP_KEY] = workApp;
reportManaged('ready', '作业执行器已就绪');
console.log('%c=== 独立作业页预览模式已启动 ===', 'color:#4CAF50;font-size:16px;font-weight:bold');
console.log('%c只做题目识别和答案预览：不勾选、不保存、不提交、不确认、不跳转。', 'color:#607D8B');
console.log('%c1) app.inspectQuiz()     先看识别到的题目，不调用模型', 'color:#2196F3');
console.log('%c2) app.previewQuiz()     获取建议答案，调用一次模型、消耗一次额度', 'color:#2196F3');
console.log('%c   同一组题只分析一次；要重算用 app.previewQuiz({ force: true })', 'color:#607D8B');
console.log('%c3) app.inspectPageDom()  识别为 0 道时用它看页面统计，把输出发给开发者', 'color:#FF9800');
console.log('%c4) app.startAuto()       自动作答并直接提交本份作业；app.stopAuto() 停止后续动作', 'color:#F44336');
}

function initializePlayer() {
const app = {
configs: {
autoplay: true,
// preview（默认）：只分析并打印建议答案，不勾选、不提交、不跳转
// auto：原有全自动行为，需显式执行 app.setMode('auto')
mode: initialMode,
retryInterval: 2000,
maxRetries: 10,
videoCheckInterval: 1000,
guardNoProgressMs: 7000,
guardResumeCooldownMs: 1500,
autoAdvanceNoVideo: false,
},
_videoEl: null,
_treeContainerEl: null,
_isPlaying: false,
_currentRetryCount: 0,
_checkInterval: null,
_eventVideoEl: null,
_boundVideoHandlers: null,
_completedMedia: new WeakMap(),
_nextUnitPending: false,
_chapterAdvanceTimes: 0,
_cellData: {
cells: 0,
nCells: 0,
currentCellIndex: 0,
currentNCellIndex: 0,
currentVideoTitle: "",
},
get cellData() {
return this._cellData;
},
run() {
console.log("%c=== 学习通视频与章节测验助手 V4 启动 ===", "color:#4CAF50;font-size:16px;font-weight:bold");
console.log(`%c当前模式：${this.configs.mode === 'auto' ? 'auto（自动勾选并提交）' : 'preview（只看答案，不改页面）'}`, this.configs.mode === 'auto' ? 'color:#F44336;font-weight:bold' : 'color:#2196F3;font-weight:bold');
if (this.configs.mode !== 'auto') {
console.log('%c识别到章节测验后会停下来等你手动执行 app.previewQuiz()，不会自动调用模型。', 'color:#607D8B');
}
this._nextUnitPending = false;
this._chapterAdvanceTimes = 0;
this._getTreeContainer();
this._initCellData();
console.log(`当前学习步骤：${this._currentStepTitle() || '等待页面加载'}`);
this._videoEl = null;
this._getVideoEl();
this._clearCheckInterval();
this._bindStepNavigation();
this.play();
},
nextUnit() {
if (this._nextUnitPending) {
console.warn('%c已有小节切换正在进行，忽略重复请求', 'color:#FF9800');
return;
}
this._nextUnitPending = true;
this._clearCheckInterval();
console.log("%c=== 准备切换到下一小节 ===", "color:#2196F3;font-size:14px");
try {
const el = this._getTreeContainer();
const cells = el.children("ul").children("li");
const nCells = $(cells.get(this._cellData.currentCellIndex)).find('.posCatalog_select:not(.firstLayer)');
if (nCells.length > this._cellData.currentNCellIndex + 1) {
const nextNIndex = this._cellData.currentNCellIndex + 1;
console.log(`%c切换到同章节下一个视频: ${nextNIndex + 1}/${nCells.length}`, "color:#FF9800");
this.playCurrentIndex(nCells.get(nextNIndex));
} else {
const nextIndex = this._cellData.currentCellIndex + 1;
if (nextIndex >= cells.length) {
console.log("%c=====================================", "color:#4CAF50;font-size:16px");
console.log("%c==============本课程学习完成了==============", "color:#4CAF50;font-size:16px;font-weight:bold");
console.log("%c=====================================", "color:#4CAF50;font-size:16px");
return;
}
console.log(`%c切换到下一个章节: ${nextIndex + 1}/${cells.length}`, "color:#FF9800");
this._cellData.currentCellIndex = nextIndex;
this._cellData.currentNCellIndex = 0;
this.playCurrentIndex();
}
} catch (error) {
this._nextUnitPending = false;
console.error('切换下一小节失败:', error);
}
},
_clearCheckInterval() {
if (this._checkInterval) {
clearInterval(this._checkInterval);
this._checkInterval = null;
}
},
_startVideoMonitoring() {
if (this._automationStopped) return;
this._clearCheckInterval();
this._guardLastTime = 0;
this._guardLastWallTs = 0;
this._guardLastResumeTs = 0;
this._checkInterval = setInterval(() => {
this._checkVideoStatus();
}, this.configs.videoCheckInterval);
},
_tryResumePlayback(reason) {
if (this._blockPolicyVideo?.()) return;
if (this._automationStopped) return;
const now = Date.now();
if (now - this._guardLastResumeTs < this.configs.guardResumeCooldownMs) {
return;
}
this._guardLastResumeTs = now;
const video = this._getVideoEl();
if (!video || !this._isPlaying) return;
video.muted = true;
video.defaultMuted = true;
video.volume = 0;
console.log(`%c触发视频保活恢复(${reason})`, "color:#607D8B");
video.play().then(() => {
if (this._automationStopped) video.pause();
}).catch((e) => {
if (this._automationStopped) return;
console.warn("直接恢复播放失败，尝试静音恢复:", e);
video.muted = true;
video.play().then(() => {
if (this._automationStopped) video.pause();
}).catch((err) => {
console.error("静音恢复播放失败:", err);
});
});
},
_checkVideoStatus() {
if (this._automationStopped) return;
try {
const video = this._getVideoEl();
if (!video) return;
video.muted = true;
video.defaultMuted = true;
video.volume = 0;
if (video.paused && this._isPlaying) {
console.log("%c检测到视频暂停，尝试恢复播放...", "color:#FF5722");
this._tryResumePlayback("paused");
} else if (this._isPlaying && !video.ended) {
const now = Date.now();
const current = Number(video.currentTime || 0);
if (this._guardLastWallTs === 0) {
this._guardLastWallTs = now;
this._guardLastTime = current;
} else {
const stalled = Math.abs(current - this._guardLastTime) < 0.01;
const stalledMs = now - this._guardLastWallTs;
if (stalled && stalledMs >= this.configs.guardNoProgressMs) {
this._tryResumePlayback("no-progress");
this._guardLastWallTs = now;
this._guardLastTime = Number(video.currentTime || 0);
} else if (!stalled) {
this._guardLastWallTs = now;
this._guardLastTime = current;
}
}
}
if (video.ended && this._isPlaying) {
console.log("%c检测到视频结束，准备切换下一个...", "color:#9C27B0");
this._isPlaying = false;
setTimeout(() => { if (!this._automationStopped && this._videoEl === video) this.nextUnit(); }, 1000);
}
} catch (e) {
console.error("视频状态检查失败:", e);
}
},
_tryTimes: 0,
_stepAdvanceTimes: 0,
_stepSwitchAt: 0,
_stepSwitchPending: false,
_delayedNextUnitTimer: null,
_guardLastTime: 0,
_guardLastWallTs: 0,
_guardLastResumeTs: 0,
async play() {
if (this._automationStopped) return;
try {
if (this._isChapterTest()) {
this._videoEl = null;
this._isPlaying = false;
this._clearCheckInterval();
this._advanceChapterTest();
return;
}
const el = this._getVideoEl();
if (el == null) {
if (this._currentStepTitle() === '视频') {
throw new Error('视频组件尚未加载完成');
}
if (this._advanceLearningStep()) {
console.log("%c当前不在视频页，已尝试切到下一学习步骤，2秒后重试", "color:#607D8B");
setTimeout(() => {
this.play();
}, 2000);
return;
}
if (this._isChapterTest()) {
this._advanceChapterTest();
return;
}
this._isPlaying = false;
this._clearCheckInterval();
if (this.configs.autoAdvanceNoVideo) {
console.warn('%c当前小节未发现视频，按配置切换到下一小节', 'color:#FF9800');
this.nextUnit();
} else {
console.warn('%c当前小节未发现视频或可识别的学习步骤，已安全停止。确认无需完成课件后，可执行 app.nextUnit()。', 'color:#FF9800');
reportManaged('blocked', '当前步骤不是已支持的视频或测验；需核实该任务点类型');
}
return;
}
this._isPlaying = true;
this._videoEventHandle();
try {
el.muted = true;
el.defaultMuted = true;
el.volume = 0;
await el.play();
if (this._automationStopped) { el.pause(); return; }
this._tryTimes = 0;
console.log('%c视频开始播放，保持页面默认播放速度', 'color:#4CAF50');
this._startVideoMonitoring();
} catch (playError) {
if (this._automationStopped) return;
console.error("视频播放失败:", playError);
this._handlePlayError(playError);
}
} catch (e) {
if (this._tryTimes >= this.configs.maxRetries) {
console.error("%c视频播放失败，已达到最大重试次数", "color:#F44336;font-weight:bold", e);
reportManaged('blocked', '视频播放失败，已达到最大重试次数');
this._clearCheckInterval();
return;
}
this._tryTimes++;
console.log(`%c播放失败，${this.configs.retryInterval/1000}秒后重试 (${this._tryTimes}/${this.configs.maxRetries})`, "color:#FF9800");
setTimeout(() => {
this.play();
}, this.configs.retryInterval);
}
},
_advanceLearningStep() {
if (this._stepSwitchPending && Date.now() - this._stepSwitchAt < 4000) {
return true;
}
const currentStepTitle = this._currentStepTitle();

if (currentStepTitle === "章节测验" || currentStepTitle === "视频") {
return false;
}
const clickElement = (el, label) => {
if (!el) return false;
this._stepSwitchPending = true;
this._stepSwitchAt = Date.now();
console.log(`%c尝试点击${label}`, "color:#2196F3");
el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
return true;
};
const videoTab = $(".prev_white:visible").filter((_, el) => {
const text = ($(el).text() || "").replace(/\s+/g, "");
return text === "2视频" || text === "视频";
}).get(0);
if (clickElement(videoTab, "“视频”页签")) {
return true;
}
return false;
},
_currentStepTitle() {
return learningStepSnapshot(this).kind;
},
_isChapterTest() {
return this._currentStepTitle() === '章节测验';
},
_advanceChapterTest() {
if (this.configs.mode !== 'auto') {
console.log('%c预览模式：已停在章节测验页，不点击任何跳转按钮', 'color:#607D8B');
return;
}
if (this._chapterAdvanceTimes >= 3) {
console.error('%c章节测验页面连续跳转失败，已停止以避免页面循环。请手动处理后执行 app.run()。', 'color:#F44336;font-weight:bold');
return;
}
const nextButton = $('#prevNextFocusNext:visible, #right1:visible, .nextChapter:visible').first().get(0);
if (!nextButton) {
console.warn('%c未找到章节测验的下一步按钮，已停止。', 'color:#FF9800');
return;
}
this._chapterAdvanceTimes++;
console.log('%c检测到章节测验，尝试进入下一学习步骤', 'color:#607D8B');
nextButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
setTimeout(() => this.play(), 2000);
},
_bindStepNavigation() {
if (this._stepNavigationBound) {
return;
}
this._stepNavigationBound = true;
const reenterVideoMode = () => {
this._videoEl = null;
this._isPlaying = false;
this._stepSwitchPending = true;
this._stepSwitchAt = Date.now();
setTimeout(() => {
try {
this._initCellData();
} catch (e) {}
this.play();
}, 1800);
};
$(document).off('click.xuexitongPlayerV4', '.prev_white').on('click.xuexitongPlayerV4', '.prev_white', (e) => {
const text = ($(e.currentTarget).text() || "").replace(/\s+/g, "");
if (text.includes("视频") || text.includes("章节测验")) {
console.log(`%c检测到步骤切换点击：${text}，准备重新识别页面`, "color:#607D8B");
reenterVideoMode();
}
});
},
_handlePlayError(error) {
if (this._blockPolicyVideo?.()) return;
if (this._automationStopped) return;
console.error("播放错误详情:", error);
const video = this._getVideoEl();
if (video) {
video.muted = true;
video.play().then(() => {
if (this._automationStopped) { video.pause(); return; }
console.log("%c静音播放成功", "color:#4CAF50");
this._tryTimes = 0;
this._startVideoMonitoring();
if (this._delayedNextUnitTimer) {
clearTimeout(this._delayedNextUnitTimer);
this._delayedNextUnitTimer = null;
}
}).catch(e => {
if (this._automationStopped) return;
console.error("静音播放也失败:", e);
if (this._delayedNextUnitTimer) {
clearTimeout(this._delayedNextUnitTimer);
}
this._isPlaying = false;
if (this._tryTimes >= this.configs.maxRetries) {
console.error('%c静音播放失败，已达到最大重试次数', 'color:#F44336;font-weight:bold', e);
return;
}
this._tryTimes++;
this._delayedNextUnitTimer = setTimeout(() => {
this._delayedNextUnitTimer = null;
this.play();
}, this.configs.retryInterval);
});
}
},
playCurrentIndex(nCell) {
this._nextUnitPending = false;
if (!nCell) {
const el = this._getTreeContainer();
const cells = el.children("ul").children("li");
const nCells = $(cells.get(this._cellData.currentCellIndex)).find('.posCatalog_select:not(.firstLayer)');
nCell = nCells.get(this._cellData.currentNCellIndex);
}
const $nCell = $(nCell);
const clickableSpan = $nCell.find(".posCatalog_name")[0];
if (!clickableSpan) {
console.error("%c===========找不到可点击的课程节点，播放下一个视频失败==============", "color:#F44336");
return;
}
console.log(`%c点击切换到: ${$(clickableSpan).attr('title') || '未知标题'}`, "color:#2196F3");
$(clickableSpan).click();
this._videoEl = null;
this._isPlaying = false;
console.log("%c等待视频加载...", "color:#FF9800");
setTimeout(() => {
this._initCellData();
if (this.configs.autoplay) {
this.play();
}
}, 3000);
},
_initCellData() {
const el = this._getTreeContainer();
const cells = el.children("ul").children("li");
this._cellData.cells = cells.length;
let nCellCounts = 0;
let foundCurrent = false;
cells.each((i, v) => {
const nCells = $(v).find('.posCatalog_select:not(.firstLayer)');
nCellCounts += nCells.length;
nCells.each((j, e) => {
const _el = $(e);
if (_el.hasClass("posCatalog_active")) {
this._cellData.currentCellIndex = i;
this._cellData.currentNCellIndex = j;
foundCurrent = true;
const titleSpan = _el.find('.posCatalog_name')[0];
if (titleSpan) {
this._cellData.currentVideoTitle = $(titleSpan).attr('title');
}
}
});
});
this._cellData.nCells = nCellCounts;

if (!foundCurrent && nCellCounts > 0) {
console.warn("%c未找到当前激活的视频节点，可能需要手动选择", "color:#FF9800");
}
console.log(`%c课程信息: ${this._cellData.cells}章, ${this._cellData.nCells}节, 当前: 第${this._cellData.currentCellIndex + 1}章第${this._cellData.currentNCellIndex + 1}节`, "color:#607D8B");
},
_getTreeContainer() {
if (!this._treeContainerEl) {
const el = $('#coursetree');
if (el.length <= 0) {
throw new Error("找不到视频列表");
}
this._treeContainerEl = el;
}
return this._treeContainerEl;
},
_getVideoEl() {
try {
const videos = [], visited = new Set();
const shown = (el) => el.isConnected && el.getClientRects().length &&
el.ownerDocument.defaultView.getComputedStyle(el).visibility !== 'hidden';
const collect = (doc, depth) => {
if (!doc || depth > 3 || visited.has(doc)) return;
visited.add(doc);
videos.push(...Array.from(doc.querySelectorAll('video')).filter(shown));
for (const frame of doc.querySelectorAll('iframe')) {
if (!shown(frame)) continue;
try { collect(frame.contentDocument, depth + 1); } catch (_) {}
}
};
const cards = Array.from(document.querySelectorAll('iframe[src*="/knowledge/cards"]')).filter(shown);
if (cards.length > 1) return null;
if (cards.length) {
try { collect(cards[0].contentDocument, 0); } catch (_) {}
} else collect(document, 0);
const available = (video) => this._completedMedia.get(video) !== mediaSource(video);
if (!videos.includes(this._videoEl) || !available(this._videoEl)) this._videoEl = videos.find(available) || null;
if (this._videoEl) {
this._videoEl.muted = true;
this._videoEl.defaultMuted = true;
this._videoEl.volume = 0;
}
} catch (e) {
console.error("获取视频元素失败:", e);
return null;
}
if (!this._videoEl) return null;
return this._videoEl;
},
_videoEventHandle() {
const el = this._videoEl;
if (!el) {
console.log("videoEl未加载");
return;
}
if (this._eventVideoEl === el) return;
this._detachVideoEvents();
this._eventVideoEl = el;
this._boundVideoHandlers = {
ended: this._handleVideoEnded.bind(this),
loadedmetadata: this._handleVideoLoaded.bind(this),
play: this._handleVideoPlay.bind(this),
pause: this._handleVideoPause.bind(this),
};
el.addEventListener('ended', this._boundVideoHandlers.ended);
el.addEventListener('loadedmetadata', this._boundVideoHandlers.loadedmetadata);
el.addEventListener('play', this._boundVideoHandlers.play);
el.addEventListener('pause', this._boundVideoHandlers.pause);
},
_detachVideoEvents() {
if (!this._eventVideoEl || !this._boundVideoHandlers) return;
this._eventVideoEl.removeEventListener('ended', this._boundVideoHandlers.ended);
this._eventVideoEl.removeEventListener('loadedmetadata', this._boundVideoHandlers.loadedmetadata);
this._eventVideoEl.removeEventListener('play', this._boundVideoHandlers.play);
this._eventVideoEl.removeEventListener('pause', this._boundVideoHandlers.pause);
this._eventVideoEl = null;
this._boundVideoHandlers = null;
},
_handleVideoEnded(e) {
if (this._automationStopped || (e?.currentTarget && e.currentTarget !== this._videoEl)) return;
const endedVideo = this._videoEl;
const title = this._cellData.currentVideoTitle;
console.warn(`%c============'${title}' 播放完成=============`, "color:#4CAF50;font-weight:bold");
this._isPlaying = false;
this._clearCheckInterval();
setTimeout(() => { if (!this._automationStopped && this._videoEl === endedVideo) this.nextUnit(); }, 1000);
},
_handleVideoLoaded(e) {
console.log(`%c============视频加载完成=============`, "color:#2196F3");
if (this.configs.autoplay && !this._isPlaying) {
this.play();
}
},
_handleVideoPlay(e) {
if (this._automationStopped) {
try { this._videoEl?.pause(); } catch (_) {}
return;
}
const title = this._cellData.currentVideoTitle;
console.info(`%c============'${title}' 开始播放=============`, "color:#4CAF50");
this._isPlaying = true;
this._stepSwitchPending = false;
const video = this._getVideoEl();
this._guardLastTime = Number(video?.currentTime || 0);
this._guardLastWallTs = Date.now();
if (this._delayedNextUnitTimer) {
clearTimeout(this._delayedNextUnitTimer);
this._delayedNextUnitTimer = null;
}
},
_handleVideoPause(e) {
console.log(`%c============视频暂停=============`, "color:#FF9800");
},
_bindPageGuards() {
const preventPause = (e) => {
e.stopPropagation();
e.preventDefault();
};
const resumePlaybackNow = () => this._tryResumePlayback('page-event');
this._pageGuards = { preventPause, resumePlaybackNow };
document.addEventListener('mouseleave', preventPause);
window.addEventListener('mouseleave', preventPause);
document.addEventListener('mouseout', preventPause);
window.addEventListener('mouseout', preventPause);
window.addEventListener('blur', resumePlaybackNow);
document.addEventListener('visibilitychange', resumePlaybackNow);
},
destroy() {
this._isPlaying = false;
this._clearCheckInterval();
this._detachVideoEvents();
if (this._delayedNextUnitTimer) clearTimeout(this._delayedNextUnitTimer);
$(document).off('.xuexitongPlayerV4');
if (this._pageGuards) {
const { preventPause, resumePlaybackNow } = this._pageGuards;
document.removeEventListener('mouseleave', preventPause);
window.removeEventListener('mouseleave', preventPause);
document.removeEventListener('mouseout', preventPause);
window.removeEventListener('mouseout', preventPause);
window.removeEventListener('blur', resumePlaybackNow);
document.removeEventListener('visibilitychange', resumePlaybackNow);
this._pageGuards = null;
}
},
};
attachQuizAutomation(app);
PAGE.app = app;
PAGE[APP_KEY] = app;
reportManaged('ready', '课程执行器已就绪');

try {
app.run();
app._bindPageGuards();
} catch (error) {
console.error("%c脚本运行失败: ", "color:#F44336;font-weight:bold", error.message);
reportManaged('blocked', error.message);
console.log("请检查是否在正确的课程播放页面，或者页面结构是否再次发生改变。");
}
}
})();
