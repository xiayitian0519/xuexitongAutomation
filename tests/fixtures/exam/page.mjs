// Hand-authored, anonymous structural sample. No real exam questions or accounts.
export const identity = { courseKey: 'course:offline:class', examId: 'offline-exam', title: '离线流程样例' };
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
const header = '<title>离线流程样例</title><h1 data-exam-id="offline-exam">离线流程样例</h1>';
export function examHtml(state, phase) {
    if (phase === 'result') return header + '<h2>交卷成功</h2><p>最终成绩96.0分</p>';
    if (phase === 'entry') return header + '<span class="agree_check ' + (state.checked ? 'agree_checked' : '') +
        '" onclick="this.classList.toggle(\'agree_checked\')">我已阅读并同意</span>' +
        '<a id="startBtn" class="disble_time_btn" onclick="if(document.querySelector(\'.agree_checked\'))document.querySelector(\'#entryDialog\').hidden=false">进入考试</a>' +
        '<div hidden><button>进入考试</button></div><div id="entryDialog" hidden>考试时长90分钟' +
        '<a id="tabIntoexam2" onclick="location.href=\'/exam-ans/exam/test/reVersionTestStartNew?examId=offline-exam\'">进入考试</a></div>';
    const selected = (key, value) => (state.saved[key] || '').includes(value);
    const option = (key, letter, value, text, multiple) => '<div class="hoverDiv"><span qid="' + key + '" data="' + value +
        '" class="' + (multiple ? 'num_option_dx' : 'num_option') + (selected(key, value) ? multiple ? ' check_answer_dx' : ' check_answer' : '') +
        '" onclick="choose(this,' + !!multiple + ')">' + letter + '</span><div class="answer_p">' + text + '</div></div>';
    return header + '<div class="singleQuesId" data="reading"><h3 class="mark_name">【单选题】Read the short sentence.</h3>' +
        '<div class="reading_answer"><p class="reader_answer_tit">Which number is even?</p><div class="stem_answer">' +
        option('one', 'A', 'Z', 'Three', false) + option('one', 'B', 'Y', 'Four', false) + '</div></div></div>' +
        '<input type="hidden" id="answerone" value="' + escape(state.saved.one || '') + '">' +
        '<div class="singleQuesId" data="multiple"><h3 class="mark_name">【多选题】Choose even numbers.</h3><div class="stem_answer">' +
        option('two', 'A', 'X', 'Two', true) + option('two', 'B', 'W', 'Three', true) + option('two', 'C', 'V', 'Four', true) +
        '</div></div><input type="hidden" id="answertwo" value="' + escape(state.saved.two || '') + '">' +
        '<div class="singleQuesId" data="blank"><h3 class="mark_name">【填空题】Fill the fixed word.</h3>' +
        '<textarea id="answerEditorword" hidden></textarea><iframe id="ueditor_1" srcdoc="' +
        escape('<body contenteditable="true">' + escape(state.saved.word || '') + '</body>') + '"></iframe>' +
        '<button id="save_word" onclick="save(\'word\',document.querySelector(\'iframe\').contentDocument.body.innerText.trim())">保存</button></div>' +
        (state.audio ? ['one', 'two'].map(name =>
            '<div class="singleQuesId" data="listening-' + name + '"><h3 class="mark_name">【单选题】Listen to the conversation.</h3>' +
            '<audio preload="none" src="https://pan.chaoxing.com/clip-' + name + '.wav"></audio>' +
            '<div class="reading_answer"><p class="reader_answer_tit">1.</p><div class="stem_answer">' +
            option('sound' + name, 'A', 'P', 'One', false) + option('sound' + name, 'B', 'Q', 'Two', false) + '</div></div></div>' +
            '<input type="hidden" id="answersound' + name + '" value="' + escape(state.saved['sound' + name] || '') + '">').join('') : '') +
        (state.noOverview ? '' : '<a href="/exam-ans/mooc2/exam/preview?examId=offline-exam"' +
            (state.overviewPopup ? ' target="_blank"' : '') + '>整卷预览</a>') +
        '<a class="completeBtn" onclick="document.querySelector(\'#submitDialog\').hidden=false">交卷</a>' +
        '<div id="submitDialog" hidden><p>确认交卷？</p><a class="confirm" onclick="location.href=\'/exam-ans/exam/test/look?examId=offline-exam\'">确定</a>' +
        (state.ambiguous ? '<button>确定</button>' : '') + '</div>' +
        '<script>async function save(key,value){return fetch("/exam-ans/exam/test/preview-save",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({key,value})})}' +
        'function choose(e,multiple){const key=e.getAttribute("qid"),hidden=document.getElementById("answer"+key);' +
        'const all=[...document.querySelectorAll("span[qid="+key+"]")];if(multiple)e.classList.toggle("check_answer_dx");' +
        'else{all.forEach(x=>x.classList.remove("check_answer"));e.classList.add("check_answer")}' +
        'hidden.value=all.filter(x=>x.classList.contains("check_answer")||x.classList.contains("check_answer_dx")).map(x=>x.getAttribute("data")).join("");save(key,hidden.value)}' +
        '</script>';
}
