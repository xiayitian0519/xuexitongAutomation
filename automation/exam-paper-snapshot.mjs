// Runs inside page.evaluate. Keep this function self-contained and read-only.
// Only anonymous structure/answers are used by offline fixtures; live material
// belongs in the task's private directory, never in diagnostics.
export function extractExamDom() {
    const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
    const uniqueId = id => [...document.querySelectorAll('[id]')].filter(e => e.id === id).length === 1;
    const hidden = e => {
        if (!e) return true;
        for (let node=e;node;node=node.parentElement) {
            const style=getComputedStyle(node);
            if (node.hidden || node.getAttribute('aria-hidden') === 'true' || style.display === 'none' ||
                ['hidden','collapse'].includes(style.visibility) || style.contentVisibility === 'hidden' || Number.parseFloat(style.opacity) === 0) return true;
        }
        return false;
    };
    const result = { questions: [], map: [], unsupported: [], imageCounts: {}, audioExpectedCardIds: [] };
    const cards = [...document.querySelectorAll('.singleQuesId[data]')], cardIds = new Set();
    for (const card of cards) {
        const qid = card.getAttribute('data'), stemElement = card.querySelector('.mark_name');
        const stem = clean(stemElement?.innerText);
        if (!/^[a-z0-9_-]+$/i.test(qid || '') || cardIds.has(qid)) { result.unsupported.push('invalid-card-id'); continue; }
        cardIds.add(qid);
        if (card.querySelector('video,object,embed')) { result.unsupported.push('unsupported-embedded-material'); continue; }
        if (card.querySelector('audio,iframe:not([id^=ueditor_])')) result.audioExpectedCardIds.push(qid);
        if (card.querySelectorAll('.mark_name').length !== 1 || hidden(stemElement)) { result.unsupported.push('card-stem-missing'); continue; }
        if ([...card.querySelectorAll('canvas,math,svg')].some(e => !e.closest('.asFlagBtn') || e.closest('.answer_p,.reader_answer_tit'))) {
            result.unsupported.push('exam-vector-material-need-adapter'); continue;
        }
        const children = [...card.querySelectorAll('.reading_answer')];
        if (children.some(child => hidden(child) || child.querySelector('.reading_answer'))) { result.unsupported.push('ambiguous-child-layout'); continue; }
        const groups = children.length ? children : [card];
        const imageElements = [...card.querySelectorAll('img')];
        if (imageElements.some(e => !e.getAttribute('src') || hidden(e))) { result.unsupported.push('image-material-unreadable'); continue; }
        result.imageCounts[qid] = imageElements.length;
        const imageRoles = imageElements.map((e, index) => ({ index,
            region: e.closest('.answer_p') ? 'option' : e.closest('.reader_answer_tit') ? 'prompt' : e.closest('.mark_name') ? 'stem' : 'unknown',
            child: e.closest('.reading_answer') ? children.indexOf(e.closest('.reading_answer')) : null,
            value: e.closest('.hoverDiv')?.querySelector('span[qid][data]')?.getAttribute('data') || null,
        }));
        if (imageRoles.some(row => row.region === 'unknown' || row.region === 'option' && !row.value)) { result.unsupported.push('image-material-position-unknown'); continue; }
        const relevantImages = index => imageRoles.filter(row => row.region === 'stem' || row.child === (children.length ? index : null)).map(row => row.index);
        const fields = [...card.querySelectorAll('textarea[id^=answerEditor]')];
        const frames = [...card.querySelectorAll('iframe[id^=ueditor_]')];
        const choiceGroups = groups.map(group => [...group.querySelectorAll('.stem_answer .hoverDiv span[qid][data]')]);
        if (choiceGroups.some(spans => spans.length)) {
            if (fields.length || frames.length || choiceGroups.some(spans => !spans.length)) { result.unsupported.push('mixed-or-missing-child-controls'); continue; }
            for (const [index, group] of groups.entries()) {
                const spans = choiceGroups[index], subId = spans[0].getAttribute('qid');
                const titles = [...group.querySelectorAll('.reader_answer_tit')];
                if (!/^[a-z0-9_-]+$/i.test(subId || '') || spans.some(e => e.getAttribute('qid') !== subId) ||
                    children.length && (titles.length !== 1 || hidden(titles[0]))) { result.unsupported.push('ambiguous-choice-id-or-prompt'); continue; }
                const title = clean(titles[0]?.innerText);
                if (children.length && !title && !titles[0]?.querySelector('img[src]')) { result.unsupported.push('child-prompt-missing'); continue; }
                const options = spans.map(e => {
                    const content = e.closest('.hoverDiv')?.querySelector('.answer_p');
                    return { letter: clean(e.innerText).replace(/[.．、]$/, ''), value: e.getAttribute('data'),
                        text: clean(content?.innerText) || (content?.querySelector('img[src]') ? '选项原图' : '') };
                });
                if (options.length < 2 || options.length > 8 || spans.some(e=>hidden(e) || hidden(e.closest('.hoverDiv')?.querySelector('.answer_p'))) || options.some(o => !/^[A-H]$/.test(o.letter) || !o.value || !o.text) ||
                    new Set(options.map(o => o.value)).size !== options.length || new Set(options.map(o => o.letter)).size !== options.length || !uniqueId('answer' + subId)) {
                    result.unsupported.push('choice-mapping-invalid'); continue;
                }
                const type = /多选/.test(stem + title) || spans.some(e => /_dx\b/.test(e.className)) ? '多选题' : /判断/.test(stem + title) ? '判断题' : '单选题';
                const id = result.questions.length + 1;
                result.questions.push({ id, type, question: stem + (title ? '\n本题：' + title : ''), options: options.map(({letter,text}) => ({letter,text})) });
                const explicitNumbers = [...title.matchAll(/\b(?:question|number)\s*(\d{1,2})\b/gi)];
                const leadingNumber = title.match(/^\s*(\d{1,2})[.．)、]/);
                const audioNumber = explicitNumbers.length === 1 ? Number(explicitNumbers[0][1]) : explicitNumbers.length ? null : leadingNumber ? Number(leadingNumber[1]) : null;
                const pageQuestion = /\b(?:what|when|where|which|who|whom|whose|why|how)\b|[?？]|_{2,}/i.test(title || (!children.length ? stem : ''));
                const parts = [...title.matchAll(/\bPassage\s*(\d{1,2})\b/gi)];
                result.map.push({id,key:qid + ':' + subId,qid,subId,child:index+1,options,pageQuestion,
                    audioPart:parts.length === 1 ? Number(parts[0][1]) : null,audioNumber,
                    imageIndexes:relevantImages(index),stemImageIndexes:imageRoles.filter(row=>row.region==='stem').map(row=>row.index),
                    promptImageIndexes:imageRoles.filter(row=>row.region==='prompt' && row.child===(children.length?index:null)).map(row=>row.index),
                    optionImageIndexes:Object.fromEntries(options.map(o => [o.letter,
                        imageRoles.filter(row => row.region === 'option' && row.child === (children.length ? index : null) && row.value === o.value).map(row => row.index)]))});
            }
            continue;
        }
        const allText = stem + ' ' + children.map(child => clean(child.querySelector('.reader_answer_tit')?.innerText)).join(' ');
        if (!fields.length || fields.length !== frames.length || fields.length > 20 ||
            /计算|推导|证明|解题过程|拍照|上传|论文|一课一文|\b(?:calculate|derive|prove|upload|essay)\b/i.test(allText)) {
            result.unsupported.push('unsupported-or-process-question'); continue;
        }
        const blanks = [], prompts = [];
        for (const field of fields) {
            let frame = null;
            const frameId = field.getAttribute('data-frame-id') || field.getAttribute('aria-controls');
            if (frameId) frame = frames.find(item => item.id === frameId);
            else {
                // UEditor registration is read-only. Never call getEditor(),
                // which could initialize an editor during extraction.
                const registered = Object.values(globalThis.UE?.instants || {}).filter(e => e?.key === field.id || e?.textarea === field);
                if (registered.length === 1) frame = frames.find(item => item === registered[0].iframe || item.id === registered[0].iframe?.id);
                for (let parent = field.parentElement; !frame && parent && card.contains(parent); parent = parent.parentElement) {
                    const localFields = parent.querySelectorAll('textarea[id^=answerEditor]'), localFrames = parent.querySelectorAll('iframe[id^=ueditor_]');
                    if (localFields.length === 1 && localFrames.length === 1) frame = localFrames[0];
                    if (parent === card) break;
                }
            }
            const saveId = 'save_' + field.id.replace(/^answerEditor/, '');
            const save = document.getElementById(saveId);
            if (!frame || hidden(frame) || !uniqueId(field.id) || !uniqueId(frame.id) || !uniqueId(saveId) || !card.contains(save)) {
                result.unsupported.push('blank-editor-mapping-ambiguous'); break;
            }
            let prompt = null;
            const promptId = field.getAttribute('data-prompt-id') || field.getAttribute('aria-labelledby');
            if (promptId) {
                const candidate = document.getElementById(promptId);
                if (uniqueId(promptId) && card.contains(candidate) && candidate.matches('.reader_answer_tit')) prompt = candidate;
            } else prompt = field.closest('.reading_answer')?.querySelector('.reader_answer_tit');
            if (children.length && (!prompt || hidden(prompt) || !clean(prompt.innerText) && !prompt.querySelector('img[src]'))) {
                result.unsupported.push('blank-prompt-mapping-incomplete'); break;
            }
            blanks.push({editorId:field.id,frameId:frame.id,saveId});
            if (prompt) prompts.push(prompt);
        }
        if (blanks.length !== fields.length || new Set(blanks.map(row => row.frameId)).size !== frames.length ||
            children.length && (prompts.length !== children.length || new Set(prompts).size !== children.length)) {
            result.unsupported.push('blank-prompt-mapping-incomplete'); continue;
        }
        const id = result.questions.length + 1;
        const blankPromptText = p => clean(p.innerText) + [...p.querySelectorAll('img')].map(e => ' [图' + (imageElements.indexOf(e)+1) + ']').join('');
        result.questions.push({id,type:'填空题',question:stem + (prompts.length ? '\n按输入框顺序对应的子题：\n' + prompts.map((p,i)=>(i+1)+'. '+blankPromptText(p)).join('\n') : ''),blankCount:blanks.length});
        result.map.push({id,key:qid+':blanks',qid,blanks,pageQuestion:true,imageIndexes:imageRoles.map(row=>row.index)});
    }
    return result;
}
