export const actionable = (item) => item.status === 'pending';
export const isUncertainStatus = (status) => ['running','interrupted','submitted','needs-review'].includes(status);

// Navigation URLs (including signed query strings) stay in memory, never in reports.
export function publicItem(item) {
    const { key, kind, title, status, reason = '', remaining, courseTitle } = item;
    return { key, kind, title, status, reason, ...(remaining != null ? { remaining } : {}), ...(courseTitle ? { courseTitle } : {}) };
}

export function cleanError(error) {
    return String(error?.message || error).replace(/https?:\/\/[^\s"'<>]+/g, '[页面地址]')
        .replace(/(token|cookie|authorization|enc|stuenc|cpi)\s*[=:]\s*[^\s,;]+/gi, '$1=[隐藏]').slice(0,1200);
}

export async function executeQueue({ items, previous = [], execute, verify, checkpoint, stopped = () => false }) {
    const earlier = new Map(previous.map((item) => [item.key, item]));
    const report = { phase: 'running', startedAt: new Date().toISOString(), items: [] };
    const seen = new Set();
    for (const item of items) {
        if (seen.has(item.key)) continue;
        seen.add(item.key);
        const row = publicItem(item);
        report.items.push(row);
        if (!actionable(item)) { row.status = item.status === 'complete' ? 'already-complete' : 'skipped'; continue; }
        const old = earlier.get(item.key);
        if (old && isUncertainStatus(old.status)) {
            row.status = 'needs-review'; row.reason = '上次执行结果未确认，避免自动重复提交'; continue;
        }
        row.status = 'queued';
    }
    await checkpoint(report);
    for (const row of report.items) {
        if (row.status !== 'queued') continue;
        if (stopped()) { report.phase = 'stopped'; break; }
        const item = items.find((entry) => entry.key === row.key);
        row.status = 'running'; row.startedAt = new Date().toISOString();
        await checkpoint(report);
        // A stop can arrive while the durable checkpoint is being written.
        // Re-check before calling any backend, even if that backend has its own stop guard.
        if (stopped()) {
            row.status = 'interrupted'; row.reason = '已停止，当前任务未启动';
            row.finishedAt = new Date().toISOString(); report.phase = 'stopped';
            await checkpoint(report);
            break;
        }
        try {
            const result = await execute(item);
            if (stopped()) { row.status = 'interrupted'; row.reason = '已停止，需重新检查平台状态'; }
            else if (result?.status === 'blocked' && result.readonlySkip === true) {
                // An explicit read-only policy skip is not a submission or proof of completion.
                // Preserve the conservative status without rescanning the course's full list.
                row.status = 'blocked'; row.reason = result.reason;
            }
            else if (result?.status === 'blocked') {
                // Some document tasks complete merely by opening. Verify, never infer from a missing player.
                const evidence = await verify(item);
                row.status = evidence.complete ? 'complete' : 'blocked';
                row.reason = evidence.complete ? '已重新检查平台完成状态' : result.reason;
            }
            else {
                // A filled form, a clicked button, or a normal return is never proof of completion.
                row.status = 'submitted'; await checkpoint(report);
                if (stopped()) {
                    row.status = 'interrupted'; row.reason = '已停止，提交结果需重新检查平台状态';
                } else {
                    const evidence = await verify(item);
                    row.status = evidence.complete ? 'complete' : 'needs-review';
                    row.reason = evidence.complete ? '已重新检查平台完成状态' : evidence.reason || '平台尚未确认完成，未自动重试';
                }
            }
        } catch (error) {
            row.status = stopped() ? 'interrupted' : 'needs-review';
            row.reason = cleanError(error);
        }
        row.finishedAt = new Date().toISOString();
        await checkpoint(report);
    }
    if (stopped()) report.phase = 'stopped';
    else report.phase = report.items.some((row) => ['needs-review','blocked','skipped'].includes(row.status)) ? 'finished-with-unresolved' : 'finished';
    report.finishedAt = new Date().toISOString();
    await checkpoint(report);
    return report;
}
