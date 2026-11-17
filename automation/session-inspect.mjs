// Safe, read-only connection check. Does not navigate, create pages or send input.
export default async function inspectSession(session) {
    if (!session.context || !session.browser?.isConnected()) throw new Error('EXISTING_BROWSER_DISCONNECTED');
    const pages = session.context.pages();
    return { connected: true, backend: 'isolated-edge', pageCount: pages.length,
        pages: pages.map((page, index) => {
            try {
                const url = new URL(page.url());
                return { index, platform: url.protocol === 'https:' && /(^|\.)chaoxing\.com$/i.test(url.hostname),
                    origin: ['http:', 'https:'].includes(url.protocol) ? url.origin : url.protocol,
                    path: ['http:', 'https:'].includes(url.protocol) ? url.pathname : '' };
            } catch { return { index, platform: false, origin: 'unknown', path: '' }; }
        }) };
}
