import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveListeningPaths } from './local-paths.mjs';
const execute = promisify(execFile);
export async function checkLocalAsr(options = {}) {
    const { model, dependencies: dependencyDir, python } = resolveListeningPaths(options);
    const inspectFile = options.stat || stat;
    for (const name of ['model.bin', 'config.json', 'tokenizer.json']) {
        const info = await inspectFile(join(model, name)).catch(() => null);
        if (!info?.isFile() || !info.size) throw new Error('LISTENING_LOCAL_MODEL_INCOMPLETE');
    }
    const code = 'import sys,json;sys.path.insert(0,sys.argv[1]);import faster_whisper,av;print(json.dumps({"version":faster_whisper.__version__,"decoder":True}))';
    let health;
    try {
        const output = await (options.execute || execute)(python, ['-c', code, dependencyDir],
            { windowsHide: true, timeout: 15000, maxBuffer: 4096 });
        health = JSON.parse(output.stdout.trim());
    } catch { throw new Error('LISTENING_PYTHON_DEPENDENCIES_UNAVAILABLE'); }
    if (health.version !== '1.2.1' || !health.decoder) throw new Error('LISTENING_ENGINE_VERSION_UNVERIFIED');
    return { version: health.version, localModelReady: true, decoderReady: true, modelRequests: 0 };
}
