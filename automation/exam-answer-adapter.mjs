import { digest } from '../listening/transcript-store.mjs';
import { checkAbort, until } from './workflow-state.mjs';

import { readExamCardImages } from './exam-image-materials.mjs';
import { assignExamAudio } from './exam-audio-map.mjs';
import { extractExamDom } from './exam-paper-snapshot.mjs';
export { readExamCardImages, assignExamAudio };

const byId = id => '[id=' + JSON.stringify(id) + ']';
export class ExamAnswerAdapter {
    constructor(page, options = {}) { this.page = page; this.signal = options.signal; this.requireReceipt = options.requireReceipt !== false; this.imageOptions = options.imageOptions || {}; }
    async openWholePaper() {
        checkAbort(this.signal);
        const isOverview = page => {
            try { return new URL(page.url()).pathname === '/exam-ans/mooc2/exam/preview'; } catch { return false; }
        };
        if (isOverview(this.page)) return { wholePaper: true, source: 'platform-overview', page: this.page };
        const original = this.page, candidates = original.getByText('整卷预览', { exact: true });
        const visible = [];
        for (let i = 0; i < await candidates.count(); i++) if (await candidates.nth(i).isVisible()) visible.push(candidates.nth(i));
        if (visible.length !== 1) throw new Error('EXAM_WHOLE_PAPER_UNCONFIRMED');
        let popup = null;
        const listener = child => { popup = child; };
        original.on('popup', listener);
        try {
            try { await visible[0].click({ timeout: 5000, noWaitAfter: true }); }
            catch (error) { if (error.name !== 'TimeoutError') throw error; }
            const current = await until(async () => {
                const candidate = popup || original;
                return isOverview(candidate) && await candidate.locator('.singleQuesId[data]').count() > 0 ? candidate : null;
            }, Boolean, { signal: this.signal });
            await current.waitForLoadState('domcontentloaded', { timeout: 5000 });
            this.page = current;
            return { wholePaper: true, source: 'platform-overview', page: current };
        } finally { original.off('popup', listener); }
    }
    async extract() {
        checkAbort(this.signal);
        if (new URL(this.page.url()).pathname !== '/exam-ans/mooc2/exam/preview') throw new Error('EXAM_WHOLE_PAPER_UNCONFIRMED');
        const snapshot = await this.page.evaluate(extractExamDom).catch(() => { throw new Error('EXAM_DOM_UNREADABLE'); });
        if (!snapshot.questions.length || snapshot.unsupported.length) throw new Error('EXAM_STRUCTURE_UNSUPPORTED: ' + snapshot.unsupported.join(','));
        for (const qid of new Set(snapshot.map.map(row => row.qid))) {
            const images = await readExamCardImages(this.page, qid, this.signal, this.imageOptions);
            if (images.length !== snapshot.imageCounts[qid]) throw new Error('EXAM_IMAGE_MATERIAL_CHANGED');
            if (!images.length) continue;
            for (const row of snapshot.map.filter(row => row.qid === qid)) {
                const question = snapshot.questions[row.id - 1];
                const selected = row.imageIndexes;
                question.images = selected.map(index => images[index]);
                question.question += '\n题目原图（按本题页面顺序）：' + selected.map((_,i) => '[图' + (i+1) + ']').join(' ');
                const references = indexes => indexes.map(index => '[图' + (selected.indexOf(index)+1) + ']').join(' ');
                if (row.stemImageIndexes?.length) question.question += '\n共享题干图片：' + references(row.stemImageIndexes);
                if (row.promptImageIndexes?.length) question.question += '\n本题问句图片：' + references(row.promptImageIndexes);
                for (const option of question.options || []) {
                    const indexes = row.optionImageIndexes?.[option.letter] || [];
                    if (indexes.length) option.text += ' ' + indexes.map(index => '[图' + (selected.indexOf(index)+1) + ']').join(' ');
                }
            }
        }
        const choiceIds = snapshot.map.filter(row => row.subId).map(row => row.subId);
        const editorIds = snapshot.map.flatMap(row => row.blanks?.map(blank => blank.frameId) || []);
        if (new Set(choiceIds).size !== choiceIds.length || new Set(editorIds).size !== editorIds.length) throw new Error('EXAM_FIELD_MAPPING_NOT_UNIQUE');
        const sources = [];
        for (const frame of this.page.frames()) {
            const audio = await frame.locator('audio').evaluateAll(elements => elements.map((e,index) => ({
                sourceUrl: e.currentSrc || e.src || (e.querySelectorAll('source[src]').length === 1 ? e.querySelector('source[src]').src : ''),
                qid: e.closest('.singleQuesId')?.getAttribute('data') || null, innerOrder:index,
                domOrder: [...(e.closest('.singleQuesId')?.querySelectorAll('audio,iframe:not([id^=ueditor_])') || [])].indexOf(e),
            }))).catch(() => { throw new Error('EXAM_AUDIO_FRAME_UNREADABLE'); });
            if (!audio.length) continue;
            if (frame !== this.page.mainFrame()) {
                const element = await frame.frameElement().catch(() => { throw new Error('EXAM_AUDIO_FRAME_UNREADABLE'); });
                const owner = await element.evaluate(e => ({ qid:e.closest('.singleQuesId')?.getAttribute('data') || null,
                    domOrder:[...(e.closest('.singleQuesId')?.querySelectorAll('audio,iframe:not([id^=ueditor_])') || [])].indexOf(e) })).catch(() => { throw new Error('EXAM_AUDIO_FRAME_UNREADABLE'); });
                audio.forEach(row => { if (!row.qid) { row.qid = owner.qid; row.domOrder = owner.domOrder; } });
            }
            sources.push(...audio);
        }
        if (snapshot.audioExpectedCardIds.some(qid => !sources.some(row => row.qid === qid))) throw new Error('EXAM_AUDIO_MATERIAL_MISSING');
        if (sources.some(row => row.domOrder < 0)) throw new Error('EXAM_AUDIO_MAPPING_UNKNOWN');
        const cardOrder = [...new Set(snapshot.map.map(row => row.qid))];
        sources.sort((a,b) => cardOrder.indexOf(a.qid) - cardOrder.indexOf(b.qid) || a.domOrder - b.domOrder || a.innerOrder - b.innerOrder);
        snapshot.audio = assignExamAudio(sources, snapshot.map, { requireQuestionNumbers: true });
        for (const map of snapshot.map) map.audioIds = snapshot.audio.filter(audio => audio.questionIds.includes(map.id)).map(audio => audio.id);
        if (snapshot.map.some(map => map.audioIds.length > 1)) throw new Error('EXAM_MULTIPLE_AUDIO_PER_QUESTION_UNRESOLVED');
        snapshot.wholePaper = { confirmed: true, source: 'platform-overview', cardIds: [...new Set(snapshot.map.map(row => row.qid))] };
        snapshot.fingerprint = digest({ questions: snapshot.questions, map: snapshot.map, wholePaper: snapshot.wholePaper,
            audio: snapshot.audio.map(({ id, questionIds }) => ({ id, questionIds })) });
        await until(async () => {
            try { await this.readValues(snapshot); return true; }
            catch (error) { if (error.message.includes('EXAM_EDITOR_NOT_READY')) return false; throw error; }
        }, ready => ready, { signal: this.signal });
        return snapshot;
    }
    async readValues(snapshot) {
        checkAbort(this.signal);
        return this.page.evaluate(map => {
            const values = {};
            for (const item of map) {
                const card = [...document.querySelectorAll('.singleQuesId[data]')].find(e => e.getAttribute('data') === item.qid);
                if (!card) throw new Error('EXAM_CARD_CHANGED');
                if (item.options) {
                    const spans = [...card.querySelectorAll('span[qid][data]')].filter(e => e.getAttribute('qid') === item.subId);
                    const hidden = document.getElementById('answer' + item.subId);
                    if (!hidden || spans.length !== item.options.length) throw new Error('EXAM_CHOICE_STATE_MISSING');
                    const selected = spans.filter(e => e.classList.contains('check_answer') || e.classList.contains('check_answer_dx'));
                    const raw = hidden.value || '';
                    const tokens = raw ? item.options.every(o => o.value.length === 1) && !/[,|]/.test(raw) ? [...raw] : raw.split(/[,|]/).filter(Boolean) : [];
                    const selectedValues = selected.map(e => e.getAttribute('data')).sort();
                    if (tokens.length !== selected.length || [...tokens].sort().some((value, i) => value !== selectedValues[i])) throw new Error('EXAM_CHOICE_STATE_CONFLICT');
                    values[item.id] = { letters: selected.map(e => item.options.find(o => o.value === e.getAttribute('data'))?.letter).sort() };
                } else {
                    values[item.id] = { texts: item.blanks.map(blank => {
                        const iframe = document.getElementById(blank.frameId);
                        if (!iframe || !iframe.contentDocument?.body?.isContentEditable) throw new Error('EXAM_EDITOR_NOT_READY');
                        return iframe.contentDocument.body.innerText.trim();
                    }) };
                }
            }
            return values;
        }, snapshot.map);
    }
    async saveAction(action) {
        checkAbort(this.signal);
        const receipt = this.requireReceipt ? this.page.waitForResponse(response => {
            try { return new URL(response.url()).pathname === '/exam-ans/exam/test/preview-save' && response.request().method() === 'POST'; }
            catch { return false; }
        }, { timeout: 5000 }).then(async response => {
            const body = await response.json();
            return response.ok() && (body.status === 'success' || body.success === true);
        }).catch(() => false) : Promise.resolve(null);
        await action();
        if (this.requireReceipt && await receipt !== true) throw new Error('EXAM_SAVE_NOT_CONFIRMED');
        checkAbort(this.signal);
    }
    async fill(snapshot, answers) {
        const fresh = await this.extract();
        if (fresh.fingerprint !== snapshot.fingerprint) throw new Error('EXAM_CHANGED_BEFORE_FILL');
        for (const answer of answers) {
            checkAbort(this.signal);
            const item = snapshot.map.find(row => row.id === answer.id);
            if (!item) throw new Error('EXAM_ANSWER_ID_UNKNOWN');
            if (item.options) {
                const expected = [...answer.letters].sort(), current = (await this.readValues(snapshot))[item.id].letters;
                const changes = snapshot.questions[item.id - 1].type === '多选题' ?
                    [...current.filter(letter => !expected.includes(letter)), ...expected.filter(letter => !current.includes(letter))] :
                    current.join('') === expected.join('') ? [] : expected;
                for (const letter of changes) {
                    const option = item.options.find(row => row.letter === letter);
                    if (!option) throw new Error('EXAM_OPTION_UNKNOWN');
                    const selector = '.singleQuesId[data=' + JSON.stringify(item.qid) + '] span[qid=' + JSON.stringify(item.subId) + '][data=' + JSON.stringify(option.value) + ']';
                    await this.saveAction(() => this.page.locator(selector).click({ timeout: 5000 }));
                }
                await until(() => this.readValues(snapshot), values => values[item.id].letters.join('') === expected.join(''), { signal: this.signal });
            } else {
                if (answer.texts?.length !== item.blanks.length) throw new Error('EXAM_BLANK_COUNT_CHANGED');
                for (const [index, blank] of item.blanks.entries()) {
                    const body = this.page.frameLocator(byId(blank.frameId)).locator('body');
                    if ((await body.innerText()).trim() === answer.texts[index]) continue;
                    await body.fill(answer.texts[index]);
                    await this.saveAction(() => this.page.locator(byId(blank.saveId)).click({ timeout: 5000 }));
                }
            }
        }
    }
    async verifyPersisted(snapshot, answers) {
        checkAbort(this.signal);
        await this.refresh();
        return this.verifyCurrent(snapshot, answers);
    }
    async refresh() {
        checkAbort(this.signal);
        await this.page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 });
        await this.page.waitForFunction(() => [...document.querySelectorAll('iframe[id^=ueditor_]')]
            .every(frame => frame.contentDocument?.body?.isContentEditable), null, { timeout: 5000 });
    }
    async verifyCurrent(snapshot, answers) {
        const fresh = await this.extract();
        if (fresh.fingerprint !== snapshot.fingerprint) throw new Error('EXAM_CHANGED_AFTER_RELOAD');
        const values = await this.readValues(snapshot);
        if (answers.length !== snapshot.questions.length || answers.some(answer => {
            const value = values[answer.id];
            return !value || JSON.stringify(value.letters ? [...value.letters].sort() : value.texts) !==
                JSON.stringify(answer.letters ? [...answer.letters].sort() : answer.texts);
        })) throw new Error('EXAM_PERSISTED_ANSWERS_MISMATCH');
        return { confirmed: true, answers: answers.reduce((count, answer) => count + (answer.texts?.length || 1), 0) };
    }
}
