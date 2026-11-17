import { validQuestions } from '../deepseek-console/answer-contract.mjs';

// Keep a question and all of its images together. Limits are the local wire
// contract, not an assertion about the model provider's capabilities.
export function groupExamQuestions(rows, prefix) {
    if (!Array.isArray(rows) || typeof prefix !== 'string' || !/^[a-z-]+$/.test(prefix)) throw new Error('EXAM_GROUP_INVALID');
    const groups = [], seen = new Set();
    let current = [];
    const questionsFor = batch => batch.map((row, index) => ({ ...row.question, id: index + 1 }));
    const flush = () => {
        if (!current.length) return;
        groups.push({ name: prefix + '-' + groups.length, sourceIds: current.map(row => row.sourceId), questions: questionsFor(current) });
        current = [];
    };
    for (const row of rows) {
        if (!Number.isInteger(row?.sourceId) || row.sourceId < 1 || seen.has(row.sourceId) || !validQuestions(questionsFor([row])))
            throw new Error('EXAM_QUESTION_MATERIAL_INVALID');
        seen.add(row.sourceId);
        if (!validQuestions(questionsFor([...current, row]))) flush();
        current.push(row);
    }
    flush();
    return groups;
}
