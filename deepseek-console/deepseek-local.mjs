import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { requestAnswers } from './deepseek-request.mjs';
import { requestAnswers as requestAnswersByCli, cliExists, CLI_PATH, MODEL, sanitizeUsageMeta } from './wb-cli-request.mjs';
import { validQuestions } from './answer-contract.mjs';

const PORT = 37841;
const scriptPath = fileURLToPath(new URL('./xuexitong-console.js', import.meta.url));
const allowedOrigin = (origin) => /^https:\/\/([a-z0-9-]+\.)*chaoxing\.com$/i.test(origin || '');

async function readApiKey() {
    if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const value = await rl.question('DeepSeek API Key: ');
        rl.close();
        return value.trim();
    }
    process.stdout.write('请粘贴 DeepSeek API Key 后按 Enter（输入不显示）：');
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    return new Promise((resolve, reject) => {
        let value = '';
        const onData = (chunk) => {
            for (const char of chunk) {
                if (char === '\r' || char === '\n') {
                    process.stdin.off('data', onData);
                    process.stdin.setRawMode(false);
                    process.stdout.write('\n');
                    resolve(value.trim());
                    return;
                }
                if (char === '\u0003') {
                    process.stdin.off('data', onData);
                    process.stdin.setRawMode(false);
                    reject(new Error('已取消'));
                    return;
                }
                if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
                else value += char;
            }
        };
        process.stdin.on('data', onData);
    });
}

function send(res, status, data, origin) {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': origin,
        'Vary': 'Origin',
    });
    res.end(JSON.stringify(data));
}

// 工厂导入时不提示 Key、不改脚本、不监听端口，测试可使用独立端口。
export function createAnswerServer({
    provider = 'deepseek', apiKey = '', token = randomBytes(24).toString('hex'), model = MODEL,
    cliRequest = requestAnswersByCli, apiRequest = requestAnswers, fetchImpl = fetch,
} = {}) {
    if (!['deepseek', 'workbuddy-cli'].includes(provider)) throw new Error(`未知的答题来源：${provider}（只能是 deepseek 或 workbuddy-cli）`);
    let busy = false;
    return createServer(async (req, res) => {
    const origin = req.headers.origin;
    if (!allowedOrigin(origin)) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Origin not allowed');
        return;
    }
    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': origin,
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, X-Xuexitong-Token',
            'Access-Control-Allow-Private-Network': 'true',
            'Access-Control-Max-Age': '600',
            'Vary': 'Origin',
        });
        res.end();
        return;
    }
    if (req.headers['x-xuexitong-token'] !== token) {
        send(res, 403, { error: '本地令牌不匹配，请重新复制控制台脚本' }, origin);
        return;
    }
    if (req.method === 'GET' && req.url === '/health') {
        send(res, 200, {
            ok: true, provider, model: provider === 'workbuddy-cli' ? model : 'deepseek-flash',
            protocolVersion: 2, capabilities: ['request-cancel', 'usage-meta'],
        }, origin);
        return;
    }
    if (req.method !== 'POST' || req.url !== '/answer') {
        send(res, 404, { error: '未找到接口' }, origin);
        return;
    }
    if (busy) {
        send(res, 429, { error: '上一批题目仍在处理' }, origin);
        return;
    }
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) {
        send(res, 415, { error: '仅接受 JSON' }, origin);
        return;
    }
    busy = true;
    const controller = new AbortController();
    const cancel = () => controller.abort();
    const onClose = () => { if (!res.writableEnded) cancel(); };
    req.once('aborted', cancel);
    res.once('close', onClose);
    if (req.aborted || res.destroyed) cancel();
    const linkedSignalCleanups = [];
    const cancellableFetch = (url, options = {}) => {
        const signals = [controller.signal, options.signal].filter(Boolean);
        let signal;
        if (typeof AbortSignal.any === 'function') signal = AbortSignal.any(signals);
        else {
            const linked = new AbortController();
            for (const source of signals) {
                const forward = () => linked.abort(source.reason);
                if (source.aborted) forward();
                else {
                    source.addEventListener('abort', forward, { once: true });
                    linkedSignalCleanups.push(() => source.removeEventListener('abort', forward));
                }
            }
            signal = linked.signal;
        }
        return fetchImpl(url, { ...options, signal });
    };
    try {
        const chunks = [];
        let bodyBytes = 0;
        for await (const chunk of req) {
            bodyBytes += chunk.length;
            if (bodyBytes > 9000000) throw new Error('请求内容过大（含图片最多约 9MB）');
            chunks.push(chunk);
        }
        if (controller.signal.aborted) return;
        const questions = JSON.parse(Buffer.concat(chunks).toString('utf8')).questions;
        if (!validQuestions(questions)) throw new Error('题目格式不正确');
        if (provider !== 'workbuddy-cli' && questions.some((q) => q.images?.length || ['填空题', '简答题'].includes(q.type)))
            throw new Error('带图或文字题请使用 WorkBuddy CLI 模式；原 DeepSeek API 方式仍仅支持选择题');
        let meta;
        const answers = provider === 'workbuddy-cli'
            ? await cliRequest(questions, undefined, { signal: controller.signal, onMeta: (value) => { meta = sanitizeUsageMeta(value); } })
            : await apiRequest(questions, apiKey, cancellableFetch);
        if (!controller.signal.aborted) send(res, 200, { answers, ...(meta ? { meta } : {}) }, origin);
    } catch (error) {
        if (!controller.signal.aborted) send(res, 502, { error: error.message }, origin);
    } finally {
        req.off('aborted', cancel);
        res.off('close', onClose);
        for (const cleanup of linkedSignalCleanups) cleanup();
        busy = false;
    }
    });
}

