// Explicit materialization of exported practice audio. No cookies, login, uploads or playback.
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { resolve, dirname, relative, isAbsolute, join, extname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { validateManifest } from './contracts.mjs';
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MAX_BYTES = 30 * 1024 * 1024;
const allowedSuffixes = ['chaoxing.com'];
const mimeExtensions = new Map([['audio/mpeg', '.mp3'], ['audio/mp3', '.mp3'], ['audio/wav', '.wav'],
    ['audio/x-wav', '.wav'], ['audio/mp4', '.m4a'], ['audio/x-m4a', '.m4a'], ['audio/ogg', '.ogg'],
    ['audio/flac', '.flac'], ['audio/x-flac', '.flac'], ['audio/webm', '.webm']]);

export function validateAudioUrl(value, extraHosts = []) {
    let url;
    try { url = new URL(value); } catch { throw new Error('音频源 URL 无效'); }
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') ||
        !(allowedSuffixes.some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`)) ||
          extraHosts.includes(url.hostname))) throw new Error('音频源未在允许的 HTTPS 域名内；额外 CDN 需明确指定 --audio-host');
    return url;
}

export async function fetchPracticeAudio(manifest, destination, options = {}) {
    const planned = { ...manifest, audio: manifest?.audio?.map(audio => ({ ...audio, path: `${audio.id}.wav` })) };
    validateManifest(planned);
    const urls = manifest.audio.map(audio => validateAudioUrl(audio.sourceUrl, options.extraHosts));
    const target = resolve(destination);
    // Runtime artifacts belong to the private or temporary project directories.
    if (!['.tmp', '.automation.local'].some(name => {
        const rel = relative(join(ROOT, name), target);
        return rel && !rel.startsWith('..') && !isAbsolute(rel);
    })) throw new Error('下载目录须位于项目 .tmp 或 .automation.local 内');
    await mkdir(dirname(target), { recursive: true });
    await mkdir(target); // Never reuse or overwrite an existing materialization.
    try {
        const audio = [];
        for (let index = 0; index < urls.length; index++) {
            if (options.signal?.aborted) throw new Error('音频下载已取消');
            const timeout = AbortSignal.timeout(options.timeoutMs || 45000);
            const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
            const response = await (options.fetchImpl || fetch)(urls[index], { redirect: 'manual', credentials: 'omit', signal });
            if (!response.ok || response.status >= 300 || !response.body) throw new Error('音频下载失败或需要登录/跳转；未尝试绕过');
            const mime = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
            let extension = mimeExtensions.get(mime);
            if (!extension && mime === 'application/octet-stream' && /\.(?:mp3|m4a|wav|ogg|flac|webm)$/i.test(urls[index].pathname))
                extension = extname(urls[index].pathname).toLowerCase();
            if (!extension) throw new Error('音频响应类型未识别，拒绝把网页或错误页送去转写');
            if (Number(response.headers.get('content-length')) > MAX_BYTES) throw new Error('音频超过 30 MiB');
            let bytes = 0;
            const chunks = [], reader = response.body.getReader();
            try {
                while (true) {
                    const row = await reader.read();
                    if (row.done) break;
                    bytes += row.value.length;
                    if (bytes > MAX_BYTES) throw new Error('音频超过 30 MiB');
                    chunks.push(Buffer.from(row.value));
                }
            } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
            if (!bytes) throw new Error('音频内容为空');
            const file = `${manifest.audio[index].id}${extension}`;
            await writeFile(join(target, file), Buffer.concat(chunks), { flag: 'wx' });
            audio.push({ id: manifest.audio[index].id, questionIds: manifest.audio[index].questionIds, path: file,
                ...(manifest.audio[index].expectations ? { expectations: manifest.audio[index].expectations } : {}) });
        }
        const local = { schemaVersion: 1, purpose: 'listening-practice', questions: manifest.questions, audio, unresolved: [] };
        await writeFile(join(target, 'practice.json'), JSON.stringify(local, null, 2), { flag: 'wx' });
        return local;
    } catch (error) {
        // This is a fresh directory created by this function, inside an approved runtime root.
        await rm(target, { recursive: true, force: true });
        // Native fetch errors can include signed URLs; expose only known fixed messages.
        const known = /^(?:音频|下载)/.test(error.message || '');
        throw new Error(known ? error.message : '音频下载未完成，已清理本次临时文件');
    }
}

async function main() {
    const args = process.argv.slice(2), extraHosts = [];
    let manifest, destination;
    for (let i = 0; i < args.length; i++) {
        if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error('参数值缺失');
        if (args[i] === '--manifest') manifest = args[++i];
        else if (args[i] === '--destination') destination = args[++i];
        else if (args[i] === '--audio-host' && /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i.test(args[i + 1])) extraHosts.push(args[++i].toLowerCase());
        else throw new Error('使用 --manifest 导出.json --destination .tmp/听力练习 [--audio-host CDN域名]');
    }
    if (!manifest || !destination) throw new Error('必须指定 --manifest 和 --destination');
    const local = await fetchPracticeAudio(JSON.parse(await readFile(resolve(manifest), 'utf8')), destination, { extraHosts });
    console.log(JSON.stringify({ phase: 'audio-saved', audioCount: local.audio.length, questionCount: local.questions.length }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
    main().catch(error => { console.error(error.message); process.exitCode = 1; });
