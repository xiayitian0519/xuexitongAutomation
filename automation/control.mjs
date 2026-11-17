// A small persistent entry point for chat-triggered starts. No scheduler or browser debug port.
import { spawn } from 'node:child_process';
import { mkdirSync, openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './browser-driver.mjs';
import { STATE_DIR, parseArgs, main, assertLocalBrowserLaunchAllowed } from './run.mjs';

const args = process.argv.slice(2);
try {
    const foreground = args.includes('--foreground');
    const clean = args.filter((arg) => arg !== '--foreground');
    const options = parseArgs(clean);
    assertLocalBrowserLaunchAllowed(options.mode);
    if (foreground || ['status','stop','help','check'].includes(options.mode)) await main(clean);
    else {
        mkdirSync(STATE_DIR, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g,'-');
        const log = join(STATE_DIR, `${options.mode}-${stamp}.log`);
        const fd = openSync(log, 'a');
        const child = spawn(process.execPath, [join(ROOT,'automation/run.mjs'), ...clean], {
            cwd: ROOT, windowsHide: true, detached: true, stdio: ['ignore',fd,fd],
        });
        closeSync(fd);
        await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
        child.unref();
        console.log(JSON.stringify({ dispatched: true, pid: child.pid, mode: options.mode, log,
            next: '用 node automation/control.mjs --status 查询实际运行状态；dispatched 仅表示已启动进程。' }, null, 2));
    }
} catch (error) { console.error(error.message); process.exitCode = 1; }
