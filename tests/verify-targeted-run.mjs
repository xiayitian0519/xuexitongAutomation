// Offline argv + actual queue tests. No browser/service/model, report or ledger writes.
import assert from 'node:assert/strict';
import { parseArgs, selectRunItems, executeSelectedQueue, main } from '../automation/run.mjs';

const course = '合成课程甲';
const item = (id,status='pending',kind='work',courseId='100') => ({
    key:`course:${courseId}:200:${kind}:${id}`,kind,title:`任务${id}`,courseTitle:courseId==='100'?course:'课程乙',status,
});
const done = item('1','complete'), uncertain = item('2'), A = item('3'), B = item('4'), C = item('5','pending','chapter');
const run = (extra=[]) => parseArgs(['--run','--course',course,...extra]);
const harness = async ({ items=[done,uncertain,A,B,C], previous=[{...uncertain,status:'submitted'}], options=run(),
    failure, blocked=false, stopAfterCheckpoint=false }={}) => {
    const state = { prepared:0, executed:[], verified:[], checkpoints:[], stopped:false };
    state.report = await executeSelectedQueue({ items,previous,options,
        prepare:async()=>{state.prepared++;},
        execute:async(task)=>{state.executed.push(task.key);if(failure)throw new Error(failure);return {status:blocked?'blocked':'verify',reason:'测试入口不支持'};},
        verify:async(task)=>{state.verified.push(task.key);return {complete:!blocked};},
        checkpoint:async(report)=>{state.checkpoints.push(structuredClone(report));if(stopAfterCheckpoint && report.items.some(row=>row.status==='running'))state.stopped=true;},
        stopped:()=>state.stopped,
    });
    return state;
};

const parsed = parseArgs(['--task-key',C.key,'--max-tasks','1','--run','--task-key',A.key,'--course',course]);
assert.deepEqual(parsed.taskKeys,[C.key,A.key]); assert.equal(parsed.maxTasks,1); assert.equal(parsed.mode,'run');
for(const mode of ['scan','login','status','stop','check','help']){
    assert.equal(parseArgs([`--${mode}`]).mode,mode);
    for(const limits of [['--task-key',A.key],['--max-tasks','1']])assert.throws(()=>parseArgs([`--${mode}`,...limits]),/仅可与 --run/);
}
assert.equal(parseArgs([]).mode,'scan');
console.log('PASS 新参数可交换顺序、重复指定不同key，仅run允许，原模式保持');

const invalidArguments = [
    ['--task-key'],['--task-key',''],['--task-key',' '],['--task-key','chapter:3'],['--task-key','course:100:200:chapter:3:extra'],
    ['--task-key','course:100:200:exam:3'],['--task-key',A.key,'--task-key',A.key],
    ['--max-tasks'],['--max-tasks',''],['--max-tasks','0'],['--max-tasks','-1'],['--max-tasks','1.5'],
    ['--max-tasks','NaN'],['--max-tasks','Infinity'],['--max-tasks','9007199254740992'],['--max-tasks','1e2'],
    ['--max-tasks','0x10'],['--max-tasks',' 1 '],['--max-tasks','1','--max-tasks','2'],
];
for(const args of invalidArguments) await assert.rejects(main(['--run',...args]),/task-key|max-tasks/);
await assert.rejects(main(['--task-key',A.key]),/仅可与 --run/);
console.log('PASS 空白、重复、不完整key及非法/超安全范围上限在入口解析阶段拒绝');

{
    const state=await harness({options:run(['--max-tasks','1'])});
    assert.deepEqual(state.executed,[A.key]);
    assert.deepEqual(state.verified,[A.key]); assert.equal(state.prepared,1);
    assert.equal(state.report.items.find(row=>row.key===done.key).status,'already-complete');
    assert.equal(state.report.items.find(row=>row.key===uncertain.key).status,'needs-review');
    assert.equal(state.report.runScope.plannedExecutions,1); assert.equal(state.report.runScope.deferredTasks,2);
    assert.ok(state.report.items.length>1,'the bound counts real execute calls, not total array length');
    assert.ok(state.checkpoints.every(report=>report.runScope.maxTasks===1));
    console.log('PASS 完成项和uncertain不消耗1项上限，实际仅执行并核实一个pending');
}

