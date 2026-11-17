import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { link, lstat, mkdir, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { atomicJson } from '../listening/transcript-store.mjs';

export const SESSION_TRANSPORT = 'project-action-loop-v1';
export const PROJECT_ROOT = resolve(import.meta.dirname, '..');
export const machineKey = () => createHash('sha256').update(process.platform + '\n' + hostname().toLowerCase()).digest('hex');
export const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
export const inside = (root, path) => { const part = relative(root, path); return part !== '' && !isAbsolute(part) && !part.startsWith('..' + sep) && part !== '..'; };
export function sessionPaths(root) {
    const privateRoot = join(root, '.automation.local'), base = join(privateRoot, 'browser-session');
    return { root, privateRoot, base, descriptor: join(privateRoot, 'existing-browser.json'),
        actions: join(base, 'actions'), health: join(base, 'health'), profile: join(base, 'profile'),
        marker: join(base, 'profile-identity.json'), ownerLock: join(base, 'owner.lock.json'),
        heartbeat: join(base, 'heartbeat.json'), jobs: join(privateRoot, 'session-jobs'), history: join(base, 'history') };
}
export async function readOptionalJson(file, code = 'EXISTING_SESSION_DESCRIPTOR_INVALID') {
    try { return JSON.parse(await readFile(file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw new Error(code, { cause: error }); }
}
export async function pathExists(file) { try { await lstat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
export async function canonicalRoot(root = PROJECT_ROOT) { return realpath(resolve(root)); }

// Every existing ancestor must be a physical directory/file, never a junction
// into a different profile or project. The project root itself is canonicalized.
export async function assertPrivatePath(root, path, filesystem = { lstat, realpath }) {
    const target = resolve(path), privateRoot = join(root, '.automation.local');
    if (!samePath(target, privateRoot) && !inside(privateRoot, target)) throw new Error('EXISTING_SESSION_DIRECTORY_REJECTED_LEXICAL');
    const parts = relative(root, target).split(sep);
    let cursor = root;
    for (const part of parts) {
        cursor = join(cursor, part);
        try {
            const info = await filesystem.lstat(cursor);
            const actual = await filesystem.realpath(cursor);
            // Windows can resolve a hard-linked regular file through its other
            // in-directory name. Confinement, rather than path-string equality,
            // is required after atomic hard-link publication.
            if (info.isSymbolicLink()) throw new Error('EXISTING_SESSION_DIRECTORY_REJECTED_SYMLINK');
            if (!samePath(actual, privateRoot) && !inside(privateRoot, actual)) {
                // A peer can remove a completed health challenge after lstat.
                // On Windows, realpath may then return an NTFS deleted-file
                // tombstone instead of ENOENT. Accept only confirmed absence;
                // an existing outside path or junction still fails closed.
                await filesystem.lstat(cursor);
                throw new Error('EXISTING_SESSION_DIRECTORY_REJECTED_REALPATH');
            }
        } catch (error) { if (error.code === 'ENOENT') break; throw error; }
    }
    return target;
}
export async function ensurePrivateDirectory(root, directory) {
    await assertPrivatePath(root, directory); await mkdir(directory, { recursive: true });
    await assertPrivatePath(root, directory);
}
export async function safeOperationModule(root, input) {
    if (typeof input !== 'string' || !input) throw new Error('EXISTING_SESSION_MODULE_REJECTED');
    const requested = resolve(root, input), part = relative(root, requested).split(sep)[0];
    if (!inside(root, requested) || !['automation', '.tmp'].includes(part)) throw new Error('EXISTING_SESSION_MODULE_REJECTED');
    let actual;
    try { actual = await realpath(requested); } catch { throw new Error('EXISTING_SESSION_MODULE_REJECTED'); }
    if (!inside(root, actual) || !['automation', '.tmp'].includes(relative(root, actual).split(sep)[0]) || !(await lstat(actual)).isFile())
        throw new Error('EXISTING_SESSION_MODULE_REJECTED');
    return actual;
}
export function validateDescriptor(descriptor, root, key = machineKey()) {
    if (!descriptor || descriptor.backend !== 'isolated-edge' || !Number.isSafeInteger(descriptor.pid) || descriptor.pid < 1)
        throw new Error('EXISTING_SESSION_DESCRIPTOR_INVALID');
    if (descriptor.transport === 'existing-action-loop') {
        if (typeof descriptor.sessionRoot !== 'string' || typeof descriptor.actionDirectory !== 'string' ||
            !samePath(resolve(descriptor.actionDirectory), join(resolve(descriptor.sessionRoot), '.automation.local', 'unit4-live')))
            throw new Error('EXISTING_SESSION_DIRECTORY_REJECTED');
        return 'legacy';
    }
    const paths = sessionPaths(root);
    if (descriptor.version !== 1 || descriptor.transport !== SESSION_TRANSPORT ||
        !/^[a-f0-9-]{36}$/i.test(descriptor.instance || '') || !Number.isFinite(Date.parse(descriptor.createdAt)) ||
        typeof descriptor.root !== 'string' || !samePath(resolve(descriptor.root), root) || descriptor.machineKey !== key ||
        descriptor.sessionRoot !== descriptor.root || descriptor.actionDirectory !== paths.actions || descriptor.profileDirectory !== paths.profile)
        throw new Error('EXISTING_SESSION_DESCRIPTOR_INVALID');
    return 'project';
}
export async function readSessionDescriptor(root, key = machineKey()) {
    const paths = sessionPaths(root); await assertPrivatePath(root, paths.descriptor);
    const descriptor = await readOptionalJson(paths.descriptor);
    if (!descriptor) return null;
    const protocol = validateDescriptor(descriptor, root, key);
    if (protocol === 'project') {
        await assertPrivatePath(root, paths.actions); await assertPrivatePath(root, paths.profile);
    } else {
        const legacyRoot = await realpath(resolve(descriptor.sessionRoot)).catch(() => { throw new Error('EXISTING_SESSION_DIRECTORY_REJECTED'); });
        if (!samePath(legacyRoot, resolve(descriptor.sessionRoot))) throw new Error('EXISTING_SESSION_DIRECTORY_REJECTED');
        await assertPrivatePath(legacyRoot, descriptor.actionDirectory);
    }
    return { descriptor, protocol, paths };
}
export function processStatus(pid, options = {}) {
    if (options.processState) return options.processState(pid);
    try {
        const result = (options.isAlive || (id => process.kill(id, 0)))(pid);
        return result === false ? 'dead' : 'alive';
    } catch (error) { return error.code === 'ESRCH' ? 'dead' : 'unknown'; }
}
export const validateJobId = job => {
    if (typeof job !== 'string' || !/^[a-z0-9][a-z0-9-]{0,127}$/.test(job)) throw new Error('INVALID_JOB_ID');
    return job;
};
async function publishCompleteExclusive(file, content) {
    const pending = file + '.' + randomUUID() + '.pending';
    try {
        await writeFile(pending, content, { flag: 'wx' });
        // A direct wx write exposes an empty/partial JSON file before close.
        // Linking the fully closed sibling publishes all bytes atomically and
        // fails with EEXIST rather than replacing a previous request or result.
        await link(pending, file);
    } finally {
        await unlink(pending).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
}
export async function writeExclusiveJson(file, value) { await publishCompleteExclusive(file, JSON.stringify(value)); }
export async function publishExclusiveFile(directory, name, content) { await publishCompleteExclusive(join(directory, name), content); }
export async function requestHealth(root, descriptor, options = {}) {
    if (options.healthCheck) {
        if (await options.healthCheck(descriptor) !== true) throw new Error('EXISTING_SESSION_HEALTH_UNAVAILABLE');
        return { healthy: true, protocol: descriptor.transport };
    }
    const paths = sessionPaths(root), nonce = randomUUID(), started = Date.now();
    await ensurePrivateDirectory(root, paths.health);
    const requestFile = join(paths.health, nonce + '.request.json'), resultFile = join(paths.health, nonce + '.response.json');
    const request = { version: 1, nonce, instance: descriptor.instance || null, requestedAt: new Date(started).toISOString() };
    await writeExclusiveJson(requestFile, request);
    if (descriptor.transport === 'existing-action-loop') {
        const action = `import {writeExclusiveJson} from ${JSON.stringify(import.meta.url)};\nexport default async function(session){const connected=!!session.browser?.isConnected?.()&&!!session.context;await writeExclusiveJson(${JSON.stringify(resultFile)},{nonce:${JSON.stringify(nonce)},pid:${descriptor.pid},healthy:connected,at:new Date().toISOString()});return {health:connected};}\n`;
        await publishExclusiveFile(descriptor.actionDirectory, '800-project-health-' + nonce + '.action.mjs', action);
    }
    const timeoutMs = options.healthTimeoutMs ?? 3000;
    // Keep completed nonce records under private state. Deleting here races
    // the owner's directory scan/read on NTFS (EPERM or deleted-file paths).
    // Unique nonces and freshness checks prevent replay of retained records.
    while (Date.now() - started < timeoutMs) {
        const response = await readOptionalJson(resultFile, 'EXISTING_SESSION_HEALTH_INVALID');
        if (response) {
            if (response.nonce !== nonce || response.pid !== descriptor.pid || response.healthy !== true ||
                !Number.isFinite(Date.parse(response.at)) || Date.parse(response.at) < started - 1000 ||
                descriptor.transport === SESSION_TRANSPORT && (response.instance !== descriptor.instance || response.root !== root || response.machineKey !== descriptor.machineKey))
                throw new Error('EXISTING_SESSION_HEALTH_INVALID');
            return { healthy: true, protocol: descriptor.transport };
        }
        await new Promise(resolve => setTimeout(resolve, Math.min(25, timeoutMs)));
    }
    throw new Error('EXISTING_SESSION_HEALTH_UNAVAILABLE');
}
export async function inspectExistingSession(options = {}) {
    const root = await canonicalRoot(options.root), loaded = await readSessionDescriptor(root, options.machineKey || machineKey());
    if (!loaded) return { status: 'uninitialized', backend: 'isolated-edge', launchesBrowser: false };
    if (processStatus(loaded.descriptor.pid, options) !== 'alive') throw new Error('EXISTING_SESSION_PROCESS_UNAVAILABLE');
    await requestHealth(root, loaded.descriptor, options);
    return { status: 'connected', backend: 'isolated-edge', protocol: loaded.descriptor.transport,
        instance: loaded.descriptor.instance || null, launchesBrowser: false };
}
export { atomicJson };
