import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, relative, isAbsolute } from 'node:path';
import { atomicJson } from '../listening/transcript-store.mjs';
import { EXAM_WORKFLOW_REVISION } from '../automation/exam-runner.mjs';

// Explicit offline allowlist: no script here launches a browser, real CLI or
// transcription engine. Browser-shaped fixtures are jsdom or injected objects.
const checks = [
    ['verify-exam-material-completeness',17], ['verify-exam-audio-map',23],
    ['verify-exam-audio-materials',7], ['verify-exam-image-cache',20],
    ['verify-wb-receipts',17], ['verify-exam-model-retention',11],
    ['verify-exam-images',8], ['verify-exam-audio-parts',5],
    ['verify-exam-blank-prompts',4], ['verify-exam-recovery',12],
    ['verify-listening-pipeline',15], ['verify-wb-cli',16],
    ['verify-cli-long-prompt',1], ['verify-text-questions',11],
    ['verify-exam-result-continuity',5], ['verify-entry-table',6],
    ['verify-session-diagnostics',8],
];
const root=resolve(import.meta.dirname,'..'), run=promisify(execFile), started=performance.now();
const args=process.argv.slice(2);
if(args.length && (args.length!==2 || args[0]!=='--report')) throw new Error('USE_OPTIONAL_REPORT_PATH');
let cursor=0;
const results=Array(checks.length);
await Promise.all(Array.from({length:3},async()=>{
    while(cursor<checks.length){
        const index=cursor++, [name,groups]=checks[index], start=performance.now();
        try {
            const {stdout}=await run(process.execPath,[resolve(root,'tests',name+'.mjs')],{cwd:root,windowsHide:true,maxBuffer:1024*1024,timeout:60000});
            if(!/PASS|全部离线用例通过|"passed"\s*:\s*\d+/.test(stdout))throw new Error('TEST_SUMMARY_MISSING');
            results[index]={script:'tests/'+name+'.mjs',passed:true,groups,elapsedMs:Math.round(performance.now()-start)};
        }catch{
            results[index]={script:'tests/'+name+'.mjs',passed:false,groups:0,code:'OFFLINE_CHECK_FAILED'};
        }
    }
}));
const report={version:1,at:new Date().toISOString(),revision:EXAM_WORKFLOW_REVISION,passed:results.every(row=>row.passed),
    scripts:checks.length,groups:results.reduce((sum,row)=>sum+row.groups,0),elapsedMs:Math.round(performance.now()-started),
    newBrowsers:0,desktopActions:0,platformRequests:0,paidCalls:0,results,
    limits:['Synthetic fixtures; no new live end-to-end validation.','Group counts combine assertions and scenario groups; not a count of real assignments.']};
if(args.length){
    const target=resolve(root,args[1]), rel=relative(resolve(root,'deliverables'),target);
    if(!rel || rel.startsWith('..') || isAbsolute(rel) || !target.endsWith('.json'))throw new Error('REPORT_MUST_BE_IN_DELIVERABLES');
    await atomicJson(target,report);
}
console.log(JSON.stringify(report,null,2));
if(!report.passed)process.exitCode=1;
