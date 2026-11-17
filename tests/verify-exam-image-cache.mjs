import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { JSDOM } from 'jsdom';
import { readExamCardImages } from '../automation/exam-image-materials.mjs';

const temporaryRoot = new URL('../.tmp/', import.meta.url);
await mkdir(temporaryRoot, { recursive: true });
const directory = await mkdtemp(join(fileURLToPath(temporaryRoot), 'image-cache-test-'));
const crcTable = Array.from({ length: 256 }, (_, value) => {
    for (let i = 0; i < 8; i++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    return value >>> 0;
});
function crc32(bytes) {
    let value = 0xffffffff;
    for (const byte of bytes) value = crcTable[(value ^ byte) & 255] ^ (value >>> 8);
    return (value ^ 0xffffffff) >>> 0;
}
function chunk(type, bytes) {
    const head = Buffer.alloc(8), tail = Buffer.alloc(4);
    head.writeUInt32BE(bytes.length); head.write(type, 4);
    tail.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type), bytes])));
    return Buffer.concat([head, bytes, tail]);
}
function png(width = 1, height = 1) {
    const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4);
    header[8] = 8; header[9] = 6;
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
        chunk('IDAT', deflateSync(Buffer.alloc((width * 4 + 1) * height))), chunk('IEND', Buffer.alloc(0))]);
}
let nextImage = 1, tested = 0;
const row = (extra = {}) => ({ source: 'https://p.chaoxing.com/origin/' + (nextImage++).toString(16).padStart(32, '0') + '.png?enc=private',
    loaded: true, supportedPosition: true, naturalWidth: 1, naturalHeight: 1, width: 1, height: 1, rendering: ['contain'], ...extra });
function page(rows, behavior = {}) {
    const target = { calls: 0, rows, locator(selector) {
        assert.match(selector, /^\.singleQuesId\[data="[a-z0-9_-]+"\] img\[src\]$/i);
        return { evaluateAll: async () => target.rows.map(value => ({ ...value })), nth: index => ({ screenshot: async options => {
            target.calls++; assert.equal(options.scale, 'css'); assert.equal(options.animations, 'allow'); assert.ok(options.timeout <= 10000);
            return behavior.capture ? behavior.capture(target, index) : png(target.rows[index].width, target.rows[index].height);
        } }) };
    } };
    return target;
}
function domPage(depth = 0) {
    const image = row(), dom = new JSDOM('<div class="singleQuesId" data="card"><div class="reader_answer_tit">' +
        '<div>'.repeat(depth) + '<img>' + '</div>'.repeat(depth) + '</div></div>',
    { url: 'https://fixture.chaoxing.com', runScripts: 'outside-only' });
    const element = dom.window.document.querySelector('img'); element.src = image.source;
    for (const [name, value] of Object.entries({ complete: true, naturalWidth: 1, naturalHeight: 1 }))
        Object.defineProperty(element, name, { get: () => value });
    element.getBoundingClientRect = () => ({ width: 1, height: 1 });
    const target = { calls: 0, locator(selector) { return {
        evaluateAll: async fn => dom.window.eval('(' + fn.toString() + ')')([...dom.window.document.querySelectorAll(selector)]),
        nth: () => ({ screenshot: async options => {
            assert.equal(options.animations, 'allow'); target.calls++; return png();
        } }),
    }; } };
    return { dom, element, target };
}
async function test(name, operation) { await operation(); tested++; console.log('✓ ' + name); }
const loadFresh = async name => (await import('../automation/exam-image-materials.mjs?' + name)).readExamCardImages;

