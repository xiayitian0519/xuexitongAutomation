export function checkAbort(signal) { if (signal?.aborted) throw new Error('ABORTED'); }
export function delay(ms, signal) {
    checkAbort(signal);
    return new Promise((resolve, reject) => {
        const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(new Error('ABORTED')); };
        const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
    });
}
export async function until(read, accept, { timeoutMs = 5000, intervalMs = 100, signal } = {}) {
    const start = performance.now();
    do {
        checkAbort(signal);
        const result = await read();
        if (accept(result)) return result;
        await delay(Math.min(intervalMs, Math.max(0, timeoutMs - (performance.now() - start))), signal);
    } while (performance.now() - start < timeoutMs);
    throw new Error('STATE_OBSERVATION_TIMEOUT');
}
