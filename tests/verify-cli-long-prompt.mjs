import assert from 'node:assert/strict';
import{requestAnswers}from'../deepseek-console/wb-cli-request.mjs';
const questions=Array.from({length:15},(_,i)=>({id:i+1,type:'单选题',question:'shared listening material '.repeat(220)+` final question ${i+1}`,
 options:[{letter:'A',text:'first'},{letter:'B',text:'second'}]}));
const expected=questions.map(q=>({id:q.id,letters:['A']}));
let captured=false;
const answers=await requestAnswers(questions,undefined,{runner:async(args,timeout,stdin)=>{
 assert.ok(args.join(' ').length<12000,'long material must not enter the process command line');
 assert.equal(args[args.indexOf('--input-format')+1],'stream-json');
 const payload=JSON.parse(stdin);
 const prompt=payload.message.content.find(c=>c.type==='text').text;
 for(const q of questions)assert.ok(prompt.includes(q.question),'all question material must be preserved');
 assert.equal(payload.message.content.length,1);
 captured=true;
 return{stdout:JSON.stringify([{type:'result',is_error:false,structured_output:{answers:expected}}]),exitCode:0};
}});
assert.ok(captured);assert.deepEqual(answers,expected);
console.log('PASS long listening prompt: bounded Windows arguments, full material over stdin, strict answers');