export async function startLocalService() {
    // 默认沿用原 DeepSeek API；--workbuddy-cli 或 ANSWER_PROVIDER 可切换。
    const provider = (process.argv.includes('--workbuddy-cli') ? 'workbuddy-cli' : process.env.ANSWER_PROVIDER || 'deepseek').toLowerCase();
    if (!['deepseek', 'workbuddy-cli'].includes(provider)) throw new Error(`未知的答题来源：${provider}（只能是 deepseek 或 workbuddy-cli）`);
    const apiKey = provider === 'workbuddy-cli' ? '' : await readApiKey();
    if (provider === 'deepseek' && !apiKey) throw new Error('未输入 DeepSeek API Key');
    if (provider === 'workbuddy-cli' && !cliExists()) {
        throw new Error(`找不到 CodeBuddy CLI：${CLI_PATH}。请设置 WB_CLI_PATH 指向已安装的 codebuddy，或去掉 --workbuddy-cli 改用 DeepSeek API Key`);
    }
    const script = readFileSync(scriptPath, 'utf8');
    if (!/const LOCAL_TOKEN = '[^']*';/.test(script)) throw new Error('控制台脚本缺少本地令牌位置');
    const token = randomBytes(24).toString('hex');
    const server = createAnswerServer({ provider, apiKey, token });
    server.listen(PORT, '127.0.0.1', () => {
    writeFileSync(scriptPath, script.replace(/const LOCAL_TOKEN = '[^']*';/, `const LOCAL_TOKEN = '${token}';`), 'utf8');
    console.log(`本地服务已启动：http://127.0.0.1:${PORT}`);
    console.log(provider === 'workbuddy-cli'
        ? `答题来源：workbuddy-cli（${MODEL}，使用本机 CodeBuddy CLI 账号额度，不需要 DeepSeek API Key）`
        : '答题来源：DeepSeek API（需要 API Key）');
    console.log('请复制同目录 xuexitong-console.js 的全部内容，粘贴到学习通页面的 Edge 控制台并按 Enter。');
    console.log(provider === 'workbuddy-cli'
        ? '关闭本窗口即可停止服务；不会读取也不会写入任何 API Key。'
        : '关闭本窗口即可停止服务；API Key 不会写入文件。');
    });
    return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await startLocalService();
