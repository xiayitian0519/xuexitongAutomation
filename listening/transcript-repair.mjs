import { inspectTranscript, checkCoverage, validateTranscript } from './contracts.mjs';

export function repairRanges(transcript, coverage, contextSeconds = 3) {
    const quality = inspectTranscript(transcript);
    if (quality.globalIssues.length) throw new Error('ASR_GLOBAL_FAILURE');
    const problems = [...quality.issues, ...coverage.problems];
    if (problems.some(row => !Number.isFinite(row.start) || !Number.isFinite(row.end))) throw new Error('COVERAGE_RANGE_UNKNOWN');
    const intervals = problems.map(row => ({
        start: Math.max(0, row.start - contextSeconds),
        end: Math.min(transcript.duration, row.end + contextSeconds),
    }));
    // Replace whole overlapping source segments, never leave half an original
    // sentence on both sides of a new clip.
    for (const interval of intervals) {
        let changed = true;
        while (changed) {
            const start = interval.start, end = interval.end;
            for (const segment of transcript.segments) if (segment.end > start && segment.start < end) {
                interval.start = Math.min(interval.start, segment.start);
                interval.end = Math.max(interval.end, Math.min(transcript.duration, segment.end));
            }
            changed = start !== interval.start || end !== interval.end;
        }
    }
    const merged = [];
    for (const interval of intervals.sort((a, b) => a.start - b.start)) {
        const previous = merged.at(-1);
        if (previous && interval.start <= previous.end) previous.end = Math.max(previous.end, interval.end);
        else merged.push({ ...interval });
    }
    if (merged.some(row => row.end - row.start > 120)) throw new Error('REPAIR_RANGE_TOO_WIDE');
    return merged;
}

export function mergeRepair(original, clip, range) {
    validateTranscript(clip);
    if (!Number.isFinite(clip.offsetSeconds) || Math.abs(clip.offsetSeconds - range.start) > 0.05 ||
        Math.abs(clip.duration - (range.end - range.start)) > 0.15 ||
        !Number.isFinite(clip.sourceDuration) || Math.abs(clip.sourceDuration - original.duration) > 0.15) throw new Error('REPAIR_OFFSET_INVALID');
    const shift = value => Number((value + range.start).toFixed(6));
    const replacement = clip.segments.map(row => ({ ...row, start: shift(row.start), end: shift(row.end),
        words: (row.words || []).map(word => ({ ...word, start: shift(word.start), end: shift(word.end) })) }));
    if (!replacement.length || replacement.some(row => row.start < range.start - 0.1 || row.end > range.end + 0.1))
        throw new Error('REPAIR_OUTSIDE_RANGE');
    const kept = original.segments.filter(row => row.end <= range.start || row.start >= range.end);
    return { ...original, segments: [...kept, ...replacement].sort((a, b) => a.start - b.start) };
}

export function transcriptChecks(audio, questions, transcript) {
    const quality = inspectTranscript(transcript), coverage = checkCoverage(audio, questions, transcript);
    return { ok: quality.ok && coverage.ok, quality, coverage };
}
