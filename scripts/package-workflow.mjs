import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MAX_FILE = 4 * 1024 * 1024, MAX_PACKAGE = 64 * 1024 * 1024;
const TOP_FOLDER = '学习通自动化';
export const PORTABLE_TEMPLATE_MAP = Object.freeze({
    'AGENTS.md': 'AGENTS.md', 'PROJECT_CONTEXT.md': 'PROJECT_CONTEXT.md', 'README.md': 'README.md',
    'WORKBUDDY_START.md': 'WORKBUDDY_START.md', '工作流规则.md': 'deliverables/学习通自动化工作流规则.md',
    'EXAM.md': 'automation/EXAM.md', 'LISTENING.md': 'listening/README.md', 'AUTOMATION.md': 'automation/README.md',
});
const excludedFiles = new Set(['tests/verify-project-migration.mjs', 'tests/verify-v3.mjs', 'scripts/build-userscript.mjs']);
const exclusions = [
    { scope: '.git,node_modules,.tmp,.automation.local,work,img', reason: 'private-state-dependencies-and-local-materials' },
    { scope: 'original-root-documents-and-deliverables', reason: 'replaced-by-public-distribution-templates' },
    { scope: 'tests/verify-project-migration.mjs', reason: 'historical-machine-specific-migration-audit' },
    { scope: 'tests/verify-v3.mjs,scripts/build-userscript.mjs,root-userscripts', reason: 'legacy-userscript-outside-this-workflow-package' },
    { scope: 'non-allowlisted-files', reason: 'explicit-source-allowlist-only' },
];
const hash = value => createHash('sha256').update(value).digest('hex');
const slash = value => value.replaceAll('\\', '/');
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
function inside(root, file) {
    const path = relative(root, file);
    return path !== '' && !isAbsolute(path) && !path.split(/[\\/]/).includes('..');
}
function validArchivePath(path) {
    return typeof path === 'string' && path !== '' && !path.startsWith('/') && !path.includes('\\') &&
        path.split('/').every(part => part && part !== '.' && part !== '..' && !/[\x00-\x1f<>:"|?*]/.test(part) &&
            !/[. ]$/.test(part) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}

// Node identifies symlinks and Windows junctions through lstat. The additional
// Windows attribute check also rejects other reparse-point kinds before reads.
async function rejectWindowsReparsePoints(paths) {
    if (process.platform !== 'win32') return;
    const script = '$ErrorActionPreference="Stop"; [Console]::InputEncoding=[Text.UTF8Encoding]::new($false); $taskPaths=ConvertFrom-Json ([Console]::In.ReadToEnd()); foreach($taskPath in $taskPaths){$taskItem=Get-Item -LiteralPath $taskPath -Force; if(($taskItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){[Console]::Out.Write("REPARSE");exit 3}}';
    await new Promise((accept, reject) => {
        const processHandle = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
            { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
        let settled = false;
        const finish = error => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : accept(); };
        const timer = setTimeout(() => { processHandle.kill(); finish(new Error('PACKAGE_PATH_CHECK_UNAVAILABLE')); }, 20000);
        processHandle.once('error', () => finish(new Error('PACKAGE_PATH_CHECK_UNAVAILABLE')));
        processHandle.once('close', code => finish(code === 0 ? null : new Error(code === 3 ? 'PACKAGE_REPARSE_PATH_REJECTED' : 'PACKAGE_PATH_CHECK_UNAVAILABLE')));
        processHandle.stdin.on('error', () => finish(new Error('PACKAGE_PATH_CHECK_UNAVAILABLE')));
        processHandle.stdin.end(JSON.stringify(paths));
    });
}

async function guardPath(file, checked) {
    const absolute = resolve(file), chain = [];
    for (let current = absolute; ; current = dirname(current)) {
        chain.push(current); if (dirname(current) === current) break;
    }
    for (const current of chain.reverse()) {
        const entry = await lstat(current);
        if (entry.isSymbolicLink() || !samePath(await realpath(current), current)) throw new Error('PACKAGE_LINK_PATH_REJECTED');
        checked.add(current);
    }
    const entry = await lstat(absolute);
    if (!entry.isDirectory() && !entry.isFile()) throw new Error('PACKAGE_SPECIAL_FILE_REJECTED');
    return entry;
}

function contentCheck(path, bytes) {
    const text = bytes.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(bytes) || text.includes('\u0000')) throw new Error('PACKAGE_NON_TEXT_SOURCE: ' + path);
    const reject = category => { throw new Error('PACKAGE_CONTENT_REJECTED: ' + path + ': ' + category); };
    if (/(?:^|\/)(?:\.?credentials?|cookies?|storage[-_]?state|auth[-_]?state|\.env)(?:\.|$)/i.test(path)) reject('credential-file');
    for (const match of text.matchAll(/^\s*(?:export\s+)?(?:const|let|var)\s+LOCAL_TOKEN\s*=\s*(['"])([^'"\r\n]*)\1\s*;/gm))
        if (match[2] !== '__LOCAL_TOKEN__') reject('runtime-local-token');
    if (path === 'deepseek-console/xuexitong-console.js' && !/^\s*const\s+LOCAL_TOKEN\s*=\s*(['"])__LOCAL_TOKEN__\1\s*;/m.test(text))
        reject('missing-local-token-placeholder');
    const fixtureValue = value => /^(?:__.*__|\$\{|fixture|test[-_]|fake|dummy|example|placeholder|SECRET$|TOPSECRET$|FIXTURE)/i.test(value);
    for (const match of text.matchAll(/\b(?:api[_-]?key|apiKey|access[_-]?token|refresh[_-]?token|client[_-]?secret|auth[_-]?token|session[_-]?id|cookie|password)\b["']?\s*[:=]\s*(['"])([^'"\r\n]+)\1/g))
        if (!fixtureValue(match[2]) && match[2].length >= 16) reject('literal-credential');
    for (const match of text.matchAll(/\b(?:sk-[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,})\b/g))
        if (!fixtureValue(match[0])) reject('credential-pattern');
    for (const match of text.matchAll(/\bBearer\s+([A-Za-z0-9._-]{20,})/g)) if (!fixtureValue(match[1])) reject('literal-bearer');
    for (const match of text.matchAll(/(?:^|[^A-Za-z0-9])([A-Za-z]:[\\/][^\s'"`<>]*)/gm)) {
        const value = match[1].replaceAll('\\\\', '\\').replaceAll('\\', '/');
        if (!(path.startsWith('tests/') && /^[Dd]:\/definitely\/not\/exists\/codebuddy\.exe$/.test(value))) reject('machine-absolute-path');
    }
    if (/(?:^|[\s'"`(])\/(?:Users|home)\/[^\s/'"`]+\//m.test(text)) reject('personal-home-path');
    if (/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/.test(text)) reject('private-key');
}

async function readGuarded(file, path, checked) {
    const before = await guardPath(file, checked);
    if (!before.isFile() || before.size > MAX_FILE) throw new Error('PACKAGE_FILE_LIMIT: ' + path);
    const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
        const opened = await handle.stat();
        if (!opened.isFile() || opened.ino !== before.ino || opened.dev !== before.dev || opened.size !== before.size)
            throw new Error('PACKAGE_SOURCE_CHANGED: ' + path);
        const bytes = await handle.readFile(), after = await handle.stat();
        if (bytes.length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs)
            throw new Error('PACKAGE_SOURCE_CHANGED: ' + path);
        contentCheck(path, bytes); return bytes;
    } finally { await handle.close(); }
}

async function collectSources(root, checked) {
    const selected = new Map();
    const put = (target, source) => {
        if (!validArchivePath(target) || selected.has(target.toLowerCase())) throw new Error('PACKAGE_PATH_COLLISION');
        selected.set(target.toLowerCase(), { path: target, source });
    };
    const flat = async (directory, accept, required = true) => {
        const absolute = join(root, directory);
        let rows;
        try { await guardPath(absolute, checked); rows = await readdir(absolute, { withFileTypes: true }); }
        catch (error) { if (!required && error.code === 'ENOENT') return; throw error; }
        for (const row of rows) {
            const path = directory ? directory + '/' + row.name : row.name;
            if (!accept(row.name) || excludedFiles.has(path)) continue;
            await guardPath(join(root, path), checked);
            if (!row.isFile()) throw new Error('PACKAGE_ALLOWLIST_ENTRY_NOT_FILE: ' + path);
            put(path, join(root, path));
        }
    };
    await guardPath(root, checked);
    for (const name of ['package.json', '.gitignore']) put(name, join(root, name));
    const rootLaunchers = new Set(['安装与检查.cmd', '登录CodeBuddy.cmd', '首次启动专用Edge.cmd', '恢复专用Edge.cmd', '查看专用Edge状态.cmd']);
    await flat('', name => /^启动[^/\\]*\.cmd$/i.test(name) || rootLaunchers.has(name));
    await flat('automation', name => /\.mjs$/i.test(name) || name === 'start.cmd');
    await flat('listening', name => /\.(?:mjs|py)$/i.test(name) || name === 'requirements.txt');
    await flat('deepseek-console', name => /\.(?:mjs|js|cmd)$/i.test(name));
    await flat('tests', name => /\.mjs$/i.test(name));
    await flat('scripts', name => /^package-[a-z0-9-]+\.mjs$/i.test(name));
    await flat('tests/fixtures/exam', name => /\.mjs$/i.test(name), false);
    for (const [source, target] of Object.entries(PORTABLE_TEMPLATE_MAP)) {
        const absolute = join(root, 'distribution', 'templates', source);
        put(target, absolute); put('distribution/templates/' + source, absolute);
    }
    for (const row of selected.values()) await guardPath(row.source, checked);
    await rejectWindowsReparsePoints([...checked]);
    return [...selected.values()].sort((a, b) => a.path.localeCompare(b.path, 'en'));
}

async function readPortableSources(root) {
    const checked = new Set(), sources = await collectSources(root, checked), files = [];
    let total = 0;
    for (const row of sources) {
        const bytes = await readGuarded(row.source, row.path, checked); total += bytes.length;
        if (total > MAX_PACKAGE) throw new Error('PACKAGE_SIZE_LIMIT');
        files.push({ path: row.path, bytes });
    }
    return { checked, files, total };
}

/** A read-only audit, useful before asking the builder to write deliverables. */
export async function auditPortablePackage({ root } = {}) {
    if (typeof root !== 'string' || !root.trim()) throw new Error('PACKAGE_ROOT_REQUIRED');
    const { files, total } = await readPortableSources(resolve(root));
    return { passed: true, fileCount: files.length, bytes: total,
        files: files.map(row => ({ path: row.path, bytes: row.bytes.length, sha256: hash(row.bytes) })), exclusions };
}

async function checkOutputAncestors(directory, checked) {
    let ancestor = directory;
    while (true) {
        try { await lstat(ancestor); break; }
        catch (error) { if (error.code !== 'ENOENT' || dirname(ancestor) === ancestor) throw error; ancestor = dirname(ancestor); }
    }
    await guardPath(ancestor, checked); await rejectWindowsReparsePoints([...checked]);
}

function crc32(bytes) {
    let value = 0xffffffff;
    for (const byte of bytes) {
        value ^= byte;
        for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    return (value ^ 0xffffffff) >>> 0;
}
function storeZip(files, at) {
    if (files.length > 65534) throw new Error('PACKAGE_FILE_COUNT_LIMIT');
    const locals = [], central = []; let offset = 0;
    const year = Math.max(1980, Math.min(2107, at.getUTCFullYear()));
    const date = (year - 1980) << 9 | (at.getUTCMonth() + 1) << 5 | at.getUTCDate();
    const time = at.getUTCHours() << 11 | at.getUTCMinutes() << 5 | Math.floor(at.getUTCSeconds() / 2);
    for (const row of files) {
        const name = Buffer.from(TOP_FOLDER + '/' + row.path, 'utf8'), bytes = row.bytes, crc = crc32(bytes);
        if (name.length > 65535) throw new Error('PACKAGE_NAME_LIMIT');
        const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4);
        header.writeUInt16LE(0x800, 6); header.writeUInt16LE(time, 10); header.writeUInt16LE(date, 12);
        header.writeUInt32LE(crc, 14); header.writeUInt32LE(bytes.length, 18); header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(name.length, 26);
        locals.push(header, name, bytes);
        const index = Buffer.alloc(46); index.writeUInt32LE(0x02014b50); index.writeUInt16LE(20, 4); index.writeUInt16LE(20, 6);
        index.writeUInt16LE(0x800, 8); index.writeUInt16LE(time, 12); index.writeUInt16LE(date, 14);
        index.writeUInt32LE(crc, 16); index.writeUInt32LE(bytes.length, 20); index.writeUInt32LE(bytes.length, 24);
        index.writeUInt16LE(name.length, 28); index.writeUInt32LE(offset, 42); central.push(index, name);
        offset += header.length + name.length + bytes.length;
    }
    const directory = Buffer.concat(central), end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
    end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, directory, end]);
}

/** Build only public sources and explicit new-machine templates; no processes are launched from packaged code. */
export async function buildPortablePackage({ root, outputDirectory, name = TOP_FOLDER, version } = {}) {
    if (typeof root !== 'string' || !root.trim()) throw new Error('PACKAGE_ROOT_REQUIRED');
    root = resolve(root); outputDirectory = resolve(outputDirectory || join(root, 'deliverables'));
    if (!samePath(outputDirectory, join(root, 'deliverables')) && !inside(join(root, 'deliverables'), outputDirectory))
        throw new Error('PACKAGE_OUTPUT_MUST_BE_IN_DELIVERABLES');
    if (!/^[\p{L}\p{N}._-]{1,60}$/u.test(name) || version !== undefined && !/^[A-Za-z0-9._-]{1,60}$/.test(version))
        throw new Error('PACKAGE_ARTIFACT_NAME_INVALID');
    const { checked, files, total } = await readPortableSources(root);
    const at = new Date(), manifest = { schemaVersion: 1, package: TOP_FOLDER, createdAt: at.toISOString(),
        version: version || at.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z'),
        sourceFileCount: files.length, sourceBytes: total,
        files: files.map(row => ({ path: row.path, bytes: row.bytes.length, sha256: hash(row.bytes) })),
        generatedFiles: ['package-manifest.json'], exclusions,
        verification: 'Source integrity and packaging only; no browser, model, account or live task validation.' };
    const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
    const archive = storeZip([...files, { path: 'package-manifest.json', bytes: manifestBytes }], at), sha256 = hash(archive);
    await checkOutputAncestors(outputDirectory, checked);
    await mkdir(outputDirectory, { recursive: true });
    await guardPath(outputDirectory, checked); await rejectWindowsReparsePoints([...checked]);
    const basename = name + '-' + manifest.version + '-' + randomUUID().slice(0, 8), zipPath = join(outputDirectory, basename + '.zip');
    const manifestPath = join(outputDirectory, basename + '.manifest.json'), sha256Path = join(outputDirectory, basename + '.zip.sha256');
    await writeFile(zipPath, archive, { flag: 'wx' });
    await writeFile(manifestPath, manifestBytes, { flag: 'wx' });
    await writeFile(sha256Path, sha256 + '  ' + basename + '.zip\n', { flag: 'wx' });
    return { zipPath, manifestPath, sha256Path, sha256, fileCount: files.length, bytes: archive.length, manifest };
}

if (process.argv[1] && samePath(resolve(process.argv[1]), fileURLToPath(import.meta.url))) {
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 2 || args[0] !== '--root')) throw new Error('USE_OPTIONAL_ROOT_PATH');
    const result = await buildPortablePackage({ root: args[1] || resolve(import.meta.dirname, '..') });
    console.log(JSON.stringify({ zipPath: result.zipPath, manifestPath: result.manifestPath,
        sha256Path: result.sha256Path, sha256: result.sha256, fileCount: result.fileCount, bytes: result.bytes }, null, 2));
}