{
    const state=await harness({options:run(['--task-key',C.key,'--task-key',A.key,'--max-tasks','1'])});
    assert.deepEqual(state.executed,[A.key],'preserve discovered queue order rather than caller key order');
    assert.deepEqual(state.report.items.map(row=>row.key),[A.key]);
    assert.deepEqual(state.report.runScope.taskKeys,[C.key,A.key]);assert.equal(state.report.runScope.deferredTasks,1);
    console.log('PASS 精确key白名单按扫描顺序执行，上限截断其余指定任务');
}

{
    let prepared=0,executed=0,verified=0,checkpointed=0;
    const attempt=async(options,items=[A,B])=>executeSelectedQueue({items,previous:[],options,
        prepare:async()=>{prepared++;},execute:async()=>{executed++;},verify:async()=>{verified++;return{complete:true};},checkpoint:async()=>{checkpointed++;}});
    await assert.rejects(attempt(run(['--task-key',A.key,'--task-key','course:100:200:work:999'])),/不存在/);
    await assert.rejects(attempt(run(['--task-key','course:101:200:work:9']),[A,item('9','pending','work','101')]),/范围内/);
    await assert.rejects(attempt({...run(),taskKeys:[A.key,A.key]}),/重复/);
    await assert.rejects(attempt({...run(),taskKeys:['']}),/完整任务编号/);
    await assert.rejects(attempt(run(),[A,A]),/重复任务编号/);
    await assert.rejects(attempt({...run(),maxTasks:Number.MAX_SAFE_INTEGER+1}),/正整数/);
    assert.deepEqual([prepared,executed,verified,checkpointed],[0,0,0,0]);
    console.log('PASS 未知key、跨课程key、重复或空key与越界上限均零准备/执行/核实/检查点');
}

for(const status of ['running','submitted','interrupted','needs-review']){
    const state=await harness({items:[uncertain,A,B],previous:[{...uncertain,status}],options:run(['--max-tasks','1'])});
    assert.deepEqual(state.executed,[A.key]); assert.equal(state.report.items.find(row=>row.key===uncertain.key).status,'needs-review');
}
console.log('PASS 四种uncertain历史均保留不重交，后面的一个pending仍可执行');

{
    const state=await harness({options:run(['--task-key',uncertain.key,'--max-tasks','1'])});
    assert.equal(state.prepared,0);assert.deepEqual(state.executed,[]);assert.deepEqual(state.verified,[]);
    assert.equal(state.report.items.length,1);assert.equal(state.report.items[0].status,'needs-review');
    console.log('PASS 仅选择uncertain任务时不启动答题服务、不执行、不扩大到其他任务');
}

for(const outcome of [{blocked:true},{failure:'测试失败'}]){
    const state=await harness({...outcome,options:run(['--max-tasks','1'])});
    assert.deepEqual(state.executed,[A.key]);assert.equal(state.report.runScope.deferredTasks,2);
    assert.equal(state.report.items.find(row=>row.key===A.key).status,outcome.blocked?'blocked':'needs-review');
}
console.log('PASS 唯一一次执行失败或被阻止后仍不启动第二项');

{
    const state=await harness({options:run(['--task-key',A.key,'--max-tasks','1']),stopAfterCheckpoint:true});
    assert.deepEqual(state.executed,[]);assert.equal(state.report.phase,'stopped');assert.equal(state.report.items[0].status,'interrupted');
    console.log('PASS 范围闸口保留checkpoint停止保护，停止后零执行');
}

{
    const input=[done,uncertain,A,B,C], previous=[{...uncertain,status:'submitted'}];
    const before=structuredClone({input,previous});
    const selection=selectRunItems({items:input,previous,course,maxTasks:1});
    assert.deepEqual({input,previous},before);assert.equal(selection.runScope.plannedExecutions,1);
    assert.deepEqual(input.map(row=>row.status),['complete','pending','pending','pending','pending']);
    console.log('PASS 范围选择不改原扫描结果或uncertain历史');
}
console.log('Targeted run: 10 groups passed; no browser, model, latest.json or ledger writes');
