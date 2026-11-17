import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { requestAnswers } from '../deepseek-console/wb-cli-request.mjs';

const root = resolve(import.meta.dirname, '..');
const consoleDir = resolve(root, 'deepseek-console');

// 语法检查：改动过的三个文件先过一遍
for (const file of ['deepseek-request.mjs', 'deepseek-local.mjs', 'wb-cli-request.mjs']) {
    execFileSync(process.execPath, ['--check', resolve(consoleDir, file)], { stdio: 'inherit' });
}

const QUESTIONS = [
    { id: 1, type: '单选题', question: '1 + 1 等于多少？', options: [{ letter: 'A', text: '1' }, { letter: 'B', text: '2' }] },
    { id: 2, type: '多选题', question: '下列哪些是偶数？', options: [{ letter: 'A', text: '2' }, { letter: 'B', text: '3' }, { letter: 'C', text: '4' }] },
    { id: 3, type: '判断题', question: '太阳从东边升起。', options: [{ letter: 'A', text: '正确' }, { letter: 'B', text: '错误' }] },
];

const goodAnswers = [
    { id: 1, letters: ['B'] },
    { id: 2, letters: ['A', 'C'] },
    { id: 3, letters: ['A'] },
];

// 伪造 CLI 输出：全部离线，不消耗任何额度
function cliOutput(structured, { model = 'deepseek-v4.1-flash', credit = 0.12, isError = false, result = '' } = {}) {
    return JSON.stringify([
        { type: 'message', role: 'user', content: [] },
        { type: 'function_call', name: 'StructuredOutput', providerData: { model, rawUsage: { credit } } },
        { type: 'result', is_error: isError, subtype: isError ? 'error' : 'success', result, structured_output: structured, num_turns: 4 },
    ]);
}

async function expectFail(label, runner, expected) {
    await assert.rejects(
        () => requestAnswers(QUESTIONS, undefined, { runner }),
        (error) => {
            assert.match(error.message, expected);
            return true;
        },
    );
    console.log(`✓ ${label} → ${expected}`);
}

// ---- 1. 下发的参数：只放开 StructuredOutput ----
const capturedArgs = [];
await requestAnswers(QUESTIONS, undefined, {
    runner: async (args) => {
        capturedArgs.push(...args);
        return { stdout: cliOutput({ answers: goodAnswers }) };
    },
});
assert.equal(capturedArgs[capturedArgs.indexOf('--tools') + 1], 'StructuredOutput');
assert.ok(capturedArgs.includes('--json-schema'));
assert.ok(capturedArgs.includes('--model'));
for (const forbidden of ['Bash', 'Edit', 'Write', 'Read', 'WebFetch', 'WebSearch', 'Glob', 'Grep']) {
    assert.ok(!capturedArgs.includes(forbidden), `不应开放工具 ${forbidden}`);
}
console.log('✓ 工具白名单只有 StructuredOutput，未开放文件/终端/浏览器工具');

// ---- 2. 三种题型正常通过 ----
const meta = [];
const answers = await requestAnswers(QUESTIONS, undefined, {
    runner: async () => ({ stdout: cliOutput({ answers: goodAnswers }) }),
    onMeta: (m) => meta.push(m),
});
assert.equal(answers.length, 3);
assert.deepEqual(answers.map((a) => a.letters.join('')), ['B', 'AC', 'A']);
assert.equal(meta[0].model, 'deepseek-v4.1-flash');
assert.equal(meta[0].credit, 0.12);
console.log('✓ 三种题型（单选/多选/判断）解析与校验通过，meta 取到模型与积分');

// ---- 3. 未登录 ----
await expectFail(
    '未登录',
    async () => ({ stdout: '', stderr: 'Authentication required. Please use /login command to sign in to your account' }),
    /未登录/,
);

