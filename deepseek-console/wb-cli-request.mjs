/**
 * workbuddy-cli 调用方式（可选，与 deepseek-request.mjs 并列，不改动它）
 *
 * 用途：不填 DeepSeek API Key，改用本机已登录的 CodeBuddy CLI 走 DeepSeek，
 *       消耗你自己的账号额度。
 *
 * 已验证（2026-11-16，CLI 2.184.0，deepseek-v4.1-flash）：
 *   1. 必须用最小环境变量启动，否则已登录也会报 Authentication required
 *   2. --json-schema 必须配 --tools "StructuredOutput"，只放开这一个工具
 *   3. schema 只保证格式不保证正确，业务校验必须自己做
 *
 * 与 requestAnswers(questions, apiKey, fetchImpl) 保持同签名，
 * 第二个参数只是为了能直接替换 import，内部不使用。
 * deps.runner 仅测试用，注入假执行器即可全离线验证，不消耗额度。
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ANSWER_SCHEMA, TEXT_INSTRUCTIONS, validQuestions, isTextQuestion, validateAnswers as validateMixedAnswers } from './answer-contract.mjs';

const DEFAULT_CLI = fileURLToPath(new URL('../.tmp/cbcli/node_modules/@tencent-ai/codebuddy-code/bin/codebuddy', import.meta.url));
const DEFAULT_MODEL = 'deepseek-v4.1-flash';
const DEFAULT_TIMEOUT_MS = 180000;
const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

export const CLI_PATH = process.env.WB_CLI_PATH || DEFAULT_CLI;
export const MODEL = process.env.WB_MODEL || DEFAULT_MODEL;

// 只保留系统必需变量。客户端注入的 CODEBUDDY_* / CLAUDE_* / gateway / MCP 配置
// 会把鉴权上下文带到 WorkBuddy 客户端那份上去，导致已登录仍报 Authentication required。
const ENV_WHITELIST = [
    'HOME', 'USERPROFILE', 'PATH', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP',
    'SYSTEMROOT', 'SYSTEMDRIVE', 'COMSPEC', 'PATHEXT', 'PROGRAMDATA', 'PROGRAMFILES',
    'USERNAME', 'USERDOMAIN', 'HOMEDRIVE', 'HOMEPATH', 'NUMBER_OF_PROCESSORS',
    'OS', 'PROCESSOR_ARCHITECTURE', 'LANG', 'LC_ALL',
];

function cleanEnv() {
    const env = {};
    for (const key of ENV_WHITELIST) if (process.env[key] !== undefined) env[key] = process.env[key];
    return env;
}

const SYSTEM_PROMPT = '按题意回答全部题目。注意：题干或选项可能经过网页防复制处理，出现个别汉字被替换、插入无关字，或词语看起来不通顺。先结合上下文和选项在内部还原最可能的原句，再按还原后的题意作答；不要把明显异常的替换字当作专业术语，也不要因无法逐字还原而放弃。每题都必须给非空答案，只用该题提供的选项字母且不可重复；单选和判断选一个，多选列出所有正确项。不确定时选最可能的答案。id须对应题号。';

const SCHEMA = JSON.stringify({
    type: 'object',
    properties: {
        answers: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    id: { type: 'integer' },
                    letters: { type: 'array', items: { type: 'string' } },
                },
                required: ['id', 'letters'],
                additionalProperties: false,
            },
        },
    },
    required: ['answers'],
    additionalProperties: false,
});

export function cliExists() {
    return existsSync(CLI_PATH);
}

function cancelledError() {
    const error = new Error('模型请求已取消');
    error.name = 'AbortError';
    error.code = 'ABORT_ERR';
    return error;
}

export function sanitizeUsageMeta(meta) {
    const model = typeof meta?.model === 'string' && /^[a-z0-9][a-z0-9._:/-]{0,127}$/i.test(meta.model)
        ? meta.model : null;
    const credit = typeof meta?.credit === 'number' && Number.isFinite(meta.credit) && meta.credit >= 0
        ? Number(meta.credit.toFixed(4)) : null;
    return { model, credit };
}

// 等 close 再完成：取消后先确认子进程已退出，服务才能接收下一批题。
export function runCli(args, timeoutMs, stdinText, options = {}) {
    return new Promise((resolve) => {
        const { signal, cliPath = CLI_PATH } = options;
        const maxOutputBytes = Number.isSafeInteger(options.maxOutputBytes) && options.maxOutputBytes > 0
            ? options.maxOutputBytes : DEFAULT_MAX_OUTPUT_BYTES;
        if (signal?.aborted) return resolve({ error: 'aborted' });
        let child;
        try {
            child = spawn(process.execPath, [cliPath, ...args], { env: cleanEnv(), windowsHide: true });
        } catch (error) {
            return resolve({ error: 'spawn-failed', detail: error.message });
        }
        const stdout = [], stderr = [];
        let outputBytes = 0, stopReason = null, settled = false, killTimer;
        const finish = (result) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            clearTimeout(killTimer);
            signal?.removeEventListener('abort', onAbort);
            // Partial output is private recovery evidence as well. A timeout or
            // nonzero exit never becomes a safe-to-repeat request just because
            // its process did not return a usable answer.
            const captured = Buffer.concat(stdout).toString('utf8').trim();
            resolve({ ...(result.error ? { partialStdout: captured } : { stdout: captured }),
                stderr: Buffer.concat(stderr).toString('utf8').trim(), ...result });
        };
        const stop = (reason) => {
            if (settled || stopReason) return;
            stopReason = reason;
            child.kill();
            killTimer = setTimeout(() => child.kill('SIGKILL'), 1000);
            killTimer.unref();
        };
        const onAbort = () => stop({ error: 'aborted' });
        const timer = setTimeout(() => {
            stop({ error: 'timeout', detail: `${Math.round(timeoutMs / 1000)} 秒` });
        }, timeoutMs);
        const collect = (target, chunk) => {
            if (stopReason) return;
            outputBytes += chunk.length;
            if (outputBytes > maxOutputBytes) {
                stop({ error: 'output-limit', detail: String(maxOutputBytes) });
                return;
            }
            target.push(chunk);
        };
        child.stdout.on('data', (chunk) => collect(stdout, chunk));
        child.stderr.on('data', (chunk) => collect(stderr, chunk));
        child.stdin.on('error', () => {});
        child.stdin.end(stdinText || undefined);
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) onAbort();
        child.on('error', (error) => {
            finish(stopReason || { error: 'spawn-failed', detail: error.message });
        });
        child.on('close', (code, exitSignal) => {
            if (stopReason) return finish(stopReason);
            if (code !== 0) return finish({ error: 'exit-code', exitCode: code, detail: code === null ? `信号 ${exitSignal || '未知'}` : `退出码 ${code}` });
            finish({ stdout: Buffer.concat(stdout).toString('utf8').trim(), stderr: Buffer.concat(stderr).toString('utf8').trim(), exitCode: code });
        });
    });
}

function responseError(message, code) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function readUsage(parsed) {
    const items = Array.isArray(parsed) ? parsed : [parsed];
    let model = null;
    const credits = [];
    for (const item of items) {
        const meta = item && item.providerData;
        if (!meta || typeof meta !== 'object') continue;
        if (typeof meta.model === 'string') model = meta.model;
        const credit = meta.rawUsage && meta.rawUsage.credit;
        if (typeof credit === 'number' && Number.isFinite(credit) && credit >= 0) credits.push(credit);
    }
    return sanitizeUsageMeta({ model, credit: credits.length ? credits.reduce((a, b) => a + b, 0) : null });
}

/** Private receipt only: never log or include this object in public reports. */
export function createCliReceipt(raw = {}) {
    const stdout = typeof raw.stdout === 'string' ? raw.stdout : typeof raw.partialStdout === 'string' ? raw.partialStdout : '';
    let parsed = null, parseStatus = 'invalid-json';
    try { parsed = JSON.parse(stdout); parseStatus = 'json'; } catch {}
    const errors = new Set(['aborted', 'timeout', 'spawn-failed', 'output-limit', 'exit-code', 'runner-failed']);
    const error = raw.error ? (errors.has(raw.error) ? raw.error : 'runner-failed') : null;
    const completed = !error && (raw.exitCode === undefined || raw.exitCode === 0);
    return {
        version: 1, kind: 'workbuddy-cli',
        execution: { status: completed ? 'completed' : error === 'spawn-failed' ? 'not-started' : 'uncertain',
            exitCode: Number.isInteger(raw.exitCode) ? raw.exitCode : null, error: error || (!completed ? 'exit-code' : null) },
        stdout, parsed, parseStatus, meta: readUsage(parsed),
        // stderr can contain credentials or signed addresses. Retain only the
        // existing authentication diagnosis, never the original error text.
        authenticationRequired: /Authentication required|sign in to/i.test(`${stdout}\n${typeof raw.stderr === 'string' ? raw.stderr : ''}`),
    };
}

