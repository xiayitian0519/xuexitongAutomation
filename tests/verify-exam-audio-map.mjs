import assert from 'node:assert/strict';
import { assignExamAudio } from '../automation/exam-audio-map.mjs';

let passed = 0;
const test = (name, run) => { run(); passed++; console.log('PASS ' + name); };
const first = 'https://audio.chaoxing.com/one.mp3?enc=fixture-secret';
const second = 'https://audio.chaoxing.com/two.mp3?enc=fixture-secret';
const sources = [{ qid: 'card', sourceUrl: first }, { qid: 'card', sourceUrl: second }];
const questions = [
    { id: 1, qid: 'card', audioPart: 1, audioNumber: 1 },
    { id: 2, qid: 'card', audioPart: 1, audioNumber: 2 },
    { id: 3, qid: 'card', audioPart: 2, audioNumber: 1 },
    { id: 4, qid: 'card', audioPart: 2, audioNumber: 2 },
];
const copy = value => structuredClone(value);
const mapped = (rows, map = questions, options = {}) => assignExamAudio(rows, map, options).map(row => row.questionIds);

test('two passages keep independent question numbering', () => {
    assert.deepEqual(mapped(sources, questions, { requireQuestionNumbers: true }), [[1, 2], [3, 4]]);
});
test('duplicate DOM audio elements do not create extra clips', () => {
    assert.deepEqual(mapped([sources[0], sources[0], sources[1], sources[1]]), [[1, 2], [3, 4]]);
});
test('shared source across cards has one clip and distinct question ids', () => {
    const map = [{ id: 1, qid: 'a', audioNumber: 1 }, { id: 2, qid: 'b', audioNumber: 2 }];
    const result = assignExamAudio([{ qid: 'a', sourceUrl: first }, { qid: 'b', sourceUrl: first }], map);
    assert.equal(result.length, 1); assert.deepEqual(result[0].questionIds, [1, 2]);
});
test('legacy mapping without numbers remains supported', () => {
    const map = questions.map(({ audioNumber, ...item }) => item);
    assert.deepEqual(mapped(sources, map), [[1, 2], [3, 4]]);
});
test('one source can contain several labeled passages', () => {
    const map = questions.map(({ audioNumber, ...item }) => item);
    assert.deepEqual(mapped([sources[0]], map), [[1, 2, 3, 4]]);
});
test('trusted explicit source parts work independently of DOM order', () => {
    assert.deepEqual(mapped([{ ...sources[1], part: 2 }, { ...sources[0], part: 1 }]), [[3, 4], [1, 2]]);
});
test('multiple clips cannot be divided by guessed subquestion positions', () => {
    assert.throws(() => mapped(sources, [{ id: 1, qid: 'card' }, { id: 2, qid: 'card' }]), /UNRESOLVED/);
});
test('zero negative fractional and out of range passage labels are rejected', () => {
    for (const audioPart of [0, -1, 1.5, 3]) {
        const map = copy(questions); map[0].audioPart = audioPart;
        assert.throws(() => mapped(sources, map), /UNRESOLVED/);
    }
});
test('every clip must have a corresponding question', () => {
    assert.throws(() => mapped(sources, questions.slice(0, 2)), /UNRESOLVED/);
});
test('mixed explicit and implicit source parts are ambiguous', () => {
    assert.throws(() => mapped([{ ...sources[0], part: 1 }, sources[1]]), /UNRESOLVED/);
});
test('conflicting explicit parts for a duplicate clip are rejected', () => {
    assert.throws(() => mapped([{ ...sources[0], part: 1 }, { ...sources[0], part: 2 }]), /PART_CONFLICT/);
});
test('two different clips cannot claim the same part', () => {
    assert.throws(() => mapped(sources.map(row => ({ ...row, part: 1 }))), /PART_CONFLICT/);
});
test('source labels must be positive integers', () => {
    for (const part of [0, -1, 1.5, '1']) assert.throws(() => mapped([{ ...sources[0], part }]), /UNRESOLVED/);
});
test('missing and unknown card bindings are rejected', () => {
    assert.throws(() => mapped([{ sourceUrl: first }]), /MAPPING_UNKNOWN/);
    assert.throws(() => mapped([{ qid: 'other', sourceUrl: first }]), /MAPPING_UNKNOWN/);
});
test('blank malformed and credential-bearing sources are rejected', () => {
    for (const sourceUrl of ['', null, 'not a URL', 'https://person:secret@audio.chaoxing.com/a.mp3'])
        assert.throws(() => mapped([{ qid: 'card', sourceUrl }]), /MAPPING_UNKNOWN/);
});
test('question identities must be positive and unique', () => {
    assert.throws(() => mapped(sources, [{ id: 1, qid: 'card' }, { id: 1, qid: 'card' }]), /MAPPING_UNKNOWN/);
    assert.throws(() => mapped(sources, [{ id: 0, qid: 'card' }]), /MAPPING_UNKNOWN/);
    assert.throws(() => mapped(sources, [{ id: 1, qid: '' }]), /MAPPING_UNKNOWN/);
});
test('a missing question number is rejected once numbering is in use', () => {
    const map = copy(questions); delete map[1].audioNumber;
    assert.throws(() => mapped(sources, map), /QUESTION_NUMBERS_UNRESOLVED/);
});
test('strict mode rejects all missing audio question numbers', () => {
    const map = questions.map(({ audioNumber, ...item }) => item);
    assert.throws(() => mapped(sources, map, { requireQuestionNumbers: true }), /QUESTION_NUMBERS_UNRESOLVED/);
});
test('a complete page question needs no audio question number', () => {
    const map = copy(questions); delete map[1].audioNumber; map[1].pageQuestion = true;
    assert.deepEqual(mapped(sources, map, { requireQuestionNumbers: true }), [[1, 2], [3, 4]]);
});
test('invalid and duplicate audio question numbers are rejected per clip', () => {
    for (const audioNumber of [0, -1, 1.5, '2', 1]) {
        const map = copy(questions); map[1].audioNumber = audioNumber;
        assert.throws(() => mapped(sources, map), /QUESTION_NUMBERS_UNRESOLVED/);
    }
});
test('shared clips cannot silently reuse an ambiguous numbered question', () => {
    assert.throws(() => assignExamAudio([{ qid: 'a', sourceUrl: first }, { qid: 'b', sourceUrl: first }],
        [{ id: 1, qid: 'a', audioNumber: 1 }, { id: 2, qid: 'b', audioNumber: 1 }]), /QUESTION_NUMBERS_UNRESOLVED/);
});
test('empty audio mapping is valid and does not mutate inputs', () => {
    assert.deepEqual(assignExamAudio([], questions), []);
    const before = JSON.stringify({ sources, questions }); assignExamAudio(sources, questions);
    assert.equal(JSON.stringify({ sources, questions }), before);
});
test('mapping errors never include source queries', () => {
    const rows = [{ qid: 'other', sourceUrl: first }];
    assert.throws(() => mapped(rows), error => !error.message.includes('fixture-secret') && /MAPPING_UNKNOWN/.test(error.message));
});
console.log('All ' + passed + ' audio mapping groups passed; no browser, network, or paid model calls.');
