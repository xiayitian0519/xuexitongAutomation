// Explicit, optional execution scope. Existing video/course runs keep their prior behavior.
export function normalizeAnswerPolicy(policy) {
    if (policy == null) return null;
    if (typeof policy !== 'object' || policy.questionsOnly !== true || policy.skipWorkedSolutions !== true)
        throw new Error('只做题策略必须同时禁用视频并跳过需要过程的题目');
    return { questionsOnly: true, skipWorkedSolutions: true };
}

export async function installQuestionOnlyGuards(context, policy) {
    const normalized = normalizeAnswerPolicy(policy);
    if (!normalized) return;
    await context.addInitScript((value) => {
        window.__xuexitongAnswerPolicy = Object.freeze(value);
        // Stop actual playback; never emulate progress, completion or an ended event.
        HTMLMediaElement.prototype.play = function () { this.pause(); return Promise.resolve(); };
        Object.defineProperty(HTMLMediaElement.prototype, 'autoplay', {
            configurable: true, get: () => false, set: () => {},
        });
        document.addEventListener('play', event => {
            if (event.target instanceof HTMLMediaElement) event.target.pause();
        }, true);
    }, normalized);
    await context.route('**/*', async route => {
        const req = route.request();
        const path = new URL(req.url()).pathname;
        if (req.resourceType() === 'media' || /\.(?:mp4|webm|m3u8|mp3|m4a|ogg|wav)$/i.test(path))
            await route.abort('blockedbyclient');
        else await route.fallback();
    });
}