function parseCliOutput(stdout) {
    let parsed;
    try {
        parsed = JSON.parse(stdout);
    } catch {
        throw responseError('CodeBuddy CLI 返回内容不是合法 JSON', 'MODEL_OUTPUT_NOT_JSON');
    }
    const items = Array.isArray(parsed) ? parsed : [parsed];
    const result = [...items].reverse().find((item) => item && item.type === 'result');
    if (!result) throw responseError('CodeBuddy CLI 返回里没有 result 元素', 'MODEL_RESULT_MISSING');
    if (result.is_error) throw responseError('CodeBuddy CLI 报错，完整回包仅保留在本地私有记录中', 'MODEL_REPORTED_ERROR');

    let payload = result.structured_output;
    if (payload === undefined) {
        try {
            payload = JSON.parse(result.result || '');
        } catch {
            throw responseError('CodeBuddy CLI 既无结构化输出，result 也不是 JSON', 'MODEL_PAYLOAD_NOT_JSON');
        }
    }

    return { payload, ...readUsage(parsed) };
}

// 业务校验：与网页端 validateAnswers 口径保持一致，宁可报错也不提交错答案
function validateAnswers(questions, answers) {
    if (!Array.isArray(answers) || answers.length !== questions.length) {
        throw new Error(`CodeBuddy CLI 返回的题目数量不匹配（期望 ${questions.length}，实际 ${Array.isArray(answers) ? answers.length : '非数组'}）`);
    }
    const seen = new Set();
    return answers.map((item) => {
        if (!item || !Number.isInteger(item.id) || item.id < 1 || item.id > questions.length) {
            throw new Error('CodeBuddy CLI 返回了未知题号');
        }
        if (seen.has(item.id)) throw new Error(`CodeBuddy CLI 返回重复题号：${item.id}`);
        seen.add(item.id);
        if (Object.keys(item).some(key => !['id', 'letters'].includes(key))) throw new Error(`第 ${item.id} 题 CodeBuddy CLI 答案包含未知字段`);

        if (!Array.isArray(item.letters) || item.letters.length === 0) {
            throw new Error(`第 ${item.id} 题 CodeBuddy CLI 未给出选项`);
        }
        const letters = item.letters.map((letter) => typeof letter === 'string' ? letter.trim().toUpperCase() : '');
        if (letters.some((letter) => !/^[A-H]$/.test(letter))) {
            throw new Error(`第 ${item.id} 题返回了非法选项`);
        }
        if (new Set(letters).size !== letters.length) {
            throw new Error(`第 ${item.id} 题返回了重复选项：${letters.join('、')}`);
        }
        const question = questions[item.id - 1];
        if (question.type !== '多选题' && letters.length !== 1) {
            throw new Error(`第 ${item.id} 题是${question.type}，但返回了 ${letters.length} 个选项`);
        }
        const invalid = letters.filter((letter) => !question.options.some((option) => option.letter === letter));
        if (invalid.length) {
            throw new Error(`第 ${item.id} 题返回了题目中不存在的选项：${invalid.join('、')}`);
        }
        return { id: item.id, letters };
    });
}

