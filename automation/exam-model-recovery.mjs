import { join } from 'node:path';
import { atomicJson, optionalJson, digest } from '../listening/transcript-store.mjs';
import { inspectReceiptAnswers, validateReceiptAnswers } from '../deepseek-console/wb-cli-request.mjs?receipts-v1';

const filename = (directory, key) => {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('MODEL_RECEIPT_KEY_INVALID');
    return join(directory, 'model-receipts', key + '.json');
};
export async function saveGroupReceipt(directory, key, identityKey, receipt) {
    const file = filename(directory, key), sha256 = digest(receipt);
    const record = { version: 1, key, identityKey, sha256, receipt };
    const previous = await optionalJson(file);
    if (previous && digest(previous) !== digest(record)) throw new Error('MODEL_RECEIPT_ALREADY_EXISTS');
    if (!previous) await atomicJson(file, record);
    return { key, sha256 };
}
export async function loadGroupReceipt(directory, key, identityKey, reference) {
    const record = await optionalJson(filename(directory, key));
    if (!record) {
        if (reference) throw new Error('MODEL_RECEIPT_MISSING');
        return null;
    }
    if (record.version !== 1 || record.key !== key || record.identityKey !== identityKey ||
        digest(record.receipt) !== record.sha256 || reference && (reference.key !== key || reference.sha256 !== record.sha256))
        throw new Error('MODEL_RECEIPT_CONTENT_INVALID');
    return record;
}
export function inspectStoredGroup(questions, record) {
    if (record.receipt.execution?.status !== 'completed') throw new Error('MODEL_OUTCOME_UNKNOWN');
    try {
        const answers = validateReceiptAnswers(questions, record.receipt);
        return { complete: true, answers, invalidIds: [], meta: record.receipt.meta };
    } catch {
        try { return inspectReceiptAnswers(questions, record.receipt); }
        catch { return { complete: false, answers: [], invalidIds: questions.map(q => q.id), meta: record.receipt.meta }; }
    }
}
