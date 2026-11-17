import { join } from 'node:path';
import { digest, atomicJson, optionalJson } from '../listening/transcript-store.mjs';
import { fetchPracticeAudio } from '../listening/fetch-audio.mjs';
import { prepareListening } from '../listening/pipeline.mjs';
import { groupExamQuestions } from './exam-question-groups.mjs';
import { buildListeningQuestions } from '../listening/contracts.mjs';

export async function prepareExamListening(snapshot, options) {
    const sourceIds = snapshot.map.filter(row => row.audioIds.length).map(row => row.id);
    if (!sourceIds.length) return [];
    if (options.enabled === false) throw new Error('LISTENING_DISABLED_FOR_THIS_EXAM');
    const originalQuestions = sourceIds.map((id, index) => ({ ...snapshot.questions[id - 1], id: index + 1 }));
    groupExamQuestions(originalQuestions.map((question,index) => ({sourceId:sourceIds[index],question})), 'listening');
    // ASR uses question text and number expectations, not image attachments.
    // Preserve the attachments separately until model batches are formed so
    // the model's whole-batch image limits cannot block audio preparation.
    const questions = originalQuestions.map(({images,...question}) => question);
    const localId = id => sourceIds.indexOf(id) + 1;
    const manifest = { schemaVersion: 1, purpose: 'listening-practice', questions, unresolved: [],
        audio: snapshot.audio.map(audio => ({ ...audio, questionIds: audio.questionIds.map(localId),
            path: audio.id + '.wav',
            expectations: options.expectations?.[audio.id] ?
                options.expectations[audio.id].map(row => ({ ...row, questionId: localId(row.questionId) })) :
                audio.questionIds.map(id => {
                    const map = snapshot.map.find(row => row.id === id);
                    return map.pageQuestion ? { questionId: localId(id), source: 'page' } :
                        { questionId: localId(id), source: 'audio', number: map.audioNumber };
                }) })) };
    // Signed URLs are never logged. A changed source is re-downloaded before
    // content-hash ASR reuse, so an old local file cannot stand in for new audio.
    const materialKey = digest({ paper: snapshot.fingerprint,
        sources: snapshot.audio.map(({ id, sourceUrl }) => ({ id, sourceUrl })) });
    const destination = join(options.directory, 'materials-' + materialKey.slice(0, 24));
    let local = await optionalJson(join(destination, 'practice.json'));
    if (!local) local = await fetchPracticeAudio(manifest, destination, { extraHosts: options.audioHosts || [],
        signal: options.signal, fetchImpl: options.fetchImpl });
    // The source URL is transient. Persist only downloaded paths and the current
    // exact question/expectation map, which is revalidated by prepareListening.
    local = { ...local, questions: manifest.questions, audio: local.audio.map(audio => ({
        ...audio, questionIds: manifest.audio.find(row => row.id === audio.id)?.questionIds,
        expectations: manifest.audio.find(row => row.id === audio.id)?.expectations,
    })) };
    await atomicJson(join(destination, 'practice.json'), local);
    const prepared = await prepareListening(local, { ...options, baseDir: destination,
        cacheDir: options.cacheDir || join(options.directory, 'transcripts') });
    const materialQuestions = buildListeningQuestions(local, prepared.transcripts).map((question,index) =>
        originalQuestions[index].images ? {...question,images:originalQuestions[index].images} : question);
    return groupExamQuestions(materialQuestions.map((question, i) => ({sourceId:sourceIds[i], question})), 'listening').map(group => ({ ...group, materialStats: {
        elapsedMs: prepared.elapsedMs, concurrency: prepared.concurrency,
        cacheHits: prepared.audio.filter(row => row.cached).length } }));
}
