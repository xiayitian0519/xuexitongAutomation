import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sanitizeDiagnostic } from './diagnostics.mjs';
import { SESSION_TRANSPORT, PROJECT_ROOT, machineKey, sessionPaths, canonicalRoot, assertPrivatePath,
    ensurePrivateDirectory, safeOperationModule, readSessionDescriptor, readOptionalJson, pathExists,
    processStatus, inspectExistingSession, validateJobId, writeExclusiveJson, atomicJson } from './session-protocol.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const safeError = error => /^[A-Z][A-Z0-9_: -]{0,200}$/.test(error?.message || '') ? error.message :
    ['ENOENT', 'EEXIST', 'EPERM', 'EACCES', 'EBUSY', 'EIO'].includes(error?.code) ? 'SESSION_IO_' + error.code : 'SESSION_OPERATION_FAILED';
function initialLocation(value = 'about:blank') {
    if (value === 'about:blank') return value;
    let url;
    try { url = new URL(value); } catch { throw new Error('SESSION_INITIAL_URL_REJECTED'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
        !['https://i.chaoxing.com/', 'https://passport2.chaoxing.com/login'].includes(url.href))
        throw new Error('SESSION_INITIAL_URL_REJECTED');
    return url.href;
}
async function assertNoOtherOwners(root, paths) {
    // Existing profiles or legacy owner artifacts cannot be adopted as a first run.
    for (const name of ['edge-profile', 'active.json', 'unit4-live', 'browser-owner.json'])
        if (await pathExists(join(paths.privateRoot, name))) throw new Error('SESSION_UNKNOWN_OWNER_OR_PROFILE');
    if (await pathExists(paths.base)) {
        await assertPrivatePath(root, paths.base);
        if ((await readdir(paths.base)).length) throw new Error('SESSION_UNKNOWN_OWNER_OR_PROFILE');
    }
}
function owns(record, descriptor) {
    return record?.version === 1 && record.instance === descriptor.instance && record.pid === descriptor.pid &&
        record.root === descriptor.root && record.machineKey === descriptor.machineKey;
}
async function verifyOwnership(paths, descriptor) {
    await assertPrivatePath(paths.root, paths.ownerLock); await assertPrivatePath(paths.root, paths.marker);
    const lock = await readOptionalJson(paths.ownerLock, 'SESSION_OWNER_LOCK_INVALID');
    const marker = await readOptionalJson(paths.marker, 'SESSION_PROFILE_IDENTITY_INVALID');
    if (!owns(lock, descriptor) || marker?.version !== 1 || marker.root !== descriptor.root ||
        marker.machineKey !== descriptor.machineKey || marker.profileDirectory !== paths.profile)
        throw new Error('SESSION_OWNER_IDENTITY_MISMATCH');
}

export async function startSessionOwner(options = {}) {
    const root = await canonicalRoot(options.root || PROJECT_ROOT), paths = sessionPaths(root);
    const key = options.machineKey || machineKey(), mode = options.mode || 'status';
    if (!['status', 'initialize', 'resume'].includes(mode)) throw new Error('SESSION_MODE_INVALID');
    if (mode === 'status') return inspectExistingSession({ ...options, root, machineKey: key });
    if (options.signal?.aborted) throw new Error('ABORTED');
    const location = initialLocation(options.initialUrl), existing = await readSessionDescriptor(root, key);
    if (existing) {
        if (processStatus(existing.descriptor.pid, options) === 'alive') {
            // A live descriptor always wins over initialize/resume flags.
            return { ...await inspectExistingSession({ ...options, root, machineKey: key }), reused: true };
        }
        if (options.allowNewBrowser !== true) throw new Error('SESSION_EXPLICIT_NEW_BROWSER_REQUIRED');
        if (mode !== 'resume' || existing.protocol !== 'project') throw new Error('SESSION_EXISTING_OWNER_REQUIRES_REVIEW');
        if (processStatus(existing.descriptor.pid, options) !== 'dead') throw new Error('SESSION_OWNER_EXIT_UNCONFIRMED');
        await verifyOwnership(paths, existing.descriptor);
        if (!await pathExists(paths.profile)) throw new Error('SESSION_PROFILE_MISSING');
    } else {
        if (options.allowNewBrowser !== true) throw new Error('SESSION_EXPLICIT_NEW_BROWSER_REQUIRED');
        if (mode !== 'initialize') throw new Error('SESSION_NOT_INITIALIZED');
        await assertNoOtherOwners(root, paths);
    }
    await ensurePrivateDirectory(root, paths.privateRoot);
    await ensurePrivateDirectory(root, paths.base);
    // One startup owner at a time, including the gap before the descriptor exists.
    const startupLock = join(paths.base, 'startup.lock.json');
    try { await writeExclusiveJson(startupLock, { pid: process.pid, at: new Date().toISOString() }); }
    catch (error) { if (error.code === 'EEXIST') throw new Error('SESSION_STARTUP_BUSY'); throw error; }
    // Keep startup lock as a durable ownership artifact. A crash needs explicit review.
    const instance = randomUUID(), createdAt = new Date().toISOString();
    const descriptor = { version: 1, backend: 'isolated-edge', transport: SESSION_TRANSPORT,
        pid: options.pid || process.pid, instance, root, sessionRoot: root, machineKey: key,
        actionDirectory: paths.actions, profileDirectory: paths.profile, createdAt, state: 'starting' };
    let launchedContext = null, healthTimer = null, actionTimer = null, ownerRunning = false, operationController = null, abortListener = null;
    try {
        if (existing) {
            // Archive, never delete, the old owner state. The old profile stays in place.
            await ensurePrivateDirectory(root, paths.history);
            const history = join(paths.history, existing.descriptor.instance);
            await mkdir(history, { recursive: false });
            await writeExclusiveJson(join(history, 'descriptor.json'), existing.descriptor);
            await rename(paths.ownerLock, join(history, 'owner.lock.json'));
            if (await pathExists(paths.heartbeat)) await rename(paths.heartbeat, join(history, 'heartbeat.json'));
        }
        await writeExclusiveJson(paths.ownerLock, { version: 1, instance, root, machineKey: key, pid: descriptor.pid, createdAt });
        if (!existing) await writeExclusiveJson(paths.marker, { version: 1, root, machineKey: key, profileDirectory: paths.profile, createdAt });
        await atomicJson(paths.descriptor, descriptor);
        for (const directory of [paths.actions, paths.health, paths.jobs, paths.profile]) await ensurePrivateDirectory(root, directory);
        const engine = options.engine || await (await import('./browser-driver.mjs')).loadBrowserEngine();
        const context = launchedContext = await engine.chromium.launchPersistentContext(paths.profile, {
            channel: 'msedge', headless: false, viewport: null,
        });
        const browser = context.browser();
        if (!browser?.isConnected?.()) throw new Error('SESSION_BROWSER_UNAVAILABLE');
        let activePage = context.pages()[0] || await context.newPage();
        if (!existing && location !== 'about:blank') await activePage.goto(location, { waitUntil: 'domcontentloaded', timeout: 15000 });
        operationController = new AbortController();
        const session = { browser, context, descriptor, signal: operationController.signal };
        Object.defineProperties(session, {
            page: { enumerable: true, get: () => !activePage?.isClosed?.() ? activePage : context.pages().find(page => !page.isClosed?.()) || null,
                set: page => { if (!context.pages().includes(page)) throw new Error('SESSION_PAGE_REJECTED'); activePage = page; } },
            pages: { enumerable: true, get: () => context.pages() },
        });
        descriptor.state = 'running'; await atomicJson(paths.descriptor, descriptor);
        let stopping = false, operationBusy = false, heartbeatBusy = false, fatal = null, resolveDone, lastHeartbeatAt = 0;
        const completedHealth = new Set();
        const done = new Promise(resolve => { resolveDone = resolve; });
        const heartbeat = async () => {
            if (heartbeatBusy || stopping) return;
            heartbeatBusy = true;
            try {
                await verifyOwnership(paths, descriptor);
                const connected = browser.isConnected();
                for (const name of (await readdir(paths.health)).filter(name => /^[a-f0-9-]{36}\.request\.json$/.test(name))) {
                    if (completedHealth.has(name)) continue;
                    const requestFile = join(paths.health, name); await assertPrivatePath(root, requestFile);
                    const request = await readOptionalJson(requestFile, 'SESSION_HEALTH_REQUEST_INVALID');
                    const resultFile = join(paths.health, name.replace('.request.json', '.response.json'));
                    await assertPrivatePath(root, resultFile);
                    if (!request || request.version !== 1 || request.instance !== instance ||
                        request.nonce !== name.slice(0, -'.request.json'.length)) continue;
                    if (await pathExists(resultFile)) { completedHealth.add(name); continue; }
                    await writeExclusiveJson(resultFile, { nonce: request.nonce, instance, pid: descriptor.pid, root,
                        machineKey: key, at: new Date().toISOString(), healthy: connected });
                    completedHealth.add(name);
                }
                // Health challenges keep the normal polling cadence. The
                // informational heartbeat is persisted at most once a second,
                // reducing atomic-replace contention from constant polling.
                if (Date.now() - lastHeartbeatAt >= 1000) {
                    await assertPrivatePath(root, paths.heartbeat);
                    await atomicJson(paths.heartbeat, { version: 1, instance, root, machineKey: key, pid: descriptor.pid,
                        at: new Date().toISOString(), healthy: connected });
                    lastHeartbeatAt = Date.now();
                }
            } finally { heartbeatBusy = false; }
        };
        const pump = async () => {
            if (operationBusy || stopping) return;
            operationBusy = true;
            try {
                if (!browser.isConnected()) throw new Error('EXISTING_BROWSER_DISCONNECTED');
                for (const name of (await readdir(paths.actions)).filter(name => /^[a-z0-9][a-z0-9-]{0,127}\.action\.json$/.test(name)).sort()) {
                    if (stopping) break;
                    const actionFile = join(paths.actions, name); await assertPrivatePath(root, actionFile);
                    const action = await readOptionalJson(actionFile, 'SESSION_ACTION_INVALID');
                    if (action?.instance !== instance) continue; // Resume never replays the old owner's pending work.
                    const job = validateJobId(action.job), requestFile = join(paths.jobs, job + '.request.json');
                    await assertPrivatePath(root, requestFile);
                    const request = await readOptionalJson(requestFile, 'SESSION_ACTION_INVALID');
                    if (action.version !== 1 || name !== job + '.action.json' || !request || JSON.stringify(request) !== JSON.stringify(action) ||
                        action.root !== root || action.resultFile !== join(paths.jobs, job + '.json')) throw new Error('SESSION_ACTION_INVALID');
                    const stateFile = join(paths.jobs, job + '.state.json');
                    await assertPrivatePath(root, stateFile);
                    const previous = await readOptionalJson(stateFile, 'SESSION_JOB_STATE_INVALID');
                    if (previous) continue; // started is unknown; completed is durable. Neither is replayed.
                    const module = await safeOperationModule(root, action.module);
                    if (module !== action.module) throw new Error('EXISTING_SESSION_MODULE_REJECTED');
                    await writeExclusiveJson(stateFile, { version: 1, instance, job, status: 'started', at: new Date().toISOString() });
                    let result;
                    try {
                        const operation = await import(pathToFileURL(module).href + '?session-job=' + job);
                        if (typeof operation.default !== 'function') throw new Error('SESSION_OPERATION_INVALID');
                        result = { ok: true, at: new Date().toISOString(), value: sanitizeDiagnostic(await operation.default(session)) };
                    } catch (error) { result = { ok: false, at: new Date().toISOString(), error: safeError(error) }; }
                    await assertPrivatePath(root, action.resultFile);
                    await writeExclusiveJson(action.resultFile, result);
                    await atomicJson(stateFile, { version: 1, instance, job, status: 'completed', ok: result.ok, at: new Date().toISOString() });
                }
            } finally { operationBusy = false; }
        };
        let cleanup = null;
        const stop = async () => {
            if (!stopping) {
                stopping = true; operationController.abort(); clearInterval(healthTimer); clearInterval(actionTimer);
                options.signal?.removeEventListener('abort', abort);
                cleanup = (async () => {
                    while (operationBusy || heartbeatBusy) await pause(10);
                    let closeError = null;
                    try { await context.close(); } catch { closeError = 'SESSION_BROWSER_CLOSE_UNCONFIRMED'; }
                    descriptor.state = closeError ? 'close-unconfirmed' : 'closed';
                    descriptor.stoppedAt = new Date().toISOString();
                    await atomicJson(paths.descriptor, descriptor);
                    await atomicJson(paths.heartbeat, { version: 1, instance, root, machineKey: key, pid: descriptor.pid,
                        at: descriptor.stoppedAt, healthy: false, state: descriptor.state });
                    resolveDone({ status: descriptor.state, error: closeError || fatal });
                    return done;
                })();
            }
            const timeout = options.stopTimeoutMs ?? 5000;
            let timer;
            const pending = await Promise.race([cleanup, new Promise(resolve => { timer = setTimeout(() => resolve(null), timeout); })]);
            clearTimeout(timer);
            if (pending) return pending;
            descriptor.state = 'stop-unconfirmed';
            await atomicJson(paths.descriptor, descriptor);
            return { status: 'stop-unconfirmed', error: 'SESSION_OPERATION_STOP_UNCONFIRMED' };
        };
        const failOwner = error => { options.onOwnerError?.(error); fatal = safeError(error); stop().catch(() => { resolveDone({ status: 'close-unconfirmed', error: 'SESSION_SHUTDOWN_FAILED' }); }); };
        healthTimer = setInterval(() => { heartbeat().catch(failOwner); }, options.pollMs || 100);
        actionTimer = setInterval(() => { pump().catch(failOwner); }, options.pollMs || 100);
        const abort = () => { stop().catch(failOwner); };
        abortListener = abort;
        options.signal?.addEventListener('abort', abort, { once: true });
        await heartbeat();
        // Startup ownership is archived after a running owner/descriptor exists.
        await rename(startupLock, join(paths.base, 'startup-' + instance + '.json'));
        // Operations must pass session.signal to runExam/fetch/model calls so
        // Ctrl+C prevents later paid requests or submit actions during shutdown.
        const owner = { status: 'started', descriptor, session, done, stop, pump, heartbeat, launchesBrowser: true };
        await options.onReady?.(owner);
        ownerRunning = true;
        return owner;
    } catch (error) {
        // A failed start leaves its descriptor/lock/profile for explicit review.
        clearInterval(healthTimer); clearInterval(actionTimer);
        operationController?.abort();
        if (abortListener) options.signal?.removeEventListener('abort', abortListener);
        let closed = true;
        if (launchedContext && !ownerRunning) { try { await launchedContext.close(); } catch { closed = false; } }
        descriptor.state = closed ? 'start-failed' : 'close-unconfirmed'; descriptor.failure = safeError(error);
        if (await pathExists(paths.descriptor)) await atomicJson(paths.descriptor, descriptor);
        throw error;
    }
}

export function parseSessionOwnerArgs(args) {
    const options = { mode: 'status', allowNewBrowser: false }; let selected = false;
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (['--status', '--initialize', '--resume'].includes(arg)) {
            if (selected) throw new Error('SESSION_MODE_INVALID'); selected = true; options.mode = arg.slice(2);
        } else if (arg === '--allow-new-browser') {
            if (options.allowNewBrowser) throw new Error('SESSION_ARGUMENT_INVALID'); options.allowNewBrowser = true;
        } else if (arg === '--root' || arg === '--initial-url') {
            const value = args[++i]; if (!value || value.startsWith('--')) throw new Error('SESSION_ARGUMENT_INVALID');
            options[arg === '--root' ? 'root' : 'initialUrl'] = value;
        } else throw new Error('SESSION_ARGUMENT_INVALID');
    }
    return options;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    const controller = new AbortController();
    process.once('SIGINT', () => controller.abort()); process.once('SIGTERM', () => controller.abort());
    try {
        const owner = await startSessionOwner({ ...parseSessionOwnerArgs(process.argv.slice(2)), signal: controller.signal });
        console.log(JSON.stringify({ status: owner.status, reused: owner.reused || false,
            backend: 'isolated-edge', launchesBrowser: owner.launchesBrowser === true }));
        if (owner.done) { const stopped = await owner.done; if (stopped.error) { console.error(stopped.error); process.exitCode = 1; } }
    } catch (error) { console.error(safeError(error)); process.exitCode = 1; }
}
