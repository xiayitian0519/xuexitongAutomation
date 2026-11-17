// Diagnostics are deliberately lossy. Do not pass raw HTML or signed URLs on to logs.
const secretKey = /^(?:cookie|cookies|authorization|password|secret|access.?token|refresh.?token|token|enc|signature|sign|api.?key|headers|outerhtml|innerhtml|html)$/i;
export function safeDiagnosticText(value) {
    let text = String(value);
    if (/<\/?[a-z][^>]*>/i.test(text)) return '[HTML omitted]';
    text = text.replace(/https?:\/\/[^\s<>"']+/gi, raw => {
        try { const url = new URL(raw); return `${url.origin}${url.pathname}`; }
        catch { return '[URL omitted]'; }
    });
    text = text.replace(/(?:[?&]|&amp;)(?:[a-z_][\w.-]*)=[^\s<>"']*/gi, '[query omitted]');
    text = text.replace(/\b(?:Bearer\s+\S+|(?:token|enc|signature|password|secret)\s*[:=]\s*[^\s,;]+)/gi, '[credential omitted]');
    return text.slice(0, 4000);
}
export function sanitizeDiagnostic(value, depth = 0) {
    if (depth > 16) return '[depth limit]';
    if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
    if (typeof value === 'string') return safeDiagnosticText(value);
    if (Array.isArray(value)) return value.slice(0, 200).map(row => sanitizeDiagnostic(row, depth + 1));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
        .filter(([key]) => !secretKey.test(key))
        .map(([key, row]) => [key, sanitizeDiagnostic(row, depth + 1)]));
    return null;
}
export const buttonDiagnostic = button => ({
    tag: button.tag, type: button.type || '', text: safeDiagnosticText(button.text || ''),
    visible: button.visible === true, disabled: button.disabled === true,
    checked: typeof button.checked === 'boolean' ? button.checked : null,
});
