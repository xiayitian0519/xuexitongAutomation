import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, rename, unlink, open } from 'node:fs/promises';
import { join, dirname } from 'node:path';

export const digest = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
export async function atomicJson(file, value, options = {}) {
    await mkdir(dirname(file), { recursive: true });
    const temporary = file + '.' + randomUUID() + '.tmp';
    try {
        await writeFile(temporary, JSON.stringify(value, null, 2), { flag: 'wx' });
        // Windows scanners/indexers can hold a newly published file beyond
        // 375ms under parallel IO load. Retry only known sharing/permission
        // errors, for at most 1.975s of waiting; never unlink the old checkpoint.
        const delays = [25, 50, 100, 150, 250, 400, 500, 500];
        const replace = options.rename || rename;
        const wait = options.wait || (ms => new Promise(resolve => setTimeout(resolve, ms)));
        const platform = options.platform || process.platform;
        for (let attempt = 0; ; attempt++) {
            try { await replace(temporary, file); break; }
            catch (error) {
                if (platform !== 'win32' || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || attempt >= delays.length) throw error;
                await wait(delays[attempt]);
            }
        }
    } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
export async function optionalJson(file) {
    try { return JSON.parse(await readFile(file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw new Error('CHECKPOINT_CORRUPT'); }
}
export async function withFileLock(file, fn) {
    await mkdir(dirname(file), { recursive: true });
    let handle;
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            handle = await open(file, 'wx');
            await handle.writeFile(JSON.stringify({ pid: process.pid, token: randomUUID() }));
            break;
        } catch (error) {
            if (error.code !== 'EEXIST') throw error;
            if (attempt || !await recoverDeadLock(file)) throw new Error('CHECKPOINT_BUSY');
        }
    }
    try { return await fn(); }
    finally { await handle.close(); await unlink(file); }
}

async function recoverDeadLock(file) {
    let recovery;
    try { recovery = await open(file + '.recovery', 'wx'); }
    catch (error) { if (error.code === 'EEXIST') return false; throw error; }
    try {
        const raw = await readFile(file, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
        if (raw === null) return true;
        let owner;
        try { owner = JSON.parse(raw); } catch { throw new Error('LOCK_OWNER_UNREADABLE'); }
        if (!Number.isSafeInteger(owner?.pid) || owner.pid <= 0) throw new Error('LOCK_OWNER_INVALID');
        try { process.kill(owner.pid, 0); return false; }
        catch (error) { if (error.code !== 'ESRCH') return false; }
        if (await readFile(file, 'utf8') !== raw) return false;
        // Preserve the dead owner's record; never reclaim a live or ambiguous lock.
        await rename(file, file + '.abandoned-' + randomUUID() + '.json');
        return true;
    } finally { await recovery.close(); await unlink(file + '.recovery'); }
}

export function transcriptStore(directory, key) {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('INVALID_CACHE_KEY');
    const base = join(directory, key), stateFile = join(base, 'checkpoint.json');
    return {
        lock: fn => withFileLock(join(base, 'writer.lock'), fn),
        async load() {
            const state = await optionalJson(stateFile);
            if (state && (state.version !== 1 || state.key !== key || !Array.isArray(state.repairs))) throw new Error('CHECKPOINT_CORRUPT');
            return state || { version: 1, key, raw: null, final: null, repairs: [] };
        },
        async save(state) { await atomicJson(stateFile, state); },
        async put(kind, value) {
            const file = kind + '-' + randomUUID() + '.json', sha256 = digest(value);
            await atomicJson(join(base, file), value);
            return { file, sha256 };
        },
        async get(ref) {
            if (!ref || !/^(raw|repair|final|quality)-[a-f0-9-]+\.json$/.test(ref.file) || !/^[a-f0-9]{64}$/.test(ref.sha256)) throw new Error('CACHE_REFERENCE_INVALID');
            const value = await optionalJson(join(base, ref.file));
            if (!value || digest(value) !== ref.sha256) throw new Error('CACHE_CONTENT_INVALID');
            return value;
        },
    };
}
