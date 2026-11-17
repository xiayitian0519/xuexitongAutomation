import assert from 'node:assert/strict';
import {readExamCardImages} from '../automation/exam-answer-adapter.mjs';
const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=','base64');
const image={source:'https://p.chaoxing.com/fixture.png?enc=private',loaded:true,supportedPosition:true};
const page=(rows,options={})=>({locator:()=>({evaluateAll:async()=>rows,nth:()=>({screenshot:async()=>options.bytes||bytes})})});
assert.deepEqual(await readExamCardImages(page([]),'123'),[]);
const result=await readExamCardImages(page([image]),'123');assert.ok(result[0].startsWith('data:image/png;base64,'));assert.equal(result[0].includes('private'),false);
await assert.rejects(readExamCardImages(page([{...image,loaded:false}]),'123'),/UNREADABLE/);
await assert.rejects(readExamCardImages(page([{...image,supportedPosition:false}]),'123'),/UNREADABLE/);
await assert.rejects(readExamCardImages(page([{...image,source:'https://untrusted.invalid/x'}]),'123'),/ORIGIN_REJECTED/);
await assert.rejects(readExamCardImages(page([image],{bytes:Buffer.from('text/html')}),'123'),/FORMAT_UNSUPPORTED/);
await assert.rejects(readExamCardImages(page([image],{bytes:Buffer.concat([bytes,Buffer.alloc(1100001)])}),'123'),/IMAGE_LIMIT/);
await assert.rejects(readExamCardImages(page(Array(5).fill(image)),'123'),/IMAGE_LIMIT/);
console.log('PASS 8 image material checks; no browsers or model calls');

