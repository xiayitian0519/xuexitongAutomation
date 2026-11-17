// Mapping only: source URLs remain transient material and never appear in errors.
// A single clip covers its card. Multiple clips need explicit Passage/Part labels;
// DOM order is used only as the clip ordinal when the page has no source.part.
const fail = code => { throw new Error(code); };
const positiveInteger = value => Number.isSafeInteger(value) && value > 0;
const present = value => value !== undefined && value !== null;
const validCardId = value => typeof value === 'string' && /^[a-z0-9_-]+$/i.test(value);

export function assignExamAudio(sources, map, options = {}) {
    if (!Array.isArray(sources) || !Array.isArray(map)) fail('EXAM_AUDIO_MAPPING_UNKNOWN');
    const cards = new Map(), ids = new Set();
    for (const item of map) {
        if (!item || !positiveInteger(item.id) || ids.has(item.id) || !validCardId(item.qid))
            fail('EXAM_AUDIO_MAPPING_UNKNOWN');
        ids.add(item.id);
        if (!cards.has(item.qid)) cards.set(item.qid, []);
        cards.get(item.qid).push(item);
    }

    const cardSources = new Map();
    for (const row of sources) {
        if (!row || !cards.has(row.qid) || typeof row.sourceUrl !== 'string' || !row.sourceUrl.trim())
            fail('EXAM_AUDIO_MAPPING_UNKNOWN');
        // Do not canonicalize signed sources: different URLs are not assumed to
        // be the same recording. Actual download policy is checked downstream.
        try {
            const url = new URL(row.sourceUrl);
            if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
                fail('EXAM_AUDIO_MAPPING_UNKNOWN');
        } catch { fail('EXAM_AUDIO_MAPPING_UNKNOWN'); }
        if (present(row.part) && !positiveInteger(row.part))
            fail('EXAM_MULTIPLE_AUDIO_PER_QUESTION_UNRESOLVED');
        if (!cardSources.has(row.qid)) cardSources.set(row.qid, new Map());
        const unique = cardSources.get(row.qid), previous = unique.get(row.sourceUrl);
        if (previous && present(previous.part) && present(row.part) && previous.part !== row.part)
            fail('EXAM_AUDIO_SOURCE_PART_CONFLICT');
        if (!previous) unique.set(row.sourceUrl, { sourceUrl: row.sourceUrl, part: row.part });
        else if (present(row.part)) previous.part = row.part;
    }

    const audioBySource = new Map(), assigned = new Set();
    for (const [qid, unique] of cardSources) {
        const clips = [...unique.values()], questions = cards.get(qid);
        const explicitParts = clips.filter(clip => present(clip.part));
        if (explicitParts.length && explicitParts.length !== clips.length)
            fail('EXAM_MULTIPLE_AUDIO_PER_QUESTION_UNRESOLVED');
        if (new Set(explicitParts.map(clip => clip.part)).size !== explicitParts.length)
            fail('EXAM_AUDIO_SOURCE_PART_CONFLICT');
        const byPart = new Map(clips.map((clip, index) => [clip.part ?? index + 1, clip]));
        const numberedPartsRequired = clips.length > 1 || explicitParts.length > 0;
        for (const item of questions) {
            if (present(item.audioPart) && !positiveInteger(item.audioPart))
                fail('EXAM_MULTIPLE_AUDIO_PER_QUESTION_UNRESOLVED');
            if (numberedPartsRequired && (!positiveInteger(item.audioPart) || !byPart.has(item.audioPart)))
                fail('EXAM_MULTIPLE_AUDIO_PER_QUESTION_UNRESOLVED');
        }
        for (const [part, clip] of byPart) {
            const matched = numberedPartsRequired ? questions.filter(item => item.audioPart === part) : questions;
            if (!matched.length) fail('EXAM_MULTIPLE_AUDIO_PER_QUESTION_UNRESOLVED');
            if (!audioBySource.has(clip.sourceUrl)) audioBySource.set(clip.sourceUrl, {
                id: 'audio-' + (audioBySource.size + 1), sourceUrl: clip.sourceUrl, questionIds: [],
            });
            const audio = audioBySource.get(clip.sourceUrl);
            for (const item of matched) {
                if (assigned.has(item.id)) fail('EXAM_MULTIPLE_AUDIO_PER_QUESTION_UNRESOLVED');
                assigned.add(item.id);
                audio.questionIds.push(item.id);
            }
        }
    }

    for (const audio of audioBySource.values()) {
        const rows = audio.questionIds.map(id => map.find(item => item.id === id));
        const numbered = rows.filter(item => present(item.audioNumber));
        if (numbered.some(item => !positiveInteger(item.audioNumber)) ||
            new Set(numbered.map(item => item.audioNumber)).size !== numbered.length)
            fail('EXAM_AUDIO_QUESTION_NUMBERS_UNRESOLVED');
        // Legacy callers may use this function for mapping only and omit every
        // question number. Once numbering is provided, gaps cannot be guessed.
        const requireNumbers = options.requireQuestionNumbers === true || numbered.length > 0;
        if (requireNumbers && rows.some(item => item.pageQuestion !== true && !positiveInteger(item.audioNumber)))
            fail('EXAM_AUDIO_QUESTION_NUMBERS_UNRESOLVED');
    }
    return [...audioBySource.values()];
}