await test('cold capture / warm memory / rotated signature / new page share one capture', async () => {
    const image = row(), first = page([image]);
    const expected = await readExamCardImages(first, 'card');
    assert.equal(first.calls, 1);
    assert.deepEqual(await readExamCardImages(first, 'card'), expected); assert.equal(first.calls, 1);
    const refreshed = page([{ ...image, source: image.source.replace('private', 'renewed') }]);
    assert.deepEqual(await readExamCardImages(refreshed, 'card'), expected); assert.equal(refreshed.calls, 0);
});
await test('persistent cache works after module/process state reset without URL disclosure', async () => {
    const image = row(), cacheDirectory = join(directory, 'persistent'), first = page([image]);
    await readExamCardImages(first, 'card', undefined, { cacheDirectory });
    const names = await readdir(cacheDirectory); assert.equal(names.length, 1); assert.match(names[0], /^[a-f0-9]{64}\.json$/);
    const raw = await readFile(join(cacheDirectory, names[0]), 'utf8');
    assert.doesNotMatch(raw, /https|chaoxing|private|origin/);
    const fresh = await loadFresh('persistent'), afterRestart = page([image]);
    const events = []; await fresh(afterRestart, 'card', undefined, { cacheDirectory, onEvent: event => events.push(event) });
    assert.equal(afterRestart.calls, 0); assert.ok(events.some(event => event.status === 'disk-hit'));
});
await test('truncated / tampered cache is safely reconstructed', async () => {
    const image = row(), cacheDirectory = join(directory, 'corrupt');
    await readExamCardImages(page([image]), 'card', undefined, { cacheDirectory });
    const [name] = await readdir(cacheDirectory); await writeFile(join(cacheDirectory, name), '{broken');
    const fresh = await loadFresh('corrupt'), second = page([image]), events = [];
    await fresh(second, 'card', undefined, { cacheDirectory, onEvent: event => events.push(event) });
    assert.equal(second.calls, 1); assert.ok(events.some(event => event.status === 'cache-invalid'));
    const saved = JSON.parse(await readFile(join(cacheDirectory, name), 'utf8')); saved.base64 = png(2, 1).toString('base64');
    await writeFile(join(cacheDirectory, name), JSON.stringify(saved));
    const again = await loadFresh('corrupt-sha'), third = page([image]);
    await again(third, 'card', undefined, { cacheDirectory }); assert.equal(third.calls, 1);
});
await test('source content, dimensions, render styles and transformation query invalidate cache', async () => {
    const image = row(), first = page([image]); await readExamCardImages(first, 'card');
    for (const changed of [row(), { ...image, width: 2 }, { ...image, rendering: ['cover'] },
        { ...image, source: image.source + '&width=250' }]) {
        const changedPage = page([changed]); await readExamCardImages(changedPage, 'card'); assert.equal(changedPage.calls, 1);
    }
});
await test('non-content-addressed sources are captured afresh', async () => {
    const target = page([row({ source: 'https://p.chaoxing.com/dynamic.png?enc=private' })]);
    await readExamCardImages(target, 'card'); await readExamCardImages(target, 'card'); assert.equal(target.calls, 2);
});
await test('two callers share in-flight capture', async () => {
    const image = row(); let release;
    const block = new Promise(resolve => { release = resolve; });
    const first = page([image], { capture: async () => { await block; return png(); } }), second = page([image]);
    const a = readExamCardImages(first, 'card'), b = readExamCardImages(second, 'card');
    setTimeout(release, 5); assert.deepEqual(await a, await b); assert.equal(first.calls + second.calls, 1);
});
await test('pre-abort and abort during capture never populate cache', async () => {
    const image = row(), before = new AbortController(), first = page([image]); before.abort();
    await assert.rejects(readExamCardImages(first, 'card', before.signal), /ABORTED/); assert.equal(first.calls, 0);
    const during = new AbortController(), stalled = page([image], { capture: async () => {
        during.abort(); return png();
    } });
    await assert.rejects(readExamCardImages(stalled, 'card', during.signal), /ABORTED/);
    const later = page([image]); await readExamCardImages(later, 'card'); assert.equal(later.calls, 1);
});
await test('capture timeout is bounded, not retried, and later recovery is possible', async () => {
    const image = row(), stalled = page([image], { capture: () => new Promise(() => {}) });
    const start = performance.now();
    await assert.rejects(readExamCardImages(stalled, 'card', undefined, { screenshotTimeoutMs: 20 }), /EXAM_IMAGE_CAPTURE_TIMEOUT/);
    assert.ok(performance.now() - start < 1000); assert.equal(stalled.calls, 1);
    const recovered = page([image]); await readExamCardImages(recovered, 'card'); assert.equal(recovered.calls, 1);
});
await test('browser timeout and exceptions only expose safe error codes', async () => {
    const timeout = new Error('signed URL private'); timeout.name = 'TimeoutError';
    await assert.rejects(readExamCardImages(page([row()], { capture: async () => { throw timeout; } }), 'card'),
        error => error.message === 'EXAM_IMAGE_CAPTURE_TIMEOUT');
    await assert.rejects(readExamCardImages(page([row()], { capture: async () => { throw new Error('private HTML'); } }), 'card'),
        error => error.message === 'EXAM_IMAGE_CAPTURE_FAILED');
});
await test('PNG signature, chunk CRC, truncation, dimensions and payload bound reject', async () => {
    const invalidCrc = png(); invalidCrc[invalidCrc.length - 1] ^= 1;
    for (const bytes of [Buffer.from('html'), png().subarray(0, 40), invalidCrc])
        await assert.rejects(readExamCardImages(page([row()], { capture: async () => bytes }), 'card'), /FORMAT_UNSUPPORTED/);
    await assert.rejects(readExamCardImages(page([row()], { capture: async () => png(8, 1) }), 'card'), /RENDER_CHANGED/);
    await assert.rejects(readExamCardImages(page([row()], { capture: async () => Buffer.alloc(1100001, 0) }), 'card'), /FORMAT_UNSUPPORTED|IMAGE_LIMIT/);
});
await test('invalid source, location, readiness, size and image count fail before capture', async () => {
    for (const image of [row({ loaded: false }), row({ supportedPosition: false }), row({ source: 'https://evil.invalid/image.png' }),
        row({ source: 'https://user:password@p.chaoxing.com/x.png' }), row({ width: 0 }), row({ width: 9000 })]) {
        const target = page([image]); await assert.rejects(readExamCardImages(target, 'card'), /UNREADABLE|ORIGIN_REJECTED|IMAGE_LIMIT/);
        assert.equal(target.calls, 0);
    }
    await assert.rejects(readExamCardImages(page(Array.from({ length: 5 }, () => row())), 'card'), /IMAGE_LIMIT/);
});
await test('DOM material mutation during capture rejects and leaves no cached success', async () => {
    const image = row(), changing = page([image], { capture: async target => {
        target.rows[0] = { ...image, rendering: ['changed'] }; return png();
    } });
    await assert.rejects(readExamCardImages(changing, 'card'), /CHANGED_DURING_CAPTURE/);
    const restored = page([image]); await readExamCardImages(restored, 'card'); assert.equal(restored.calls, 1);
});
await test('memory LRU is bounded while disk budget stops safely without deletion', async () => {
    const image = row(), original = page([image]); await readExamCardImages(original, 'card');
    for (let i = 0; i < 33; i++) await readExamCardImages(page([row()]), 'card');
    const again = page([image]); await readExamCardImages(again, 'card'); assert.equal(again.calls, 1);
    const cacheDirectory = join(directory, 'capacity'); await mkdir(cacheDirectory);
    for (let i = 0; i < 64; i++) await writeFile(join(cacheDirectory, i.toString(16).padStart(64, '0') + '.json'), '{}');
    const events = []; await readExamCardImages(page([row()]), 'card', undefined, { cacheDirectory, onEvent: event => events.push(event) });
    assert.equal((await readdir(cacheDirectory)).length, 64); assert.ok(events.some(event => event.status === 'cache-capacity'));
});
await test('diagnostic consumer failure does not lose valid material', async () => {
    const result = await readExamCardImages(page([row()]), 'card', undefined, { onEvent: () => { throw new Error('consumer'); } });
    assert.equal(result.length, 1);
});
await test('old fake metadata without render dimensions remains uncached and readable', async () => {
    const image = row(); for (const key of ['width', 'height', 'naturalWidth', 'naturalHeight', 'rendering']) delete image[key];
    const target = page([image], { capture: async () => png() });
    await readExamCardImages(target, 'card'); await readExamCardImages(target, 'card'); assert.equal(target.calls, 2);
});
await test('actual DOM inspection supports subquestion title images and notices style changes', async () => {
    const { dom, element, target } = domPage();
    try {
        await readExamCardImages(target, 'card'); await readExamCardImages(target, 'card'); assert.equal(target.calls, 1);
        element.style.objectFit = 'cover'; await readExamCardImages(target, 'card'); assert.equal(target.calls, 2);
        element.closest('.reader_answer_tit').className = 'unknown';
        await assert.rejects(readExamCardImages(target, 'card'), /UNREADABLE/);
    } finally { dom.window.close(); }
});
await test('hidden visibility and zero opacity on any ancestor reject before cache use', async () => {
    const { dom, element, target } = domPage(14), ancestor = element.closest('.singleQuesId');
    try {
        await readExamCardImages(target, 'card'); assert.equal(target.calls, 1);
        for (const [node, property, value] of [
            [element, 'visibility', 'hidden'], [ancestor, 'visibility', 'hidden'],
            [ancestor, 'opacity', '0'], [ancestor, 'display', 'none'],
            [ancestor, 'contentVisibility', 'hidden'], [ancestor, 'filter', 'opacity(0)'],
        ]) {
            node.style[property] = value;
            await assert.rejects(readExamCardImages(target, 'card'), /EXAM_IMAGE_UNREADABLE/);
            node.style[property] = '';
        }
        ancestor.hidden = true; await assert.rejects(readExamCardImages(target, 'card'), /EXAM_IMAGE_UNREADABLE/);
        assert.equal(target.calls, 1);
    } finally { dom.window.close(); }
});
await test('running or pending element and ancestor animations reject before capture', async () => {
    const { dom, element, target } = domPage(), ancestor = element.closest('.singleQuesId');
    try {
        for (const [node, state] of [[element, { playState: 'running' }], [ancestor, { playState: 'paused', pending: true }]]) {
            node.getAnimations = () => [state];
            await assert.rejects(readExamCardImages(target, 'card'), /EXAM_IMAGE_ANIMATING/);
            delete node.getAnimations;
        }
        assert.equal(target.calls, 0);
    } finally { dom.window.close(); }
});
await test('stable paused or finished animations are not fast-forwarded by capture', async () => {
    const { dom, element, target } = domPage();
    try {
        element.getAnimations = () => [{ playState: 'paused', pending: false }, { playState: 'finished', pending: false }];
        await readExamCardImages(target, 'card'); await readExamCardImages(target, 'card'); assert.equal(target.calls, 1);
        element.getAnimations = () => [{ playState: 'running' }];
        await assert.rejects(readExamCardImages(target, 'card'), /EXAM_IMAGE_ANIMATING/); assert.equal(target.calls, 1);
    } finally { dom.window.close(); }
});
await test('animation beginning during capture rejects rather than storing a temporary frame', async () => {
    const image = row(), target = page([image], { capture: async current => {
        current.rows[0] = { ...image, stable: false }; return png();
    } });
    await assert.rejects(readExamCardImages(target, 'card'), /EXAM_IMAGE_ANIMATING/);
    const retry = page([image]); await readExamCardImages(retry, 'card'); assert.equal(retry.calls, 1);
});
console.log('PASS ' + tested + ' image cache groups; no browser creation, network or model calls');
