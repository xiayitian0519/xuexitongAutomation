import { mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { atomicJson, digest } from '../listening/transcript-store.mjs';
import { checkAbort } from './workflow-state.mjs';

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_BYTES = 1100000, MAX_DATA_URL = 1500000, MAX_PIXELS = 16000000;
const MEMORY_ENTRIES = 32, MEMORY_BYTES = 22000000;
const DISK_ENTRIES = 64, DISK_BYTES = 44000000, MAX_RECORD_BYTES = 1600000;
const memory = new Map(), pending = new Map(), diskWrites = new Map();
const signatures = new Set(['enc', 'token', 'sign', 'signature', 'expires', 'expire', 'auth_key']);
const crcTable = Array.from({ length: 256 }, (_, value) => {
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    return value >>> 0;
});
function crc32(bytes) {
    let value = 0xffffffff;
    for (const byte of bytes) value = crcTable[(value ^ byte) & 255] ^ (value >>> 8);
    return (value ^ 0xffffffff) >>> 0;
}

function inspectImages(elements) {
    return elements.map(element => {
        const style = getComputedStyle(element), rect = element.getBoundingClientRect();
        const backgrounds = [];
        let visible = true, stable = true;
        for (let node = element; node; node = node.parentElement) {
            const current = getComputedStyle(node);
            if (node.hidden || current.display === 'none' || /^(hidden|collapse)$/.test(current.visibility) ||
                current.contentVisibility === 'hidden' || current.opacity !== '' && Number(current.opacity) === 0 ||
                /(?:^|\s)opacity\(\s*0(?:\.0+)?%?\s*\)/i.test(current.filter)) visible = false;
            if (node.getAnimations?.().some(animation => animation.pending || animation.playState === 'running')) stable = false;
            backgrounds.push([current.backgroundColor, current.backgroundImage, current.opacity,
                current.filter, current.transform, current.mixBlendMode, current.clipPath,
                current.overflowX, current.overflowY, current.borderRadius]);
        }
        return {
            source: element.currentSrc || element.src,
            loaded: element.complete && element.naturalWidth > 0 && element.naturalHeight > 0,
            supportedPosition: !!element.closest('.mark_name,.reader_answer_tit,.answer_p'),
            visible, stable,
            naturalWidth: element.naturalWidth, naturalHeight: element.naturalHeight,
            width: rect.width, height: rect.height,
            rendering: [style.objectFit, style.objectPosition, style.border, style.borderRadius,
                style.padding, style.boxShadow, style.clipPath, style.visibility, backgrounds],
        };
    });
}

function imageIdentity(image) {
    if (!image?.loaded || !image.supportedPosition || image.visible === false) throw new Error('EXAM_IMAGE_UNREADABLE');
    if (image.stable === false) throw new Error('EXAM_IMAGE_ANIMATING');
    let url;
    try { url = new URL(image.source); } catch { throw new Error('EXAM_IMAGE_ORIGIN_REJECTED'); }
    if (url.protocol !== 'https:' || !/(^|\.)chaoxing\.com$/i.test(url.hostname) || url.username || url.password)
        throw new Error('EXAM_IMAGE_ORIGIN_REJECTED');
    const dimensions = ['naturalWidth', 'naturalHeight', 'width', 'height'].map(field => image[field]);
    const hasDimensions = dimensions.every(value => Number.isFinite(value) && value > 0);
    if (dimensions.some(value => value !== undefined) && !hasDimensions) throw new Error('EXAM_IMAGE_UNREADABLE');
    if (hasDimensions && (image.width > 8192 || image.height > 24000 || image.width * image.height > MAX_PIXELS))
        throw new Error('EXAM_IMAGE_LIMIT');
    // Authentication may rotate without changing this content-addressed original.
    // Transformation/unknown query parameters remain part of the key.
    const query = [...url.searchParams].filter(([key]) => !signatures.has(key.toLowerCase())).sort();
    const rendering = hasDimensions ? dimensions.concat([image.rendering ?? null]) : null;
    const identity = digest({ source: url.href, rendering });
    const immutable = /\/origin\/[a-f0-9]{32}\.(?:png|jpe?g|webp)$/i.test(url.pathname);
    const cacheKey = immutable && hasDimensions ? digest({ version: 1, origin: url.origin,
        path: url.pathname, query, rendering }) : null;
    return { identity, cacheKey, width: image.width, height: image.height };
}

function validatePng(bytes, image) {
    if (!Buffer.isBuffer(bytes) || bytes.length < 45 || !bytes.subarray(0, 8).equals(PNG))
        throw new Error('EXAM_IMAGE_FORMAT_UNSUPPORTED');
    if (bytes.length > MAX_BYTES) throw new Error('EXAM_IMAGE_LIMIT');
    let offset = 8, width = 0, height = 0, hasData = false, ended = false;
    while (offset + 12 <= bytes.length) {
        const length = bytes.readUInt32BE(offset), type = bytes.toString('ascii', offset + 4, offset + 8);
        if (length > bytes.length - offset - 12) throw new Error('EXAM_IMAGE_FORMAT_UNSUPPORTED');
        if (crc32(bytes.subarray(offset + 4, offset + 8 + length)) !== bytes.readUInt32BE(offset + 8 + length))
            throw new Error('EXAM_IMAGE_FORMAT_UNSUPPORTED');
        if (offset === 8) {
            if (type !== 'IHDR' || length !== 13) throw new Error('EXAM_IMAGE_FORMAT_UNSUPPORTED');
            width = bytes.readUInt32BE(offset + 8); height = bytes.readUInt32BE(offset + 12);
            const depth = bytes[offset + 16], color = bytes[offset + 17];
            const depths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
            if (!depths[color]?.includes(depth) || bytes[offset + 18] !== 0 || bytes[offset + 19] !== 0 || bytes[offset + 20] > 1)
                throw new Error('EXAM_IMAGE_FORMAT_UNSUPPORTED');
        } else if (type === 'IHDR') throw new Error('EXAM_IMAGE_FORMAT_UNSUPPORTED');
        if (type === 'IDAT' && length > 0) hasData = true;
        offset += length + 12;
        if (type === 'IEND') { ended = length === 0 && offset === bytes.length; break; }
    }
    if (!width || !height || !hasData || !ended) throw new Error('EXAM_IMAGE_FORMAT_UNSUPPORTED');
    if (width * height > MAX_PIXELS) throw new Error('EXAM_IMAGE_LIMIT');
    if (image.width && (Math.abs(width - image.width) > 2 || Math.abs(height - image.height) > 2))
        throw new Error('EXAM_IMAGE_RENDER_CHANGED');
    return { width, height };
}

function remember(key, bytes) {
    memory.delete(key); memory.set(key, bytes);
    let total = [...memory.values()].reduce((sum, value) => sum + value.length, 0);
    while (memory.size > MEMORY_ENTRIES || total > MEMORY_BYTES) {
        const oldest = memory.keys().next().value;
        total -= memory.get(oldest).length; memory.delete(oldest);
    }
}

async function notify(options, status) {
    // Intentionally contains no source URL, HTML, filesystem path or material.
    try { await options.onEvent?.({ phase: 'image-material', status }); } catch { /* Diagnostic consumers do not own this material. */ }
}

async function diskGet(directory, key, image, options) {
    if (!directory) return null;
    const file = join(directory, key + '.json');
    try {
        if ((await stat(file)).size > MAX_RECORD_BYTES) throw new Error('INVALID_RECORD');
        const row = JSON.parse(await readFile(file, 'utf8'));
        if (row.version !== 1 || row.key !== key || typeof row.base64 !== 'string' ||
            !/^[a-f0-9]{64}$/.test(row.sha256 || '')) throw new Error('INVALID_RECORD');
        const bytes = Buffer.from(row.base64, 'base64');
        if (bytes.toString('base64') !== row.base64 || digest(bytes) !== row.sha256) throw new Error('INVALID_RECORD');
        const dimensions = validatePng(bytes, image);
        if (dimensions.width !== row.width || dimensions.height !== row.height) throw new Error('INVALID_RECORD');
        return bytes;
    } catch (error) {
        if (error.code !== 'ENOENT') await notify(options, 'cache-invalid');
        return null;
    }
}

async function diskPut(directory, key, bytes, image, options) {
    if (!directory) return;
    const scope = resolve(directory), previous = diskWrites.get(scope) || Promise.resolve();
    const current = previous.catch(() => {}).then(() => persist(scope, key, bytes, image, options));
    diskWrites.set(scope, current);
    try { await current; }
    finally { if (diskWrites.get(scope) === current) diskWrites.delete(scope); }
}

async function persist(directory, key, bytes, image, options) {
    const dimensions = validatePng(bytes, image);
    const record = { version: 1, key, sha256: digest(bytes), ...dimensions, base64: bytes.toString('base64') };
    try {
        await mkdir(directory, { recursive: true });
        const names = (await readdir(directory)).filter(name => /^[a-f0-9]{64}\.json$/.test(name));
        const target = key + '.json', total = (await Promise.all(names.map(name => stat(join(directory, name)))))
            .reduce((sum, row) => sum + row.size, 0);
        const existing = names.includes(target) ? (await stat(join(directory, target))).size : 0;
        // Stop persisting new entries at the bound; never delete old private material.
        if ((!existing && names.length >= DISK_ENTRIES) || total - existing + JSON.stringify(record).length > DISK_BYTES) {
            await notify(options, 'cache-capacity'); return;
        }
        await atomicJson(join(directory, target), record);
    } catch { await notify(options, 'cache-write-unavailable'); }
}

function within(promise, milliseconds, signal) {
    checkAbort(signal);
    return new Promise((resolve, reject) => {
        const abort = () => finish(reject, new Error('ABORTED'));
        const timer = setTimeout(() => finish(reject, new Error('EXAM_IMAGE_CAPTURE_TIMEOUT')), milliseconds);
        function finish(callback, value) {
            clearTimeout(timer); signal?.removeEventListener('abort', abort); callback(value);
        }
        signal?.addEventListener('abort', abort, { once: true });
        promise.then(value => finish(resolve, value), error => finish(reject, error));
        if (signal?.aborted) abort();
    });
}

/** Read only the existing page's rendered image elements; never fetch signed URLs. */
export async function readExamCardImages(page, qid, signal, options = {}) {
    checkAbort(signal);
    if (!/^[a-z0-9_-]+$/i.test(qid || '')) throw new Error('EXAM_IMAGE_CARD_INVALID');
    if (options.cacheDirectory !== undefined && (typeof options.cacheDirectory !== 'string' || !options.cacheDirectory.trim()) ||
        ['screenshotTimeoutMs', 'cardTimeoutMs'].some(key => options[key] !== undefined && (!Number.isFinite(options[key]) || options[key] <= 0)))
        throw new Error('EXAM_IMAGE_CONFIGURATION_INVALID');
    const locator = page.locator('.singleQuesId[data=' + JSON.stringify(qid) + '] img[src]');
    const images = await locator.evaluateAll(inspectImages);
    if (images.length > 4) throw new Error('EXAM_IMAGE_LIMIT');
    const identities = images.map(imageIdentity), output = [];
    const started = performance.now();
    const cardTimeout = Math.min(30000, Math.max(100, options.cardTimeoutMs ?? 15000));
    for (const [index, image] of identities.entries()) {
        checkAbort(signal);
        let bytes = image.cacheKey && memory.get(image.cacheKey);
        if (bytes) { validatePng(bytes, image); remember(image.cacheKey, bytes); await notify(options, 'memory-hit'); }
        if (!bytes && image.cacheKey) {
            bytes = await diskGet(options.cacheDirectory, image.cacheKey, image, options);
            if (bytes) { checkAbort(signal); remember(image.cacheKey, bytes); await notify(options, 'disk-hit'); }
        }
        if (!bytes) {
            const remaining = cardTimeout - (performance.now() - started);
            if (remaining <= 0) throw new Error('EXAM_IMAGE_CAPTURE_TIMEOUT');
            const timeout = Math.min(10000, Math.max(1, options.screenshotTimeoutMs ?? 5000), remaining);
            let capture = image.cacheKey && pending.get(image.cacheKey);
            if (capture) await notify(options, 'capture-shared');
            else {
                capture = (async () => {
                    let captured;
                    try {
                        // Do not fast-forward CSS animations for the screenshot. A
                        // finite animation can otherwise paint a temporary final
                        // state and restore it before the post-capture check.
                        captured = await within(locator.nth(index).screenshot({ type: 'png', animations: 'allow',
                            caret: 'hide', scale: 'css', timeout }), timeout, signal);
                    } catch (error) {
                        if (signal?.aborted || error.message === 'ABORTED') throw new Error('ABORTED');
                        if (error.name === 'TimeoutError' || error.message === 'EXAM_IMAGE_CAPTURE_TIMEOUT')
                            throw new Error('EXAM_IMAGE_CAPTURE_TIMEOUT');
                        throw new Error('EXAM_IMAGE_CAPTURE_FAILED');
                    }
                    checkAbort(signal);
                    validatePng(captured, image);
                    const current = await locator.evaluateAll(inspectImages);
                    if (current.length !== identities.length || imageIdentity(current[index]).identity !== image.identity)
                        throw new Error('EXAM_IMAGE_CHANGED_DURING_CAPTURE');
                    if (image.cacheKey) {
                        await diskPut(options.cacheDirectory, image.cacheKey, captured, image, options);
                        checkAbort(signal); remember(image.cacheKey, captured);
                    }
                    await notify(options, 'captured');
                    return captured;
                })();
                if (image.cacheKey) {
                    pending.set(image.cacheKey, capture);
                    const release = () => { if (pending.get(image.cacheKey) === capture) pending.delete(image.cacheKey); };
                    capture.then(release, release);
                }
            }
            bytes = await within(capture, timeout, signal);
        }
        checkAbort(signal);
        const data = 'data:image/png;base64,' + bytes.toString('base64');
        if (data.length > MAX_DATA_URL) throw new Error('EXAM_IMAGE_LIMIT');
        output.push(data);
    }
    checkAbort(signal);
    const current = await locator.evaluateAll(inspectImages);
    if (current.length !== identities.length || current.some((row, index) => imageIdentity(row).identity !== identities[index].identity))
        throw new Error('EXAM_IMAGE_CHANGED_DURING_CAPTURE');
    return output;
}
