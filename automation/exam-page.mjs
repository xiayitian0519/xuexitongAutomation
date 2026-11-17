import { isPlatformUrl } from './browser-driver.mjs';
import { delay } from './workflow-state.mjs';

// Known page family, not a fuzzy "click the next matching label" fallback.
export class ExamPage {
    constructor(page, identity, options = {}) {
        if (!identity?.examId || !identity?.title || !identity?.courseKey) throw new Error('EXAM_IDENTITY_REQUIRED');
        this.page = page; this.identity = identity; this.signal = options.signal;
        this.identityEstablished = options.verifiedResultRecovery === true;
    }
    checkStop() { if (this.signal?.aborted) throw new Error('ABORTED'); }
    async observe() {
        const deadline = Date.now() + 5000;
        for (;;) {
            try {
                const view = await this.read();
                if (view.readyState !== 'loading') return view;
            } catch (error) {
                if (!/Execution context was destroyed|Cannot find context|navigation/i.test(error.message)) throw error;
            }
            if (Date.now() >= deadline) throw new Error('EXAM_NAVIGATION_NOT_SETTLED');
            await delay(50, this.signal);
        }
    }
    async read() {
        this.checkStop();
        if (!isPlatformUrl(this.page.url())) throw new Error('EXAM_PAGE_ORIGIN_REJECTED');
        const view = await this.page.evaluate(expected => {
            const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
            const visible = element => !!element && !!element.getClientRects().length &&
                getComputedStyle(element).visibility !== 'hidden' && getComputedStyle(element).display !== 'none';
            const text = element => clean(element?.innerText || element?.value || '');
            const selector = element => {
                const path = [];
                while (element && element !== document.documentElement) {
                    if (element.id && document.querySelectorAll('#' + CSS.escape(element.id)).length === 1) {
                        path.unshift('#' + CSS.escape(element.id)); break;
                    }
                    const siblings = element.parentElement ? [...element.parentElement.children].filter(e => e.tagName === element.tagName) : [];
                    path.unshift(element.tagName.toLowerCase() + ':nth-of-type(' + (siblings.indexOf(element) + 1) + ')');
                    element = element.parentElement;
                }
                return path.join(' > ');
            };
            const controls = [...document.querySelectorAll('a,button,input[type=button],input[type=submit],[role=button]')].filter(visible);
            const candidate = element => ({ selector: selector(element), text: text(element), disabled: !!element.disabled || element.getAttribute('aria-disabled') === 'true' });
            const urls = new URL(location.href).searchParams;
            const idNode = document.querySelector('[data-exam-id],input[name=examId],input#examId,input[name=testPaperId]');
            const observedId = idNode?.getAttribute('data-exam-id') || idNode?.value ||
                urls.get('examId') || urls.get('examid') || urls.get('testPaperId');
            const titles = [...document.querySelectorAll('[data-exam-title],.examName,.exam_name,.paper_title,.paperTitle,h1,h2,h3,table td,table th')]
                .filter(visible).map(e => clean(e.getAttribute('data-exam-title') || text(e)));
            titles.push(clean(document.title));
            const titledIdentityMatches = String(observedId || '') === String(expected.examId) &&
                titles.some(title => title === expected.title || title.includes(expected.title));
            const outsideQuestions = [...document.querySelectorAll('p,h1,h2,h3,span,div')].filter(e =>
                visible(e) && !e.closest('.singleQuesId') && text(e).length < 250);
            const success = outsideQuestions.some(e => /^(?:.*[：:\s])?(?:交卷成功|提交成功|考试已完成|已交卷)(?:[！!。\s].*)?$/.test(text(e)));
            const resultPath = /\/exam\/test\/look(?:\/|$)|\/exam\/result(?:\/|$)/.test(location.pathname);
            const identityMatches = titledIdentityMatches || expected.establishedResult === true && resultPath && success && String(observedId || '') === String(expected.examId);
            const scoreText = outsideQuestions.map(text).find(value => /最终成绩\s*[:：]?\s*\d+(?:\.\d+)?/.test(value));
            const score = scoreText?.match(/最终成绩\s*[:：]?\s*(\d+(?:\.\d+)?)/)?.[1];
            const consent = [...document.querySelectorAll('.agree_check,input[type=checkbox][name=agree],[role=checkbox][aria-label*="同意"]')]
                .filter(visible).map(e => ({ ...candidate(e),
                    checked: e.checked === true || e.classList.contains('agree_checked') || e.getAttribute('aria-checked') === 'true' }));
            const entry = controls.filter(e => (e.id === 'startBtn' || text(e) === '进入考试') && e.id !== 'tabIntoexam2');
            const entryConfirm = controls.filter(e => e.id === 'tabIntoexam2');
            const submit = controls.filter(e => text(e) === '交卷' && (e.matches('.completeBtn') || e.tagName === 'BUTTON' || e.getAttribute('role') === 'button'));
            const submitConfirm = controls.filter(e => {
                if (!/^(?:确定|确认|确认交卷)$/.test(text(e))) return false;
                let parent = e.parentElement;
                while (parent && parent !== document.body) {
                    const value = text(parent);
                    if (value.length > 1200) break;
                    if (/确认交卷[？?]?|确定要交卷[？?]?/.test(value) && !parent.closest('.singleQuesId')) return true;
                    parent = parent.parentElement;
                }
                return false;
            });
            const submitMessage = outsideQuestions.some(e => /确认交卷[？?]?|确定要交卷[？?]?/.test(text(e)));
            const minimumText = outsideQuestions.map(text).find(value => /\d+\s*分钟内(?:不(?:可|能)|禁止)交卷/.test(value));
            const fieldMinimum = Number(document.querySelector('input#submitLimitTime')?.value);
            const minimumMinutes = Math.max(Number(minimumText?.match(/(\d+)\s*分钟内/)?.[1]) || 0, Number.isFinite(fieldMinimum) && fieldMinimum >= 0 && fieldMinimum <= 1440 ? fieldMinimum : 0) || null;
            const securityVerification = outsideQuestions.some(e => /请完成安全验证|向右拖动滑块填充拼图/.test(text(e)));
            const kind = resultPath && success ? 'submitted' : securityVerification ? 'human-verification' : submitMessage ? 'submit-confirmation' :
                entryConfirm.length ? 'entry-confirmation' :
                document.querySelector('.singleQuesId[data]') ? 'in-exam' :
                consent.length || entry.length ? 'entry-ready' :
                document.querySelector('input[type=password]') ? 'login-required' : 'unknown';
            return { kind, identityMatches, readyState: document.readyState, path: location.pathname, observedId: observedId || null,
                consent, actions: { entry: entry.map(candidate), 'entry-confirm': entryConfirm.map(candidate),
                    submit: submit.map(candidate), 'submit-confirm': submitConfirm.map(candidate) },
                minimumMinutes, securityVerification, result: kind === 'submitted' ? { confirmed: true, score: score === undefined ? null : Number(score) } : null };
        }, { ...this.identity, establishedResult: this.identityEstablished });
        if (view.identityMatches) this.identityEstablished = true;
        return view;
    }
    async click(action) {
        this.checkStop();
        const state = await this.observe();
        if (!state.identityMatches) throw new Error('EXAM_IDENTITY_MISMATCH');
        if (state.kind === 'human-verification') throw new Error('HUMAN_VERIFICATION_REQUIRED');
        const kinds = { consent: 'entry-ready', entry: 'entry-ready', 'entry-confirm': 'entry-confirmation',
            submit: 'in-exam', 'submit-confirm': 'submit-confirmation' };
        if (state.kind !== kinds[action]) return { performed: false, state, reason: 'state-already-changed' };
        const candidates = action === 'consent' ? state.consent : state.actions[action];
        if (candidates?.length !== 1) throw new Error('EXAM_CONTROL_AMBIGUOUS_' + action);
        const target = candidates[0];
        if (action === 'consent' && target.checked) return { performed: false, state, reason: 'already-checked' };
        if (target.disabled) throw new Error('EXAM_CONTROL_DISABLED_' + action);
        this.checkStop();
        let error = null;
        try { await this.page.locator(target.selector).click({ timeout: 5000, noWaitAfter: true }); }
        catch (caught) { error = caught.name; }
        // Always re-observe, including after a timeout. Never re-click here.
        const after = await this.observe();
        return { performed: error === null, state: after, error };
    }
}
