import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { ExamAnswerAdapter } from '../automation/exam-answer-adapter.mjs';
import { extractExamDom } from '../automation/exam-paper-snapshot.mjs';
import { groupExamQuestions } from '../automation/exam-question-groups.mjs';
import { validQuestions } from '../deepseek-console/answer-contract.mjs';

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log('PASS ' + name); };
const image = 'https://p.chaoxing.com/fixture.png';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');
const option = (id, letter, text) => `<div class="hoverDiv"><span qid="${id}" data="${letter}">${letter}</span><div class="answer_p">${text}</div></div>`;
const childChoice = (id, title, text = 'Two') => `<div class="reading_answer"><p class="reader_answer_tit">${title}</p><div class="stem_answer">${option(id,'A','One')}${option(id,'B',text)}</div></div><input id="answer${id}">`;
const editor = (n, prompt = '') => `<div class="editor"><textarea id="answerEditor${n}" ${prompt ? `data-prompt-id="${prompt}"` : ''}></textarea><iframe id="ueditor_${n}"></iframe><button id="save_${n}"></button></div>`;
const blankChild = (n, title) => `<div class="reading_answer"><p class="reader_answer_tit" id="prompt${n}">${title}</p>${editor(n)}</div>`;
const blank = () => `<div class="singleQuesId" data="matching"><div class="mark_name">Match [A] alpha [B] beta.</div>${blankChild(1,'First statement')}${blankChild(2,'Second statement')}</div>`;
function environment(html) {
    const dom = new JSDOM(html, {url:'https://fixture.chaoxing.com/exam-ans/mooc2/exam/preview',runScripts:'outside-only'});
    Object.defineProperty(dom.window.HTMLElement.prototype,'innerText',{get(){return this.textContent;}});
    const evaluate = (fn,arg) => structuredClone(dom.window.eval('(' + fn.toString() + ')')(arg));
    const page = {url:()=>dom.window.location.href,evaluate:async(fn,arg)=>evaluate(fn,arg),frames:()=>[],locator:selector=>({
        evaluateAll: async fn => {
            const elements = [...dom.window.document.querySelectorAll(selector)];
            for (const e of elements) if (e.tagName === 'IMG') {
                Object.defineProperties(e,{complete:{value:true,configurable:true},naturalWidth:{value:1,configurable:true},naturalHeight:{value:1,configurable:true}});
                e.getBoundingClientRect=()=>({x:0,y:0,width:1,height:1,top:0,left:0,right:1,bottom:1});
            }
            return dom.window.eval('(' + fn.toString() + ')')(elements);
        },nth:()=>({screenshot:async()=>png}),
    })};
    const adapter = new ExamAnswerAdapter(page); adapter.readValues = async()=>({});
    return {dom,doc:dom.window.document,adapter,snapshot:()=>evaluate(extractExamDom)};
}
const fixture = async (html, fn) => { const e=environment(html); try {await fn(e);} finally {e.dom.window.close();} };
await test('matching statements are associated with their own editors',()=>fixture(blank(),async e=>{
    const s=await e.adapter.extract(); assert.equal(s.questions[0].blankCount,2);
    assert.match(s.questions[0].question,/1\. First statement\n2\. Second statement/);
    assert.deepEqual(s.map[0].blanks.map(b=>b.frameId),['ueditor_1','ueditor_2']);
}));
await test('missing statement blocks extraction',()=>fixture(blank(),async e=>{
    e.doc.querySelector('#prompt2').textContent=''; await assert.rejects(e.adapter.extract(),/prompt-mapping/);
}));
await test('same counts but detached prompts are rejected',()=>fixture(blank(),async e=>{
    for(const field of [...e.doc.querySelectorAll('.editor')]) e.doc.querySelector('.singleQuesId').append(field);
    await assert.rejects(e.adapter.extract(),/prompt-mapping/);
}));
await test('detached editors need exact prompt IDs and individual frame ownership',()=>fixture(blank(),async e=>{
    for(const field of [...e.doc.querySelectorAll('.editor')]) {
        const textarea=field.querySelector('textarea'); textarea.dataset.promptId='prompt'+textarea.id.replace('answerEditor','');
        e.doc.querySelector('.singleQuesId').append(field);
    }
    assert.equal((await e.adapter.extract()).questions.length,1);
}));
await test('two prompts cannot target the same field',()=>fixture(blank(),async e=>{
    e.doc.querySelector('#answerEditor2').dataset.promptId='prompt1'; await assert.rejects(e.adapter.extract(),/prompt-mapping/);
}));
await test('ambiguous global iframe ordering is rejected',()=>fixture(blank(),async e=>{
    const card=e.doc.querySelector('.singleQuesId');
    for(const field of [...e.doc.querySelectorAll('textarea')]) {field.dataset.promptId='prompt'+field.id.replace('answerEditor','');card.append(field);}
    for(const frame of [...e.doc.querySelectorAll('iframe')])card.append(frame);
    await assert.rejects(e.adapter.extract(),/mapping/);
}));
await test('explicit iframe references permit reversed frame order',()=>fixture(blank(),async e=>{
    const card=e.doc.querySelector('.singleQuesId');
    for(const field of [...e.doc.querySelectorAll('textarea')]) {field.dataset.frameId='ueditor_'+field.id.replace('answerEditor','');}
    for(const frame of [...e.doc.querySelectorAll('iframe')].reverse())card.append(frame);
    assert.deepEqual((await e.adapter.extract()).map[0].blanks.map(b=>b.frameId),['ueditor_1','ueditor_2']);
}));
await test('hidden prompt and duplicate frame IDs reject',()=>fixture(blank(),async e=>{
    e.doc.querySelector('#prompt2').hidden=true; await assert.rejects(e.adapter.extract(),/mapping/);
    e.doc.querySelector('#prompt2').hidden=false;e.doc.querySelector('#ueditor_2').id='ueditor_1';
    await assert.rejects(e.adapter.extract(),/mapping/);
}));
await test('missing child choice cannot silently reduce paper size',()=>fixture(`<div class="singleQuesId" data="choices"><div class="mark_name">Choose.</div>${childChoice('a','Which one?')}${childChoice('b','Which two?')}</div>`,async e=>{
    e.doc.querySelectorAll('.stem_answer')[1].remove();await assert.rejects(e.adapter.extract(),/missing-child/);
}));
await test('image options and child images stay with their exact question',()=>fixture(`<div class="singleQuesId" data="images"><div class="mark_name">Read. <img src="${image}"></div>${childChoice('a',`Which image? <img src="${image}">`,`<img src="${image}">`)}${childChoice('b','Which number?')}</div>`,async e=>{
    const s=await e.adapter.extract(); assert.equal(s.questions[0].images.length,3);assert.equal(s.questions[1].images.length,1);
    assert.match(s.questions[0].options[1].text,/\[图3\]/);assert.match(s.questions[0].question,/本题问句图片：\[图2\]/); assert.ok(validQuestions(s.questions));
}));
await test('hidden ancestors cannot masquerade as visible questions',()=>fixture(`<section style="display:none">${blank()}</section>`,async e=>{
    await assert.rejects(e.adapter.extract(),/stem-missing/);
    const section=e.doc.querySelector('section');section.style.display='block';section.style.visibility='hidden';
    await assert.rejects(e.adapter.extract(),/stem-missing/);
}));
await test('unrecognized image locations and unloaded sources reject',()=>fixture(blank(),async e=>{
    e.doc.querySelector('.singleQuesId').insertAdjacentHTML('beforeend',`<img src="${image}">`);
    await assert.rejects(e.adapter.extract(),/position/);e.doc.querySelector('img').removeAttribute('src');
    await assert.rejects(e.adapter.extract(),/unreadable/);
}));
await test('audio placeholder without resolved clip blocks before model',()=>fixture(`<div class="singleQuesId" data="listening"><div class="mark_name">Listen.</div><iframe src="about:blank"></iframe>${childChoice('audio','Passage 1 Question 1')}</div>`,async e=>{
    await assert.rejects(e.adapter.extract(),/AUDIO_MATERIAL_MISSING/);
}));
await test('question numbers must be explicit, never inferred from child order',()=>fixture(`<div class="singleQuesId" data="listening"><div class="mark_name">Listen.</div>${childChoice('audio','Passage 1 Question 2')}</div>`,async e=>{
    let s=e.snapshot();assert.equal(s.map[0].audioNumber,2);assert.equal(s.map[0].audioPart,1);assert.equal(s.map[0].pageQuestion,false);
    e.doc.querySelector('.reader_answer_tit').textContent='Listen and choose';s=e.snapshot();assert.equal(s.map[0].audioNumber,null);
}));
await test('iframe enumeration order cannot swap Passage recordings',()=>fixture(`<div class="singleQuesId" data="listening"><div class="mark_name">Listen.</div><iframe id="audiofirst"></iframe><iframe id="audiosecond"></iframe>${childChoice('a','Passage 1 Question 1')}${childChoice('b','Passage 1 Question 2')}${childChoice('c','Passage 2 Question 1')}</div>`,async e=>{
    const frame=(id,n)=>({locator:()=>({evaluateAll:async()=>[{sourceUrl:`https://a.chaoxing.com/clip-${n}.mp3`,qid:null,innerOrder:0,domOrder:-1}]}),
        frameElement:async()=>({evaluate:async fn=>fn(e.doc.getElementById(id))})});
    const first=frame('audiofirst',1),second=frame('audiosecond',2);
    e.adapter.page.frames=()=>[second,first];e.adapter.page.mainFrame=()=>null;
    const s=await e.adapter.extract();assert.deepEqual(s.audio.map(a=>a.questionIds),[[1,2],[3]]);
    assert.match(s.audio[0].sourceUrl,/clip-1/);assert.match(s.audio[1].sourceUrl,/clip-2/);
    e.adapter.page.frames=()=>[first,second];assert.equal((await e.adapter.extract()).fingerprint,s.fingerprint);
}));
await test('unreadable frame fails explicitly rather than becoming text-only',()=>fixture(`<div class="singleQuesId" data="listening"><div class="mark_name">Listen.</div><iframe></iframe>${childChoice('a','Question 1')}</div>`,async e=>{
    e.adapter.page.frames=()=>[{locator:()=>({evaluateAll:async()=>{throw new Error('private signed URL');}})}];
    await assert.rejects(e.adapter.extract(),error=>error.message==='EXAM_AUDIO_FRAME_UNREADABLE');
}));
await test('image-aware batches meet attachment limits without dropping questions',async()=>{
    const q=id=>({id,type:'单选题',question:'Select.',options:[{letter:'A',text:'One'},{letter:'B',text:'Two'}],images:Array(4).fill('data:image/png;base64,'+'A'.repeat(1200000))});
    const groups=groupExamQuestions(Array.from({length:5},(_,i)=>({sourceId:i+1,question:q(i+1)})),'text');
    assert.deepEqual(groups.map(g=>g.sourceIds),[[1],[2],[3],[4],[5]]);assert.ok(groups.every(g=>validQuestions(g.questions)));
    assert.throws(()=>groupExamQuestions([{sourceId:1,question:{...q(1),images:Array(5).fill('data:image/png;base64,AAAA')}}],'text'),/MATERIAL_INVALID/);
});
console.log('All '+passed+' material completeness groups passed; no browser/network/model.');
