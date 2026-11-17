// Runs in a page/frame. Keep this function self-contained for browser evaluation and DOM tests.
export function pageSnapshot() {
    const text = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim();
    const url = new URL(location.href);
    const allowed = (value) => {
        try { const u = new URL(value, location.href); return u.protocol === 'https:' && /(^|\.)chaoxing\.com$/i.test(u.hostname) ? u.href : null; }
        catch { return null; }
    };
    const result = { kind: 'unknown', path: url.pathname, title: document.title, items: [], menus: [], next: null, empty: false };
    if (!/(^|\.)chaoxing\.com$/i.test(url.hostname)) return result;
    const bodyText = text(document.body);
    result.empty = /暂无课程|暂无作业|暂无章节|暂无数据|还没有课程|暂无相关/.test(bodyText);
    if (/passport|sso/i.test(url.hostname) || document.querySelector('input[type="password"]') ||
        (/扫码登录|手机验证码登录/.test(bodyText) && !document.querySelector('#courseList,[name="课程"]'))) {
        result.kind = 'login'; return result;
    }
    // This endpoint displays questions without a supported answer/submit entry.
    // Text such as “已完成” inside a question is never completion evidence here.
    if (url.pathname === '/mooc-ans/mooc2/work/preview') {
        result.kind = 'work-preview'; result.readOnly = true; result.confirmed = false;
        return result;
    }
    if (/\/work\/prompt/.test(url.pathname)) {
        result.kind = 'work-result';
        result.confirmed = /提交成功|已提交|提交时间|待批阅|待批改|已完成/.test(bodyText);
        return result;
    }
    if (url.pathname.includes('/mycourse/studentstudy')) { result.kind = 'player'; return result; }
    if (/\/work\/dowork/.test(url.pathname)) { result.kind = 'work'; return result; }
    if (/\/work\/task/.test(url.pathname)) {
        result.kind = 'work-entry';
        result.unavailable = /已截止|作业已结束|未到开始时间|尚未开始|已过截止时间/.test(bodyText);
        result.confirmed = /已提交|待批阅|已完成|提交时间/.test(bodyText);
        result.entry = [...document.querySelectorAll('a,button,input[type="button"]')].map((el) =>
            ({ label: text(el) || el.value || '', disabled: el.disabled || el.getAttribute('aria-disabled') === 'true' }))
            .find((el) => /^(开始作答|继续作答|进入作业|开始做题|去完成)$/.test(el.label) && !el.disabled)?.label || null;
        return result;
    }
    const emptyChapterDirectory = url.pathname === '/mooc2-ans/mycourse/studentcourse' &&
        !document.querySelector('.chapter_item[id^="cur"]') &&
        [...document.querySelectorAll('.chapter_body.xs_table .nodata')].some((el) =>
            text(el) === '暂无章节内容' && !el.closest('[hidden]') &&
            getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden');
    if (document.querySelector('#courseList,.learnCourse')) {
        result.kind = 'courses';
        const cards = [...document.querySelectorAll('.learnCourse,[id^="c_"],#courseList > li.course[id^="course_"]')];
        result.diagnostics = { candidates: cards.length, invalidId: 0, noAnchor: 0, rejectedUrl: 0, missingIds: 0 };
        if (!cards.length) {
            // Read-only diagnostics for a changed/empty platform layout. Never include URLs or input values.
            result.diagnostics.cards = [...document.querySelectorAll('#courseList > *')].slice(0,2).map(el => ({
                tag: el.tagName, id: el.id, className: el.className,
                links: [...el.querySelectorAll('a[href]')].slice(0,3).map(anchor => {
                    const href = allowed(anchor.getAttribute('href'));
                    if (!href) return { text: text(anchor).slice(0,30), attributes: anchor.getAttributeNames() };
                    const address = new URL(href);
                    return { text: text(anchor).slice(0,30), path: address.pathname, parameters: [...address.searchParams.keys()],
                        ids: [...address.searchParams].filter(([key]) => /^(courseid|clazzid|classid)$/i.test(key)) };
                }),
            }));
            result.diagnostics.visibleText = text(document.querySelector('#courseList')).slice(0,100);
        }
        for (const card of cards) {
            const cardIds = card.id.match(/^course_(\d+)_(\d+)$/);
            if (!/^c_\d+$/.test(card.id) && !cardIds) { result.diagnostics.invalidId++; continue; }
            const anchors = [...card.querySelectorAll('h3 a[href],a[href*="stucoursemiddle"]')];
            const anchor = anchors.find(el => text(el)) || anchors[0];
            if (!anchor) { result.diagnostics.noAnchor++; continue; }
            const href = allowed(anchor?.getAttribute('href'));
            if (!href) { result.diagnostics.rejectedUrl++; continue; }
            const u = new URL(href), id = u.searchParams.get('courseid'), classId = u.searchParams.get('clazzid');
            if (!id || !classId || (cardIds && (cardIds[1] !== id || cardIds[2] !== classId))) {
                result.diagnostics.missingIds++; continue;
            }
            const closed = Boolean(card.closest('#isState')) || /课程已结束|已退课/.test(text(card));
            result.items.push({ kind: 'course', key: `course:${id}:${classId}`, id, classId,
                title: text(card.querySelector('h3')) || text(anchor), href, status: closed ? 'closed' : 'available' });
        }
    } else if (document.querySelector('li[data][onclick*="goTask"],#workFocus')) {
        result.kind = 'work-list';
        for (const el of document.querySelectorAll('li[data][onclick*="goTask"]')) {
            const href = allowed(el.getAttribute('data'));
            if (!href) continue;
            const u = new URL(href);
            if (!/\/work\/(task|dowork)$/.test(u.pathname)) continue; // Peer review is a different task.
            const id = u.searchParams.get('workId');
            if (!id) continue;
            const status = text(el.querySelector('.status'));
            const pending = /^(未交|未完成|待做|待完成|进行中)$/.test(status);
            const closed = /已截止|已结束|未开始/.test(text(el.querySelector('.time')));
            result.items.push({ kind: 'work', id, key: `work:${id}`, href,
                title: text(el.querySelector('.workName,.work-name,h3,.name')) ||
                    (el.getAttribute('aria-label') || '').split(';')[0].trim() || text(el).slice(0,120),
                status: pending && !closed ? 'pending' : /待批阅|待批改|已完成|已提交/.test(status) ? 'complete' : 'unavailable',
                reason: closed ? '作业已截止或未开始' : status || '状态不明' });
        }
    } else if (document.querySelector('.chapter_item[id^="cur"]') || emptyChapterDirectory) {
        result.kind = 'chapters';
        result.empty = emptyChapterDirectory;
        for (const el of document.querySelectorAll('.chapter_item[id^="cur"]')) {
            const match = el.id.match(/^cur(\d+)$/);
            if (!match) continue;
            const count = el.querySelector('.catalog_points_yi');
            const countedRemaining = count && /^\d+$/.test(text(count)) ? Number(text(count)) : null;
            const completedMarker = [...el.querySelectorAll('.catalog_task > .catalog_state.icon_yiwanc > span.bntHoverTips')]
                .some((hint) => hint.closest('.chapter_item') === el && text(hint) === '已完成');
            const conflictingState = completedMarker && (countedRemaining > 0 || (count && countedRemaining === null));
            const remaining = completedMarker && !conflictingState ? 0 : countedRemaining;
            result.items.push({ kind: 'chapter', id: match[1], key: `chapter:${match[1]}`,
                title: el.getAttribute('title') || text(el.querySelector('.catalog_name')),
                selector: `#cur${match[1]}`, remaining,
                status: conflictingState ? 'unavailable' : remaining === 0 ? 'complete' : remaining > 0 ? 'pending' : 'unavailable',
                reason: conflictingState ? '完成标记与剩余任务点计数冲突，未认定已完成' :
                    completedMarker ? '平台明确显示已完成' : remaining === null ? '没有明确的任务点计数' : '' });
        }
    } else if (url.pathname.includes('/mycourse/stu')) result.kind = 'course-home';
    else if (url.hostname === 'i.chaoxing.com') result.kind = 'portal';
    for (const label of ['课程','章节','作业']) {
        const candidates = [...document.querySelectorAll('a[title],[role="menuitem"],[name="课程"]')];
        if (candidates.some((el) => el.getAttribute('title') === label || el.getAttribute('name') === label || text(el) === label))
            result.menus.push(label);
    }
    const next = [...document.querySelectorAll('.pagination a,.pagination button,.page a,.page button,[aria-label="下一页"]')]
        .find((el) => /^(下一页|下页|›|>)$/.test(text(el)) && !el.disabled &&
            el.getAttribute('aria-disabled') !== 'true' && !/(^|\s)disabled(\s|$)/.test(el.className));
    if (next) result.next = { label: text(next) };
    return result;
}