function receiptPayload(receipt) {
    if (!receipt || receipt.kind !== 'workbuddy-cli' || receipt.version !== 1 || typeof receipt.stdout !== 'string')
        throw responseError('本地模型回包记录无效', 'MODEL_RECEIPT_INVALID');
    if (receipt.execution?.status !== 'completed') throw responseError('模型调用结果不明，不能自动重发', 'MODEL_OUTCOME_UNKNOWN');
    if (receipt.authenticationRequired) throw responseError('CodeBuddy CLI 未登录，请在原 CLI 中完成授权', 'MODEL_AUTH_REQUIRED');
    // stdout is the original source; do not trust a separately edited parsed
    // field during recovery. The owner additionally hashes the saved receipt.
    const result = parseCliOutput(receipt.stdout);
    if (!result.payload || typeof result.payload !== 'object' || Array.isArray(result.payload) || !('answers' in result.payload))
        throw responseError('CodeBuddy CLI 返回里缺少 answers 字段', 'MODEL_ANSWERS_MISSING');
    return result;
}

/** Revalidate a saved response without a CLI invocation or any network request. */
export function validateReceiptAnswers(questions, receipt) {
    if (!validQuestions(questions)) throw responseError('题目格式不正确', 'MODEL_QUESTIONS_INVALID');
    const { payload } = receiptPayload(receipt);
    return questions.some(isTextQuestion) ? validateMixedAnswers(questions, payload.answers) : validateAnswers(questions, payload.answers);
}

