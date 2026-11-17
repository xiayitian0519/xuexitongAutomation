import assert from 'node:assert/strict';
import { executeSelectedQueue } from '../automation/run.mjs';

const items = [
    { key: 'course:1:2:chapter:3', kind: 'chapter', status: 'pending' },
    { key: 'course:4:5:work:6', kind: 'work', status: 'pending' },
    { key: 'course:1:2:work:7', kind: 'work', status: 'pending' },
    { key: 'course:99:99:work:8', kind: 'work', status: 'pending' },
];
const run = async questionsOnly => {
    const executed = [];
    const result = await executeSelectedQueue({ items,
        options: { mode: 'run', questionsOnly, courseKeys: ['course:1:2','course:4:5'] },
        prepare: async () => {}, checkpoint: async () => {},
        execute: async item => { executed.push(item.key); return { status: 'blocked', readonlySkip: true, reason: 'fixture' }; },
        verify: async () => { throw new Error('Unexpected verification of a read-only skip'); },
    });
    assert.equal(result.items.length, 3);
    assert.equal(result.items.some(item => item.key.startsWith('course:99:99:')), false);
    return executed;
};
assert.deepEqual(await run(true), [items[1].key, items[2].key, items[0].key]);
assert.deepEqual(await run(false), items.slice(0,3).map(item => item.key));
console.log('PASS questions-only handles scoped assignments first; ordinary run ordering and scope remain intact');
