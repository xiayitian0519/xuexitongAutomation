import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { sanitizeDiagnostic } from './diagnostics.mjs';
import { canonicalRoot, readSessionDescriptor, processStatus, requestHealth, safeOperationModule,
    validateJobId, sessionPaths, ensurePrivateDirectory, assertPrivatePath, publishExclusiveFile,
    inspectExistingSession, writeExclusiveJson } from './session-protocol.mjs';

export { inspectExistingSession } from './session-protocol.mjs';
export async function dispatchExistingOperation(options) {
    const directory = await canonicalRoot(options.root), loaded = await readSessionDescriptor(directory, options.machineKey);
    if (!loaded) throw new Error('EXISTING_SESSION_NOT_INITIALIZED');
    const { descriptor, protocol } = loaded;
    if (processStatus(descriptor.pid, options) !== 'alive') throw new Error('EXISTING_SESSION_PROCESS_UNAVAILABLE');
    await requestHealth(directory, descriptor, options);
    const module = await safeOperationModule(directory, options.module);
    const job = validateJobId(options.job || randomUUID().replaceAll('-', ''));
    const paths = sessionPaths(directory), resultFile = join(paths.jobs, job + '.json');
    await ensurePrivateDirectory(directory, paths.jobs);
    const requestFile = join(paths.jobs, job + '.request.json');
    await assertPrivatePath(directory, requestFile); await assertPrivatePath(directory, resultFile);
    const request = protocol === 'project' ? { version: 1, job, module, resultFile, root: directory, instance: descriptor.instance } : { job, module, resultFile };
    try { await writeExclusiveJson(requestFile, request); }
    catch (error) {
        if (error.code !== 'EEXIST') throw error;
        let previous;
        try { previous = JSON.parse(await readFile(requestFile, 'utf8')); } catch { throw new Error('EXISTING_JOB_RECORD_INVALID'); }
        if (previous.module !== module || previous.resultFile !== resultFile || previous.job !== job)
            throw new Error('EXISTING_JOB_ID_CONFLICT');
        return { job, resultFile, alreadyDispatched: true };
    }
    if (protocol === 'project') {
        await assertPrivatePath(directory, descriptor.actionDirectory);
        await publishExclusiveFile(descriptor.actionDirectory, job + '.action.json', JSON.stringify(request));
    } else {
        const action = `import {readFile,writeFile} from 'node:fs/promises';\nimport {sanitizeDiagnostic} from ${JSON.stringify(pathToFileURL(join(directory, 'automation/diagnostics.mjs')).href)};\nexport default async function(session){\nconst request=JSON.parse(await readFile(${JSON.stringify(requestFile)},'utf8'));\ntry {if(!session.browser?.isConnected()||!session.context)throw new Error('EXISTING_BROWSER_DISCONNECTED');\nconst operation=await import(${JSON.stringify(pathToFileURL(module).href + '?job=' + job)});\nconst value=sanitizeDiagnostic(await operation.default(session));\nawait writeFile(request.resultFile,JSON.stringify({ok:true,at:new Date().toISOString(),value}),{flag:'wx'});\nreturn {job:request.job,ok:true};\n}catch(error){await writeFile(request.resultFile,JSON.stringify({ok:false,at:new Date().toISOString(),error:sanitizeDiagnostic(error.message)}),{flag:'wx'});return {job:request.job,ok:false};}}\n`;
        await publishExclusiveFile(descriptor.actionDirectory, '800-project-' + job + '.action.mjs', action);
    }
    return { job, resultFile, alreadyDispatched: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    try {
        const [module, job] = process.argv.slice(2);
        const result = !module || module === '--status' ? await inspectExistingSession() : await dispatchExistingOperation({ module, job });
        console.log(JSON.stringify(result));
    } catch (error) { console.error(sanitizeDiagnostic(error.message)); process.exitCode = 1; }
}

