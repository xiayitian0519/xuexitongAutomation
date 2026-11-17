import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rename, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { auditPortablePackage, buildPortablePackage, PORTABLE_TEMPLATE_MAP } from '../scripts/package-workflow.mjs';

const project = resolve(import.meta.dirname, '..'), temporary = join(project, '.tmp');
await mkdir(temporary, { recursive: true });
const workspace = await mkdtemp(join(temporary, 'portable-package-tests-'));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const crcTable = Array.from({ length: 256 }, (_, value) => {
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    return value >>> 0;
});
function crc32(bytes) { let value = 0xffffffff; for (const byte of bytes) value = crcTable[(value ^ byte) & 255] ^ (value >>> 8); return (value ^ 0xffffffff) >>> 0; }
async function put(root, path, content) { const target = join(root, path); await mkdir(dirname(target), { recursive: true }); await writeFile(target, content); }
let serial = 0, groups = 0;
async function fixture() {
    const root = join(workspace, 'source-' + serial++); await mkdir(root);
    for (const [path, content] of Object.entries({
        'package.json': '{"name":"offline-portable-fixture","private":true,"type":"module"}\n',
        '.gitignore': '.tmp/\n.automation.local/\nnode_modules/\n',
        '启动学习通总控.cmd': '@echo off\nnode "%~dp0automation\\control.mjs"\n',
        '安装与检查.cmd': '@echo off\nnode "%~dp0automation\\setup.mjs"\n',
        '登录CodeBuddy.cmd': '@echo off\nnode "%~dp0automation\\setup.mjs" --login\n',
        '首次启动专用Edge.cmd': '@echo off\nnode "%~dp0automation\\session-host.mjs" --launch\n',
        '恢复专用Edge.cmd': '@echo off\nnode "%~dp0automation\\session-host.mjs" --resume\n',
        '查看专用Edge状态.cmd': '@echo off\nnode "%~dp0automation\\session-host.mjs" --status\n',
        'automation/control.mjs': "import {value} from '../listening/engine.mjs'; export const check=()=>value;\n",
        'automation/start.cmd': '@echo off\nnode "%~dp0control.mjs"\n',
        'listening/engine.mjs': 'export const value = 7;\n',
        'listening/transcribe.py': 'print("offline fixture")\n',
        'listening/requirements.txt': 'example-package==1.0.0\n',
        'deepseek-console/xuexitong-console.js': "const LOCAL_TOKEN = '__LOCAL_TOKEN__';\n",
        'deepseek-console/request.mjs': 'export const fixture = true;\n',
        'tests/verify-fixture.mjs': "import assert from 'node:assert/strict'; assert.ok(true);\n",
        'tests/fixtures/exam/page.mjs': 'export const fixture = "合成题目";\n',
        'scripts/package-workflow.mjs': await readFile(new URL('../scripts/package-workflow.mjs', import.meta.url)),
        // These excluded files deliberately contain data that cannot be shared.
        'README.md': 'ORIGINAL_PRIVATE_DOCUMENT', 'AGENTS.md': 'ORIGINAL_PRIVATE_RULES',
        'PROJECT_CONTEXT.md': 'ORIGINAL_PRIVATE_COURSE_SCOPE',
        '.automation.local/credentials.json': 'EXCLUDED_ACCOUNT_DATA',
        'node_modules/local.js': 'EXCLUDED_DEPENDENCY', '.tmp/current-task.mjs': 'EXCLUDED_REAL_TASK',
        'work/live-task.mjs': 'EXCLUDED_TASK_SCRIPT', 'img/question.png': 'EXCLUDED_IMAGE',
        'deliverables/old-report.md': 'EXCLUDED_PRIVATE_REPORT', '.env': 'EXCLUDED_ENVIRONMENT',
        '.git/config': 'EXCLUDED_REPOSITORY', 'automation/live-config.json': 'EXCLUDED_RUNTIME_CONFIG',
        'tests/verify-project-migration.mjs': 'EXCLUDED_HISTORICAL_AUDIT',
        'tests/verify-v3.mjs': 'EXCLUDED_LEGACY_USER_SCRIPT_TEST',
        'scripts/build-userscript.mjs': 'EXCLUDED_LEGACY_BUILDER',
    })) await put(root, path, content);
    for (const name of Object.keys(PORTABLE_TEMPLATE_MAP)) await put(root, 'distribution/templates/' + name, '# Public ' + name + '\n新用户使用自己的账号与课程。\n');
    return root;
}
function readZip(bytes) {
    const result = new Map(); let offset = 0;
    while (bytes.readUInt32LE(offset) === 0x04034b50) {
        assert.equal(bytes.readUInt16LE(offset + 6), 0x800, 'UTF-8 filename flag');
        assert.equal(bytes.readUInt16LE(offset + 8), 0, 'store method');
        const size = bytes.readUInt32LE(offset + 18), nameLength = bytes.readUInt16LE(offset + 26), extraLength = bytes.readUInt16LE(offset + 28);
        const name = bytes.toString('utf8', offset + 30, offset + 30 + nameLength);
        const dataOffset = offset + 30 + nameLength + extraLength, content = bytes.subarray(dataOffset, dataOffset + size);
        assert.equal(crc32(content), bytes.readUInt32LE(offset + 14)); assert.ok(!result.has(name));
        result.set(name, content); offset = dataOffset + size;
    }
    const directoryOffset = offset; let centralEntries = 0;
    while (bytes.readUInt32LE(offset) === 0x02014b50) {
        assert.equal(bytes.readUInt16LE(offset + 8), 0x800);
        const nameLength = bytes.readUInt16LE(offset + 28), extraLength = bytes.readUInt16LE(offset + 30), commentLength = bytes.readUInt16LE(offset + 32);
        const name = bytes.toString('utf8', offset + 46, offset + 46 + nameLength);
        assert.ok(result.has(name));
        const localOffset = bytes.readUInt32LE(offset + 42); assert.equal(bytes.readUInt32LE(localOffset), 0x04034b50);
        offset += 46 + nameLength + extraLength + commentLength; centralEntries++;
    }
    assert.equal(bytes.readUInt32LE(offset), 0x06054b50); assert.equal(bytes.readUInt16LE(offset + 10), centralEntries);
    assert.equal(bytes.readUInt32LE(offset + 12), offset - directoryOffset); assert.equal(bytes.readUInt32LE(offset + 16), directoryOffset);
    assert.equal(offset + 22, bytes.length); assert.equal(result.size, centralEntries); return result;
}
async function test(name, run) { await run(); groups++; console.log('✓ ' + name); }
let primaryRoot, primaryResult, primaryArchive;
await test('public allowlist, template replacement and ZIP UTF-8 structure', async () => {
    primaryRoot = await fixture(); primaryResult = await buildPortablePackage({ root: primaryRoot, version: 'offline-test' });
    primaryArchive = readZip(await readFile(primaryResult.zipPath));
    assert.ok([...primaryArchive.keys()].every(path => path.startsWith('学习通自动化/') && !path.includes('\\')));
    assert.equal(primaryArchive.get('学习通自动化/README.md').toString(), '# Public README.md\n新用户使用自己的账号与课程。\n');
    assert.ok(primaryArchive.has('学习通自动化/启动学习通总控.cmd'));
    assert.ok(primaryArchive.has('学习通自动化/automation/start.cmd'));
    for (const path of ['安装与检查.cmd', '登录CodeBuddy.cmd', '首次启动专用Edge.cmd', '恢复专用Edge.cmd', '查看专用Edge状态.cmd'])
        assert.ok(primaryArchive.has('学习通自动化/' + path));
    assert.ok(primaryArchive.has('学习通自动化/tests/fixtures/exam/page.mjs'));
    assert.ok(primaryArchive.has('学习通自动化/distribution/templates/AGENTS.md'));
    const all = [...primaryArchive.values()].map(bytes => bytes.toString()).join('\n');
    assert.doesNotMatch(all, /ORIGINAL_PRIVATE_|EXCLUDED_ACCOUNT_DATA|EXCLUDED_DEPENDENCY|EXCLUDED_REAL_TASK|EXCLUDED_TASK_SCRIPT|EXCLUDED_IMAGE|EXCLUDED_PRIVATE_REPORT|EXCLUDED_ENVIRONMENT|EXCLUDED_REPOSITORY|EXCLUDED_RUNTIME_CONFIG|EXCLUDED_HISTORICAL_AUDIT|EXCLUDED_LEGACY_/);
});
await test('read-only audit writes no package and matches packaged source hashes', async () => {
    const before = await readdir(join(primaryRoot, 'deliverables')), audit = await auditPortablePackage({ root: primaryRoot });
    assert.equal(audit.passed, true); assert.deepEqual(audit.files, primaryResult.manifest.files);
    assert.deepEqual(await readdir(join(primaryRoot, 'deliverables')), before);
});
await test('manifest hashes every source and matches external manifest / ZIP checksum', async () => {
    const bytes = await readFile(primaryResult.zipPath), manifest = JSON.parse(primaryArchive.get('学习通自动化/package-manifest.json'));
    assert.deepEqual(manifest, JSON.parse(await readFile(primaryResult.manifestPath, 'utf8')));
    assert.equal(manifest.sourceFileCount, primaryResult.fileCount);
    assert.equal(manifest.files.length + 1, primaryArchive.size);
    for (const row of manifest.files) {
        const value = primaryArchive.get('学习通自动化/' + row.path); assert.equal(value.length, row.bytes); assert.equal(digest(value), row.sha256);
    }
    assert.equal(digest(bytes), primaryResult.sha256);
    assert.match(await readFile(primaryResult.sha256Path, 'utf8'), new RegExp('^' + primaryResult.sha256 + '  .+\\.zip\\n$'));
    assert.ok(manifest.exclusions.some(row => row.reason === 'historical-machine-specific-migration-audit'));
});
await test('extracted source remains executable after relocating its top folder', async () => {
    const destination = join(workspace, 'another-location');
    for (const [path, bytes] of primaryArchive) await put(destination, path, bytes);
    const module = await import(pathToFileURL(join(destination, '学习通自动化/automation/control.mjs')).href);
    assert.equal(module.check(), 7);
});
await test('relocated package includes its public templates and can build a new package', async () => {
    const extractedRoot = join(workspace, 'another-location', '学习通自动化');
    const relocatedBuilder = await import(pathToFileURL(join(extractedRoot, 'scripts/package-workflow.mjs')).href);
    const rebuilt = await relocatedBuilder.buildPortablePackage({ root: extractedRoot });
    const archive = readZip(await readFile(rebuilt.zipPath));
    assert.equal(archive.size, primaryArchive.size);
    assert.ok(archive.has('学习通自动化/distribution/templates/README.md'));
});
await test('same requested version produces unique artifacts without overwriting', async () => {
    const oldBytes = await readFile(primaryResult.zipPath), newer = await buildPortablePackage({ root: primaryRoot, version: 'offline-test' });
    assert.notEqual(newer.zipPath, primaryResult.zipPath); assert.deepEqual(await readFile(primaryResult.zipPath), oldBytes);
});
await test('runtime local token blocks all deliverables before output', async () => {
    const root = await fixture(); await put(root, 'deepseek-console/xuexitong-console.js', "const LOCAL_TOKEN = '" + 'runtime' + '-not-placeholder' + "';\n");
    await assert.rejects(buildPortablePackage({ root }), /runtime-local-token/);
    assert.deepEqual(await readdir(join(root, 'deliverables')), ['old-report.md']);
});
await test('missing token placeholder blocks a damaged console script', async () => {
    const root = await fixture(); await put(root, 'deepseek-console/xuexitong-console.js', 'console.log("damaged source");\n');
    await assert.rejects(buildPortablePackage({ root }), /missing-local-token-placeholder/);
});
await test('literal credentials, bearer and private key material fail closed', async () => {
    for (const content of ['export const apiKey = "' + 'sensitive' + '-credential-value-1234' + '";\n',
        'const header = "Bearer ' + 'credential' + '-secret-value-long-enough' + '";\n',
        ['-----BEGIN', 'PRIVATE KEY-----'].join(' ')]) {
        const root = await fixture(); await put(root, 'automation/suspicious.mjs', content);
        await assert.rejects(buildPortablePackage({ root }), /literal-credential|literal-bearer|private-key/);
    }
});
await test('credential-named source files cannot enter an otherwise allowed directory', async () => {
    const root = await fixture(); await put(root, 'automation/credentials.mjs', 'export const value=true;');
    await assert.rejects(buildPortablePackage({ root }), /credential-file/);
});
await test('machine-specific absolute paths fail with a safe category', async () => {
    const root = await fixture(); await put(root, 'automation/suspicious.mjs', 'export const source="' + 'D' + ':/private-owner/local-project";');
    await assert.rejects(buildPortablePackage({ root }), error => /machine-absolute-path/.test(error.message) && !error.message.includes('private-owner'));
});
await test('synthetic secret fixtures and generic USERPROFILE fallback remain usable', async () => {
    const root = await fixture(); await put(root, 'tests/verify-synthetic.mjs', 'export const apiKey="fixture-only-not-a-real-key";\n');
    await put(root, 'automation/start.cmd', '@echo off\nset "NODE_EXE=%USERPROFILE%\\.cache\\node.exe"\n');
    assert.ok((await buildPortablePackage({ root })).fileCount > 0);
});
await test('missing public template blocks packaging instead of copying personal documents', async () => {
    const root = await fixture(); await rename(join(root, 'distribution/templates/AGENTS.md'), join(root, 'distribution/templates/AGENTS.missing'));
    await assert.rejects(buildPortablePackage({ root }), error => error.code === 'ENOENT');
});
await test('selected directory junction or symlink is rejected before source read', async () => {
    const root = await fixture(), previous = join(root, 'original-automation'); await rename(join(root, 'automation'), previous);
    await symlink(previous, join(root, 'automation'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(buildPortablePackage({ root }), /LINK_PATH_REJECTED|REPARSE_PATH_REJECTED/);
});
await test('output path cannot escape deliverables', async () => {
    const root = await fixture(); await assert.rejects(buildPortablePackage({ root, outputDirectory: join(root, 'other') }), /OUTPUT_MUST_BE_IN_DELIVERABLES/);
    await assert.rejects(buildPortablePackage({ root, outputDirectory: join(root, 'deliverables/../../other') }), /OUTPUT_MUST_BE_IN_DELIVERABLES/);
});
await test('output directory junction cannot create artifacts outside the source root', async () => {
    const root = await fixture(), original = join(root, 'original-deliverables');
    await rename(join(root, 'deliverables'), original);
    await symlink(original, join(root, 'deliverables'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(buildPortablePackage({ root, outputDirectory: join(root, 'deliverables/nested') }), /LINK_PATH_REJECTED|REPARSE_PATH_REJECTED/);
    assert.deepEqual(await readdir(original), ['old-report.md']);
});
await test('unsafe artifact names, binary sources and oversized sources reject', async () => {
    const root = await fixture(); await assert.rejects(buildPortablePackage({ root, name: '../escape' }), /ARTIFACT_NAME_INVALID/);
    await put(root, 'automation/binary.mjs', Buffer.from([0, 255, 1])); await assert.rejects(buildPortablePackage({ root }), /NON_TEXT_SOURCE/);
    await put(root, 'automation/binary.mjs', Buffer.alloc(4 * 1024 * 1024 + 1, 65)); await assert.rejects(buildPortablePackage({ root }), /FILE_LIMIT/);
});
console.log('PASS ' + groups + ' portable package groups; synthetic files only, no browser, network, CLI or paid calls');
console.log(JSON.stringify({ passed: true, groups }));