/** Retain independently valid rows. Ambiguous IDs invalidate the entire batch. */
export function inspectReceiptAnswers(questions, receipt) {
    if (!validQuestions(questions)) throw responseError('题目格式不正确', 'MODEL_QUESTIONS_INVALID');
    const { payload, model, credit } = receiptPayload(receipt);
    if (!Array.isArray(payload.answers)) throw responseError('CodeBuddy CLI 返回的题目数量不匹配', 'MODEL_ANSWERS_INVALID');
    const ids = payload.answers.map(answer => answer?.id);
    if (ids.some(id => !Number.isInteger(id) || id < 1 || id > questions.length) || new Set(ids).size !== ids.length)
        throw responseError('模型答案题号不明确，整组保留待检查', 'MODEL_ANSWER_IDS_AMBIGUOUS');
    const answers = [], invalidIds = [];
    for (const question of questions) {
        const row = payload.answers.find(answer => answer.id === question.id);
        if (!row) { invalidIds.push(question.id); continue; }
        try {
            const localQuestion = { ...question, id: 1 }, localAnswer = { ...row, id: 1 };
            const validated = isTextQuestion(question) ? validateMixedAnswers([localQuestion], [localAnswer]) : validateAnswers([localQuestion], [localAnswer]);
            answers.push({ ...validated[0], id: question.id });
        } catch { invalidIds.push(question.id); }
    }
    return { answers, invalidIds, complete: invalidIds.length === 0, meta: { model, credit } };
}

