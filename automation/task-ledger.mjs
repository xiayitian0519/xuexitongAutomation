// Durable task history is separate from the latest filtered run/scan report.
// An uncertain submission survives every observation except explicit platform completion.
import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { publicItem, isUncertainStatus } from './task-queue.mjs';

const VERSION = 1;
const STATUSES = new Set(['pending','complete','already-complete','unavailable','queued','running',
    'submitted','interrupted','needs-review','blocked','skipped']);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function rows(value, source) {
    if (!Array.isArray(value)) throw new Error(`${source}的 items 不是数组，已停止以免丢失防重复提交记录`);
    const seen = new Set();
    return value.map((item) => {
        if (!object(item) || typeof item.key !== 'string' || !item.key.trim() ||
            !['work','chapter'].includes(item.kind) || typeof item.title !== 'string' || !STATUSES.has(item.status))
            throw new Error(`${source}包含未知或损坏的任务记录，已停止以免重复提交`);
        if (seen.has(item.key)) throw new Error(`${source}包含重复任务编号，已停止以免覆盖提交记录`);
        seen.add(item.key);
        if ((item.reason !== undefined && typeof item.reason !== 'string') ||
            (item.courseTitle !== undefined && typeof item.courseTitle !== 'string') ||
            (item.remaining != null && (!Number.isInteger(item.remaining) || item.remaining < 0)))
            throw new Error(`${source}包含损坏的任务字段，已停止以免丢失提交记录`);
        // Never copy signed navigation URLs, tokens, or other transient fields into the ledger.
        return publicItem(item);
    });
}

function readJson(path, source) {
    try { return JSON.parse(readFileSync(path, 'utf8')); }
    catch { throw new Error(`${source}无法读取或不是合法 JSON，未按空历史继续。请保留原文件并先核实历史任务`); }
}

function validate(value) {
    if (!object(value) || value.version !== VERSION || typeof value.updatedAt !== 'string' ||
        !Number.isFinite(Date.parse(value.updatedAt)))
        throw new Error('任务账本版本未知或格式损坏，未按空历史继续');
    return { version: VERSION, updatedAt: value.updatedAt, items: rows(value.items, '任务账本') };
}

export function readTaskLedger(path, { legacyPath } = {}) {
    if (existsSync(path)) return validate(readJson(path, '任务账本'));
    let items = [];
    if (legacyPath && existsSync(legacyPath)) {
        const legacy = readJson(legacyPath, '旧任务报告');
        if (!object(legacy)) throw new Error('旧任务报告格式损坏，未按空历史迁移');
        items = rows(legacy.items, '旧任务报告');
    }
    return { version: VERSION, updatedAt: new Date().toISOString(), items };
}

export function mergeTaskLedger(ledger, observations) {
    const current = validate(ledger);
    const entries = new Map(current.items.map((item) => [item.key, item]));
    for (const item of rows(observations, '本次任务记录')) {
        const previous = entries.get(item.key);
        if (['complete','already-complete'].includes(item.status)) {
            // Callers use these states only for a fresh platform list or verification result.
            entries.set(item.key, { ...item, status: 'complete' });
        } else if (previous && isUncertainStatus(previous.status) && !isUncertainStatus(item.status)) {
            // Pending, unavailable, blocked and filtered scans are not proof that no submit happened.
            // Retain both the uncertain status and its reason until the platform confirms completion.
            continue;
        } else entries.set(item.key, item);
    }
    return { version: VERSION, updatedAt: new Date().toISOString(), items: [...entries.values()] };
}

export function saveTaskLedger(path, ledger) {
    const checked = validate(ledger);
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
        writeFileSync(temporary, JSON.stringify(checked, null, 2), { flag: 'wx' });
        renameSync(temporary, path);
    } finally {
        if (existsSync(temporary)) unlinkSync(temporary);
    }
}
