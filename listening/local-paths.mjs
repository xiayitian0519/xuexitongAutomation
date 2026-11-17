import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const LISTENING_PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Pure path resolution: no file reads, process launches, downloads or settings writes.
export function resolveListeningPaths(options = {}) {
    const env = options.env || process.env;
    const paths = (options.platform || process.platform) === 'win32' ? path.win32 : path.posix;
    const root = paths.resolve(options.root || LISTENING_PROJECT_ROOT);
    const selectedModel = options.model || env.LISTENING_MODEL;
    return {
        root,
        model: paths.resolve(root, selectedModel || paths.join('.tmp', 'listening-model-small')),
        modelSource: options.model ? 'option' : env.LISTENING_MODEL ? 'environment' : 'project-default',
        dependencies: paths.resolve(root, options.dependencies || env.LISTENING_DEPENDENCIES || paths.join('.tmp', 'listening-python')),
        python: options.python || env.LISTENING_PYTHON || 'python',
    };
}