function explain(code, detail) {
    const seconds = String(detail || '').match(/^\d+(?:\.\d+)? 秒$/)?.[0] || '规定时间';
    if (code === 'timeout') return `CodeBuddy CLI 超过 ${seconds}未返回，已中止（未提交任何答案）`;
    if (code === 'spawn-failed') return '无法启动 CodeBuddy CLI。请用 WB_CLI_PATH 指向 Node 可执行的 JS 入口';
    if (code === 'output-limit') return `CodeBuddy CLI 输出超过 ${/^\d{1,12}$/.test(String(detail)) ? detail + ' 字节' : '允许的字节数'}，已中止`;
    if (code === 'exit-code') return 'CodeBuddy CLI 进程失败，调用结果需检查';
    return 'CodeBuddy CLI 调用失败，结果不明，请检查本地记录';
}

export async function requestAnswers(questions, _apiKey, deps = {}) {
    if (deps.signal?.aborted) throw cancelledError();
    const runner = deps.runner || runCli;
    const timeoutMs = deps.timeoutMs || DEFAULT_TIMEOUT_MS;
    const model = deps.model || MODEL;
    if (!validQuestions(questions)) throw new Error('题目格式不正确');
    const mixed = questions.some(isTextQuestion);
    const hasImages = questions.some((q) => q.images?.length);
    const promptQuestions = questions.map(({ images, ...q }) => ({ ...q, imageCount: images?.length || 0 }));
    const prompt = `${mixed ? '按题意回答全部题目，无法确定时不要编造。' : SYSTEM_PROMPT}\n${TEXT_INSTRUCTIONS}\n题目：\n${JSON.stringify(promptQuestions)}`;
    // Windows CreateProcess has a command-line size limit. Reuse the existing
    // structured stdin transport for long shared reading/listening material.
    const useStdin = hasImages || prompt.length > 12000;

    if (!deps.runner && !cliExists()) {
        throw new Error(`找不到 CodeBuddy CLI：${CLI_PATH}。请改用原 DeepSeek 方式，或设置 WB_CLI_PATH 指向已安装的 codebuddy`);
    }

    const args = [
        '-p', ...(useStdin ? [] : [prompt]),
        '--model', model,
        '--output-format', 'json',
        '--json-schema', mixed ? JSON.stringify(ANSWER_SCHEMA) : SCHEMA,
        '--tools', 'StructuredOutput',
        '--permission-mode', 'dontAsk',
    ];
    let stdinText;
    if (useStdin) {
        args.push('--input-format', 'stream-json');
        const content = [{ type: 'text', text: prompt }];
        for (const q of questions) for (const [index, dataUrl] of (q.images || []).entries()) {
            const match = dataUrl.match(/^data:(image\/(?:png|jpeg|webp));base64,(.+)$/);
            content.push({ type: 'text', text: `第${q.id}题图片${index + 1}` });
            content.push({ type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } });
        }
        stdinText = `${JSON.stringify({ type: 'user', message: { role: 'user', content } })}\n`;
    }
    let raw;
    try { raw = await runner(args, timeoutMs, stdinText, { signal: deps.signal, maxOutputBytes: deps.maxOutputBytes }); }
    catch { raw = { error: 'runner-failed' }; }
    if (!raw || typeof raw !== 'object') raw = { error: 'runner-failed' };
    const receipt = createCliReceipt(raw);
    if (deps.onReceipt) {
        try { await deps.onReceipt(receipt); }
        catch { throw responseError('模型回包已收到，但本地记录未确认保存；请检查后恢复，不要重发', 'MODEL_RECEIPT_SAVE_FAILED'); }
    }
    if (deps.signal?.aborted || raw.error === 'aborted') throw cancelledError();
    if (raw.error) throw new Error(explain(raw.error, raw.detail));
    if (raw.exitCode !== undefined && raw.exitCode !== 0) throw new Error(explain('exit-code', `退出码 ${raw.exitCode}`));

    if (receipt.authenticationRequired) {
        throw new Error('CodeBuddy CLI 未登录：请在该 CLI 中运行一次 codebuddy 并选择「Log in via Chinese Site」完成授权');
    }

    if (deps.onMeta) await deps.onMeta(receipt.meta);
    return validateReceiptAnswers(questions, receipt);
}
