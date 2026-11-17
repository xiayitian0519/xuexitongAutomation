import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startSessionOwner, parseSessionOwnerArgs } from '../automation/session-owner.mjs';
import { dispatchExistingOperation } from '../automation/existing-session.mjs';
import { canonicalRoot, sessionPaths, machineKey, inside, inspectExistingSession, atomicJson,
    readOptionalJson, writeExclusiveJson, publishExclusiveFile, assertPrivatePath } from '../automation/session-protocol.mjs';

// fakeEngine is the only engine passed to initialization. No Edge, browser
// process, real user profile, network endpoint, or model can be reached here.
const base = resolve(import.meta.dirname, '../.tmp'); await mkdir(base, { recursive: true });
const temp = await mkdtemp(join(base, 'session-bootstrap-'));
let groups = 0, fakeLaunches = 0;
const owners = [], ownerFailures = [];
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const test = async (name, fn) => {
    try { await fn(); }
    catch (error) {
        const recentOwners = await Promise.all(owners.slice(-2).map(async owner => ({
            state: owner.descriptor.state,
            completed: await Promise.race([owner.done, Promise.resolve(null)]),
        })));
        console.error(JSON.stringify({ failedTest: name, recentOwners, ownerFailures }));
        throw error;
    }
    groups++; console.log('PASS ' + name);
};
const fresh = async name => {
    const root = join(temp, name); await mkdir(join(root, 'automation'), { recursive: true });
    await mkdir(join(root, '.tmp'), { recursive: true });
    return canonicalRoot(root);
};
function fakeEngine(settings = {}) {
    const calls = [], pages = [{ isClosed: () => false, goto: async value => { calls.push({ goto: value }); } }];
    let connected = true, closeCalls = 0;
    const context = { pages: () => pages, newPage: async () => { throw new Error('UNEXPECTED_NEW_PAGE'); },
        browser: () => ({ isConnected: () => connected }),
        close: async () => { closeCalls++; if (settings.closeFailure) throw new Error('FAKE_CLOSE_FAILURE'); connected = false; } };
    return { engine: { chromium: { launchPersistentContext: async (profile, options) => {
        fakeLaunches++; calls.push({ profile, options }); return context;
    } } }, calls, context, get closeCalls() { return closeCalls; } };
}
async function initialize(root, settings = {}) {
    const fake = fakeEngine(settings), owner = await startSessionOwner({ root, mode: 'initialize', allowNewBrowser: true,
        engine: fake.engine, pollMs: 5, onOwnerError: error => ownerFailures.push({
            ownerFailure: /^[A-Z][A-Z0-9_]{0,200}$/.test(error.message) ? error.message : 'OWNER_IO_FAILURE',
            ioCode: error.code || null, causeCode: error.cause?.code || null,
            causeName: error.cause?.name || null,
        }), ...settings });
    if (owner.stop) owners.push(owner);
    return { fake, owner };
}
async function waitJson(file) {
    for (let i = 0; i < 100; i++) {
        try { return await json(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        await pause(5);
    }
    throw new Error('OFFLINE_RESULT_TIMEOUT');
}
const action = async (root, name, source) => { await writeFile(join(root, '.tmp', name + '.mjs'), source); return '.tmp/' + name + '.mjs'; };

try {
    await test('Windows atomic replacement tolerates a bounded transient sharing violation', async () => {
        const root = await fresh('replace-transient'), file = join(root, 'checkpoint.json');
        await writeFile(file, JSON.stringify({ old: true }));
        let attempts = 0; const delays = [];
        await atomicJson(file, { complete: true }, { platform: 'win32',
            rename: async (source, target) => {
                attempts++; assert.deepEqual(await json(target), { old: true });
                if (attempts <= 7) throw Object.assign(new Error('SYNTHETIC_SHARING_VIOLATION'), { code: 'EPERM' });
                return rename(source, target);
            }, wait: async ms => { delays.push(ms); },
        });
        assert.equal(attempts, 8); assert.deepEqual(delays, [25, 50, 100, 150, 250, 400, 500]);
        assert.deepEqual(await json(file), { complete: true });
    });
    await test('permanent replacement denial stops after the bounded budget and preserves the old checkpoint', async () => {
        const root = await fresh('replace-denied'), file = join(root, 'checkpoint.json');
        await writeFile(file, JSON.stringify({ old: true }));
        const denial = Object.assign(new Error('SYNTHETIC_PERMANENT_DENIAL'), { code: 'EACCES' });
        let attempts = 0; const delays = [];
        await assert.rejects(atomicJson(file, { replacement: true }, { platform: 'win32',
            rename: async () => { attempts++; throw denial; }, wait: async ms => { delays.push(ms); },
        }), error => error === denial);
        assert.equal(attempts, 9); assert.equal(delays.reduce((sum, ms) => sum + ms, 0), 1975);
        assert.deepEqual(await json(file), { old: true });
        assert.equal((await readdir(root)).some(name => name.startsWith('checkpoint.json.') && name.endsWith('.tmp')), false);
    });
    await test('replacement never retries unrelated errors or non-Windows failures', async () => {
        const root = await fresh('replace-no-retry'), file = join(root, 'checkpoint.json');
        for (const [platform, code] of [['win32', 'EIO'], ['linux', 'EPERM']]) {
            let attempts = 0, waits = 0;
            await assert.rejects(atomicJson(file, { replacement: true }, { platform,
                rename: async () => { attempts++; throw Object.assign(new Error('SYNTHETIC_IO_FAILURE'), { code }); },
                wait: async () => { waits++; },
            }), { code });
            assert.equal(attempts, 1); assert.equal(waits, 0);
        }
    });
    await test('exclusive JSON publication never exposes partial bytes to concurrent readers', async () => {
        const root = await fresh('atomic-publication'), file = join(root, 'fixture.json');
        const value = { fixture: 'x'.repeat(4 * 1024 * 1024), complete: true };
        let finished = false, observed = false;
        const writer = writeExclusiveJson(file, value).then(() => { finished = true; });
        while (!finished) {
            const current = await readOptionalJson(file, 'PARTIAL_JSON_OBSERVED');
            if (current) { observed = true; assert.equal(current.fixture.length, value.fixture.length); assert.equal(current.complete, true); }
        }
        await writer; assert.deepEqual(await json(file), value);
        await assert.rejects(writeExclusiveJson(file, { replacement: true }), { code: 'EEXIST' });
        assert.deepEqual(await json(file), value);
        assert.equal((await readdir(root)).some(name => name.endsWith('.pending')), false);
        assert.equal(typeof observed, 'boolean');
    });
    await test('concurrent publishers have one winner and cannot overwrite completed requests', async () => {
        const root = await fresh('exclusive-content'), target = join(root, 'job.action.json');
        const results = await Promise.allSettled(Array.from({ length: 8 }, (_, index) =>
            publishExclusiveFile(root, 'job.action.json', JSON.stringify({ winner: index, complete: true }))));
        assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
        assert.equal(results.filter(result => result.status === 'rejected' && result.reason.code === 'EEXIST').length, 7);
        const value = await json(target); assert.equal(value.complete, true);
        assert.equal((await readdir(root)).filter(name => name.endsWith('.pending')).length, 0);
    });
    await test('removed health files are not mistaken for an outside NTFS tombstone', async () => {
        const root = await fresh('deleted-realpath'), paths = sessionPaths(root), file = join(paths.health, 'fixture.request.json');
        await mkdir(paths.health, { recursive: true }); await writeFile(file, '{}');
        const deleted = join(temp, 'synthetic-deleted-file');
        let injected = false;
        const filesystem = { lstat, realpath: async cursor => {
            if (cursor !== file) return realpath(cursor);
            injected = true; await unlink(file); return deleted;
        } };
        assert.equal(await assertPrivatePath(root, file, filesystem), file);
        assert.equal(injected, true);
        await assert.rejects(readFile(file), { code: 'ENOENT' });
        // An outside resolution while the file still exists remains rejected.
        await writeFile(file, '{}');
        await assert.rejects(assertPrivatePath(root, file, { lstat,
            realpath: async cursor => cursor === file ? deleted : realpath(cursor) }), /REJECTED_REALPATH/);
        // Failure to check absence cannot be treated as confirmed deletion.
        let reads = 0;
        await assert.rejects(assertPrivatePath(root, file, {
            lstat: async cursor => { if (cursor === file && ++reads > 1) throw Object.assign(new Error('denied'), { code: 'EACCES' }); return lstat(cursor); },
            realpath: async cursor => cursor === file ? deleted : realpath(cursor),
        }), { code: 'EACCES' });
    });
    await test('private-state directory junctions remain rejected before reading state', async () => {
        const root = await fresh('private-junction'), outside = join(temp, 'outside-private-state');
        await mkdir(outside);
        await symlink(outside, sessionPaths(root).privateRoot, process.platform === 'win32' ? 'junction' : 'dir');
        await assert.rejects(inspectExistingSession({ root }), /DIRECTORY_REJECTED/);
    });
    await test('default status on fresh project never launches or creates private state', async () => {
        const root = await fresh('status'), fake = fakeEngine();
        assert.deepEqual(await startSessionOwner({ root, engine: fake.engine }), { status: 'uninitialized', backend: 'isolated-edge', launchesBrowser: false });
        assert.equal(fake.calls.length, 0); assert.deepEqual(await readdir(root), ['.tmp', 'automation']);
        assert.deepEqual(parseSessionOwnerArgs([]), { mode: 'status', allowNewBrowser: false });
    });
    await test('initialize and resume require explicit allow flag', async () => {
        const root = await fresh('explicit'), fake = fakeEngine();
        for (const mode of ['initialize', 'resume']) await assert.rejects(startSessionOwner({ root, mode, engine: fake.engine }), /EXPLICIT_NEW_BROWSER_REQUIRED/);
        assert.equal(fake.calls.length, 0);
    });
    await test('first initialize uses only project profile and exact dedicated Edge settings', async () => {
        const root = await fresh('first'), { fake, owner } = await initialize(root), paths = sessionPaths(root);
        assert.equal(owner.status, 'started'); assert.equal(fake.calls.length, 1);
        assert.equal(fake.calls[0].profile, paths.profile);
        assert.deepEqual(fake.calls[0].options, { channel: 'msedge', headless: false, viewport: null });
        assert.equal(owner.session.context, fake.context); assert.equal(owner.session.page, fake.context.pages()[0]);
        assert.equal((await json(paths.descriptor)).state, 'running');
        assert.equal((await json(paths.marker)).machineKey, machineKey());
        await owner.stop();
        assert.equal((await json(paths.descriptor)).state, 'closed'); assert.equal(fake.closeCalls, 1);
    });
    await test('live owner is proved by real nonce handshake and reused before launch', async () => {
        const root = await fresh('reuse'), { owner } = await initialize(root), next = fakeEngine();
        const result = await startSessionOwner({ root, mode: 'initialize', engine: next.engine, healthTimeoutMs: 2000 });
        assert.equal(result.reused, true); assert.equal(result.status, 'connected'); assert.equal(next.calls.length, 0);
        assert.equal((await inspectExistingSession({ root, healthTimeoutMs: 2000 })).status, 'connected');
        await owner.stop();
    });
    await test('completed health nonces remain immutable and every later check uses a fresh challenge', async () => {
        const root = await fresh('retained-health'), { owner } = await initialize(root), paths = sessionPaths(root);
        await inspectExistingSession({ root, healthTimeoutMs: 2000 });
        const before = await readdir(paths.health), oldContents = await Promise.all(before.map(name => readFile(join(paths.health, name), 'utf8')));
        assert.equal(before.filter(name => name.endsWith('.request.json')).length, 1);
        assert.equal(before.filter(name => name.endsWith('.response.json')).length, 1);
        await inspectExistingSession({ root, healthTimeoutMs: 2000 }); await owner.heartbeat();
        assert.equal((await readdir(paths.health)).filter(name => name.endsWith('.request.json')).length, 2);
        assert.deepEqual(await Promise.all(before.map(name => readFile(join(paths.health, name), 'utf8'))), oldContents);
        assert.equal(owner.descriptor.state, 'running'); await owner.stop();
    });
    await test('health challenges keep responding during a long operation', async () => {
        const root = await fresh('long-health'), { owner } = await initialize(root);
        const module = await action(root, 'long', `export default async session=>{session.longStarted=true;await new Promise(r=>{session.releaseLong=r;});return {done:true};};`);
        const job = await dispatchExistingOperation({ root, module, job: 'long', healthTimeoutMs: 2000 });
        while (!owner.session.longStarted) await pause(5);
        assert.equal((await inspectExistingSession({ root, healthTimeoutMs: 1500 })).status, 'connected');
        owner.session.releaseLong(); assert.equal((await waitJson(job.resultFile)).ok, true);
        await owner.stop();
    });
    await test('serialized actions retain sanitized results and stable jobs never repeat', async () => {
        const root = await fresh('jobs'), { owner } = await initialize(root);
        const module = await action(root, 'operation', `export default async session=>{session.runs=(session.runs||0)+1;session.pending=(session.pending||0)+1;session.max=Math.max(session.max||0,session.pending);await new Promise(r=>setTimeout(r,15));session.pending--;return {runs:session.runs,max:session.max,token:'fixture-secret',url:'https://fixture.invalid/p?signature=fixture-secret'};};`);
        const first = await dispatchExistingOperation({ root, module, job: 'first', healthTimeoutMs: 2000 });
        const duplicate = await dispatchExistingOperation({ root, module, job: 'first', healthTimeoutMs: 2000 });
        const second = await dispatchExistingOperation({ root, module, job: 'second', healthTimeoutMs: 2000 });
        assert.equal(duplicate.alreadyDispatched, true);
        const a = await waitJson(first.resultFile), b = await waitJson(second.resultFile);
        assert.equal(a.value.runs, 1); assert.equal(b.value.runs, 2); assert.equal(b.value.max, 1);
        assert.equal(JSON.stringify([a, b]).includes('fixture-secret'), false);
        assert.equal((await json(join(sessionPaths(root).jobs, 'first.state.json'))).status, 'completed');
        await owner.stop();
    });
    await test('started unknown job is never executed again', async () => {
        const root = await fresh('unknown-job'), { owner } = await initialize(root);
        const module = await action(root, 'blocked', `export default async session=>{session.unknownRuns=(session.unknownRuns||0)+1;return {unexpected:true};};`);
        const state = join(sessionPaths(root).jobs, 'uncertain.state.json');
        await atomicJson(state, { version: 1, instance: owner.descriptor.instance, job: 'uncertain', status: 'started' });
        const job = await dispatchExistingOperation({ root, module, job: 'uncertain', healthTimeoutMs: 2000 });
        await owner.pump(); await pause(20);
        assert.equal(owner.session.unknownRuns, undefined);
        await assert.rejects(readFile(job.resultFile), { code: 'ENOENT' });
        assert.equal((await dispatchExistingOperation({ root, module, job: 'uncertain', healthTimeoutMs: 2000 })).alreadyDispatched, true);
        await owner.stop();
    });
    await test('PID alive without nonce response cannot dispatch or start replacement', async () => {
        const root = await fresh('no-health'), { owner } = await initialize(root); await owner.stop();
        const fake = fakeEngine(), module = await action(root, 'inspect', 'export default async()=>({ok:true});');
        await assert.rejects(startSessionOwner({ root, mode: 'initialize', allowNewBrowser: true, engine: fake.engine, healthTimeoutMs: 20 }), /HEALTH_UNAVAILABLE/);
        await assert.rejects(dispatchExistingOperation({ root, module, job: 'blocked', healthTimeoutMs: 20 }), /HEALTH_UNAVAILABLE/);
        assert.equal(fake.calls.length, 0);
        await assert.rejects(readFile(join(sessionPaths(root).jobs, 'blocked.request.json')), { code: 'ENOENT' });
    });
    await test('corrupt descriptor stops without launch or overwrite', async () => {
        const root = await fresh('corrupt'), paths = sessionPaths(root), fake = fakeEngine();
        await mkdir(paths.privateRoot); await writeFile(paths.descriptor, 'broken-json');
        await assert.rejects(startSessionOwner({ root, mode: 'initialize', allowNewBrowser: true, engine: fake.engine }), /DESCRIPTOR_INVALID/);
        assert.equal(await readFile(paths.descriptor, 'utf8'), 'broken-json'); assert.equal(fake.calls.length, 0);
    });
    await test('unknown profile or lock is never silently adopted', async () => {
        for (const name of ['edge-profile', 'unit4-live', 'active.json']) {
            const root = await fresh('unknown-' + name.replace('.', '-')), paths = sessionPaths(root), fake = fakeEngine();
            await mkdir(paths.privateRoot); await mkdir(join(paths.privateRoot, name));
            await assert.rejects(startSessionOwner({ root, mode: 'initialize', allowNewBrowser: true, engine: fake.engine }), /UNKNOWN_OWNER_OR_PROFILE/);
            assert.equal(fake.calls.length, 0);
        }
    });
    await test('cross-machine and cross-root descriptors are not resumed or overwritten', async () => {
        for (const field of ['machineKey', 'root']) {
            const root = await fresh('cross-' + field), { owner } = await initialize(root); await owner.stop();
            const paths = sessionPaths(root), descriptor = await json(paths.descriptor), fake = fakeEngine();
            descriptor[field] = field === 'root' ? join(root, 'other') : 'other-machine'; await atomicJson(paths.descriptor, descriptor);
            const before = await readFile(paths.descriptor, 'utf8');
            await assert.rejects(startSessionOwner({ root, mode: 'resume', allowNewBrowser: true, engine: fake.engine, processState: () => 'dead' }), /DESCRIPTOR_INVALID/);
            assert.equal(await readFile(paths.descriptor, 'utf8'), before); assert.equal(fake.calls.length, 0);
        }
    });
    await test('stale descriptor requires explicit resume and confirmed owner exit', async () => {
        const root = await fresh('stale'), { owner } = await initialize(root); await owner.stop();
        const fake = fakeEngine();
        await assert.rejects(startSessionOwner({ root, mode: 'initialize', allowNewBrowser: true, engine: fake.engine, processState: () => 'dead' }), /REQUIRES_REVIEW/);
        await assert.rejects(startSessionOwner({ root, mode: 'resume', allowNewBrowser: true, engine: fake.engine, processState: () => 'unknown' }), /EXIT_UNCONFIRMED/);
        assert.equal(fake.calls.length, 0);
    });
    await test('explicit resume preserves profile and old owner records without replaying jobs', async () => {
        const root = await fresh('resume'), { owner } = await initialize(root), paths = sessionPaths(root);
        const previousInstance = owner.descriptor.instance;
        await writeFile(join(paths.profile, 'fixture-login-state'), 'synthetic-persistent-state');
        await owner.stop();
        const oldModule = await action(root, 'old-pending', 'export default async session=>{session.replayedOld=true;return {unexpected:true};};');
        const oldRequest = { version: 1, job: 'old-pending', module: join(root, oldModule), resultFile: join(paths.jobs, 'old-pending.json'), root, instance: previousInstance };
        await atomicJson(join(paths.jobs, 'old-pending.request.json'), oldRequest);
        await atomicJson(join(paths.actions, 'old-pending.action.json'), oldRequest);
        const next = fakeEngine();
        const resumed = await startSessionOwner({ root, mode: 'resume', allowNewBrowser: true, engine: next.engine, processState: () => 'dead', pollMs: 5 }); owners.push(resumed);
        assert.notEqual(resumed.descriptor.instance, previousInstance); assert.equal(next.calls.length, 1);
        assert.equal(await readFile(join(paths.profile, 'fixture-login-state'), 'utf8'), 'synthetic-persistent-state');
        assert.equal((await json(join(paths.history, previousInstance, 'descriptor.json'))).instance, previousInstance);
        await resumed.pump(); assert.equal(resumed.session.replayedOld, undefined);
        await resumed.stop();
    });
    await test('cooperative operations receive cancellation before owner shutdown', async () => {
        const root = await fresh('cancel-cooperative'), { owner } = await initialize(root);
        const module = await action(root, 'cooperative', `export default async session=>{session.cancelStarted=true;await new Promise(resolve=>{if(session.signal.aborted)return resolve();session.signal.addEventListener('abort',resolve,{once:true});});session.wasCancelled=session.signal.aborted;return {cancelled:session.wasCancelled};};`);
        const job = await dispatchExistingOperation({ root, module, job: 'cancel', healthTimeoutMs: 2000 });
        while (!owner.session.cancelStarted) await pause(5);
        assert.equal((await owner.stop()).status, 'closed');
        assert.equal(owner.session.wasCancelled, true); assert.equal((await waitJson(job.resultFile)).value.cancelled, true);
    });
    await test('noncooperative operation cannot be reported stopped and remains unconfirmed', async () => {
        const root = await fresh('cancel-noncooperative'), { owner, fake } = await initialize(root, { stopTimeoutMs: 20 });
        const module = await action(root, 'noncooperative', `export default async session=>{session.noncooperativeStarted=true;await new Promise(resolve=>{session.releaseNoncooperative=resolve;});return {finished:true};};`);
        const job = await dispatchExistingOperation({ root, module, job: 'wait', healthTimeoutMs: 2000 });
        while (!owner.session.noncooperativeStarted) await pause(5);
        assert.deepEqual(await owner.stop(), { status: 'stop-unconfirmed', error: 'SESSION_OPERATION_STOP_UNCONFIRMED' });
        assert.equal(fake.closeCalls, 0); assert.equal((await json(sessionPaths(root).descriptor)).state, 'stop-unconfirmed');
        owner.session.releaseNoncooperative(); await waitJson(job.resultFile);
        assert.equal((await owner.done).status, 'closed'); assert.equal(fake.closeCalls, 1);
    });
    await test('resume refuses mismatched profile ownership', async () => {
        const root = await fresh('profile-owner'), { owner } = await initialize(root), paths = sessionPaths(root); await owner.stop();
        const marker = await json(paths.marker); marker.machineKey = 'other-machine'; await atomicJson(paths.marker, marker);
        const fake = fakeEngine();
        await assert.rejects(startSessionOwner({ root, mode: 'resume', allowNewBrowser: true, engine: fake.engine, processState: () => 'dead' }), /IDENTITY_MISMATCH/);
        assert.equal(fake.calls.length, 0);
    });
    await test('close failure records unconfirmed state instead of closed', async () => {
        const root = await fresh('close-failure'), { owner } = await initialize(root, { closeFailure: true });
        assert.equal((await owner.stop()).status, 'close-unconfirmed');
        assert.equal((await json(sessionPaths(root).descriptor)).state, 'close-unconfirmed');
    });
    await test('startup failure after launch closes context and preserves failed ownership evidence', async () => {
        const root = await fresh('start-failure'), fake = fakeEngine();
        await assert.rejects(startSessionOwner({ root, mode: 'initialize', allowNewBrowser: true, engine: fake.engine,
            onReady: async () => { throw new Error('OFFLINE_READY_FAILED'); } }), /OFFLINE_READY_FAILED/);
        assert.equal(fake.closeCalls, 1); assert.equal((await json(sessionPaths(root).descriptor)).state, 'start-failed');
    });
    await test('startup cleanup close failure is explicitly unconfirmed', async () => {
        const root = await fresh('start-close-failure'), fake = fakeEngine({ closeFailure: true });
        await assert.rejects(startSessionOwner({ root, mode: 'initialize', allowNewBrowser: true, engine: fake.engine,
            onReady: async () => { throw new Error('OFFLINE_READY_FAILED'); } }), /OFFLINE_READY_FAILED/);
        assert.equal(fake.closeCalls, 1); assert.equal((await json(sessionPaths(root).descriptor)).state, 'close-unconfirmed');
    });
    await test('initial URL permits only blank and exact official login or homepage', async () => {
        const root = await fresh('initial-url'), fake = fakeEngine();
        for (const initialUrl of ['https://untrusted.invalid/', 'https://i.chaoxing.com/?token=x', 'https://i.chaoxing.com/work', 'file:///tmp/x'])
            await assert.rejects(startSessionOwner({ root, mode: 'initialize', allowNewBrowser: true, engine: fake.engine, initialUrl }), /INITIAL_URL_REJECTED/);
        assert.equal(fake.calls.length, 0);
    });
    await test('module confinement rejects siblings, traversal and outside directory links', async () => {
        const root = await fresh('module-path'), { owner } = await initialize(root), outsideDirectory = join(temp, 'outside-operation');
        await mkdir(outsideDirectory);
        const outside = join(outsideDirectory, 'operation.mjs');
        await writeFile(outside, 'export default async()=>({unexpected:true});');
        for (const module of ['../outside-operation.mjs', outside, join(root + '-sibling', 'automation/x.mjs')])
            await assert.rejects(dispatchExistingOperation({ root, module, job: 'path-' + Math.random().toString(36).slice(2), healthTimeoutMs: 2000 }), /MODULE_REJECTED/);
        const link = join(root, '.tmp', 'outside-link');
        await symlink(outsideDirectory, link, process.platform === 'win32' ? 'junction' : 'dir');
        await assert.rejects(dispatchExistingOperation({ root, module: join(link, 'operation.mjs'), job: 'link', healthTimeoutMs: 2000 }), /MODULE_REJECTED/);
        assert.equal(inside(root, root + '-sibling'), false); assert.equal(inside(root, resolve(root, '..')), false);
        if (process.platform === 'win32') assert.equal(inside(['C', ':', '\\fixture'].join(''), ['D', ':', '\\fixture\\x'].join('')), false);
        await owner.stop();
    });
    await test('legacy owner supports file nonce handshake and is never overwritten', async () => {
        const root = await fresh('legacy'), paths = sessionPaths(root), actions = join(paths.privateRoot, 'unit4-live');
        await mkdir(actions, { recursive: true });
        // The legacy wrapper imports diagnostics from this synthetic project.
        await writeFile(join(root, 'automation/diagnostics.mjs'), `export const sanitizeDiagnostic=value=>value;`);
        const descriptor = { backend: 'isolated-edge', transport: 'existing-action-loop', pid: process.pid, sessionRoot: root, actionDirectory: actions };
        await atomicJson(paths.descriptor, descriptor);
        const before = await readFile(paths.descriptor, 'utf8'), consumed = new Set();
        const browser = { isConnected: () => true };
        const consume = setInterval(async () => {
            for (const name of await readdir(actions)) if (name.endsWith('.action.mjs') && !consumed.has(name)) {
                consumed.add(name); const module = await import(pathToFileURL(join(actions, name)).href); await module.default({ browser, context: {} });
            }
        }, 5);
        try {
            const fake = fakeEngine();
            const reused = await startSessionOwner({ root, mode: 'initialize', allowNewBrowser: true, engine: fake.engine, healthTimeoutMs: 2000 });
            assert.equal(reused.reused, true); assert.equal(fake.calls.length, 0);
            const module = await action(root, 'legacy-inspect', 'export default async()=>({ready:true});');
            const job = await dispatchExistingOperation({ root, module, job: 'legacy', healthTimeoutMs: 2000 });
            assert.equal((await waitJson(job.resultFile)).value.ready, true);
            assert.equal(await readFile(paths.descriptor, 'utf8'), before);
        } finally { clearInterval(consume); }
    });
    await test('parser refuses unknown flags and conflicting modes', async () => {
        for (const args of [['--initialize', '--resume'], ['--desktop'], ['--root'], ['--allow-new-browser', '--allow-new-browser']])
            assert.throws(() => parseSessionOwnerArgs(args), /SESSION_/);
    });
    await test('no owner can silently fail while positive assertions still pass', async () => {
        for (const owner of owners) {
            const result = await owner.stop();
            assert.equal([null, 'SESSION_BROWSER_CLOSE_UNCONFIRMED'].includes(result.error), true);
        }
        assert.deepEqual(ownerFailures, []);
    });
} finally {
    for (const owner of owners) await owner.stop();
    await rm(temp, { recursive: true, force: true });
}
console.log(JSON.stringify({ passed: true, groups, fakeLaunches, newBrowsers: 0, desktopActions: 0, networkRequests: 0, paidCalls: 0 }));