// ---- 4. CLI 路径不存在（子进程里改 WB_CLI_PATH，走真实存在性检查） ----
const probe = `
import { pathToFileURL } from 'node:url';
const m = await import('${pathToFileURL(resolve(consoleDir, 'wb-cli-request.mjs')).href}');
try {
  await m.requestAnswers(${JSON.stringify(QUESTIONS)});
  console.log('NO_ERROR');
  process.exit(3);
} catch (e) {
  console.log(e.message);
  process.exit(/找不到 CodeBuddy CLI/.test(e.message) ? 0 : 4);
}
`;
let probeOut = '';
try {
    probeOut = execFileSync(process.execPath, ['--input-type=module', '-e', probe], {
        encoding: 'utf8',
        env: { ...process.env, WB_CLI_PATH: 'D:\\definitely\\not\\exists\\codebuddy.exe' },
    });
} catch (error) {
    throw new Error(`CLI 路径缺失时应给出明确提示，实际退出码 ${error.status}：${error.stdout || error.message}`);
}
assert.match(probeOut, /找不到 CodeBuddy CLI/);
console.log('✓ CLI 路径不存在 → 明确提示找不到 CodeBuddy CLI，并给出 WB_CLI_PATH 指引');

// ---- 5. 启动失败 / 超时 ----
await expectFail('进程启动失败', async () => ({ error: 'spawn-failed', detail: 'ENOENT' }), /无法启动 CodeBuddy CLI/);
await expectFail('超时', async () => ({ error: 'timeout', detail: '180 秒' }), /超过 180 秒未返回/);

// ---- 6. 非法返回 ----
await expectFail('返回非 JSON', async () => ({ stdout: 'Service Unavailable' }), /不是合法 JSON/);
await expectFail('缺少 result 元素', async () => ({ stdout: JSON.stringify([{ type: 'message' }]) }), /没有 result 元素/);
await expectFail('CLI 自身报错', async () => ({ stdout: cliOutput(null, { isError: true, result: '模型不可用' }) }), /CLI 报错/);
await expectFail('答案数量不符', async () => ({ stdout: cliOutput({ answers: goodAnswers.slice(0, 2) }) }), /题目数量不匹配/);
await expectFail(
    '未知题号',
    async () => ({ stdout: cliOutput({ answers: [{ id: 1, letters: ['B'] }, { id: 9, letters: ['A'] }, { id: 3, letters: ['A'] }] }) }),
    /未知题号/,
);
await expectFail(
    '单选题给了多个选项',
    async () => ({ stdout: cliOutput({ answers: [{ id: 1, letters: ['A', 'B'] }, { id: 2, letters: ['A'] }, { id: 3, letters: ['A'] }] }) }),
    /是单选题，但返回了 2 个选项/,
);
await expectFail(
    '选项不在题目里',
    async () => ({ stdout: cliOutput({ answers: [{ id: 1, letters: ['H'] }, { id: 2, letters: ['A'] }, { id: 3, letters: ['A'] }] }) }),
    /题目中不存在的选项/,
);
await expectFail(
    '选项重复',
    async () => ({ stdout: cliOutput({ answers: [{ id: 1, letters: ['B'] }, { id: 2, letters: ['A', 'A'] }, { id: 3, letters: ['A'] }] }) }),
    /重复选项/,
);
await expectFail('缺 answers 字段', async () => ({ stdout: cliOutput({ result: 'x' }) }), /缺少 answers 字段/);

// ---- 7. 原 DeepSeek 实现未被改动 ----
const original = readFileSync(resolve(consoleDir, 'deepseek-request.mjs'), 'utf8');
assert.match(original, /api\.deepseek\.com/);
assert.match(original, /export async function requestAnswers/);
assert.ok(!original.includes('wb-cli'), 'deepseek-request.mjs 不应被 CLI 方式污染');
console.log('✓ 原 DeepSeek 实现未被改动（仍直连 api.deepseek.com，无 CLI 相关代码）');

console.log('\n全部离线用例通过，未调用真实模型、未消耗额度。');
