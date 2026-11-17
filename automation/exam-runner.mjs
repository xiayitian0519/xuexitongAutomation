import { join } from 'node:path';
import { atomicJson, optionalJson, digest, withFileLock } from '../listening/transcript-store.mjs';
import { validQuestions, validateAnswers } from '../deepseek-console/answer-contract.mjs';
// The existing Edge owner is long-lived. A release suffix loads this release's
// changed dependencies without reopening the browser or resetting its session.
import { ExamPage } from './exam-page.mjs?result-continuity-v4';
import { ExamAnswerAdapter } from './exam-answer-adapter.mjs?material-recovery-v1';
import { prepareExamListening } from './exam-materials.mjs?material-recovery-v1';
import { checkAbort, delay, until } from './workflow-state.mjs';
import { groupExamQuestions } from './exam-question-groups.mjs';
import { saveGroupReceipt, loadGroupReceipt, inspectStoredGroup } from './exam-model-recovery.mjs';

export const EXAM_WORKFLOW_REVISION = '2026-11-17-material-recovery-v1';

export function textGroups(snapshot) {
    return groupExamQuestions(snapshot.map.filter(row => !row.audioIds.length).map(row => ({
        sourceId: row.id, question: snapshot.questions[row.id - 1],
    })), 'text');
}

export async function runExam(options) {
    const { page, identity, directory, signal } = options;
    if (!directory) throw new Error('EXAM_PRIVATE_DIRECTORY_REQUIRED');
    const journalFile = join(directory, 'exam-checkpoint.json');
    return withFileLock(join(directory, 'exam-writer.lock'), async () => {
        const adapter = options.answerAdapter || new ExamAnswerAdapter(page, { signal, imageOptions: {
            cacheDirectory: join(directory, 'image-cache'), onEvent: row => event(row.phase, {status:row.status}),
        } });
        const now = options.now || Date.now;
        const identityKey = digest(identity);
        const state = await optionalJson(journalFile) || { version: 1, identityKey, phase: 'preflight',
            actions: [], groups: {}, events: [], enteredAt: null, minimumMinutes: null, completion: null };
        if (state.version !== 1 || state.identityKey !== identityKey || !Array.isArray(state.actions) ||
            !state.groups || typeof state.groups !== 'object' || Array.isArray(state.groups) || !Array.isArray(state.events)) throw new Error('EXAM_CHECKPOINT_INVALID');
        const api = options.pageAdapter || new ExamPage(page, identity, { signal, verifiedResultRecovery: state.persisted?.confirmed === true && state.actions.some(row => row.action === 'submit' && row.outcome === 'state-confirmed') });
        let saveTail = Promise.resolve();
        const save = () => {
            const snapshot = structuredClone(state);
            const pending = saveTail.then(() => atomicJson(journalFile, snapshot));
            saveTail = pending.catch(() => {});
            return pending;
        };
        const event = async (phase, details = {}) => {
            state.phase = phase;
            const row = { phase, at: new Date(now()).toISOString(), ...details };
            state.events.push(row); await save();
            try { await options.onEvent?.(row); }
            catch { state.telemetryWarning = 'EVENT_CONSUMER_FAILED'; await save(); }
        };
        const observe = async () => {
            checkAbort(signal);
            const view = await api.observe();
            if (!view.identityMatches) throw new Error('EXAM_IDENTITY_MISMATCH');
            if (view.kind === 'human-verification') throw new Error('HUMAN_VERIFICATION_REQUIRED');
            return view;
        };
        let submitGuard = () => {};
        const advance = async (action, acceptable) => {
            checkAbort(signal);
            const before = await observe();
            if (acceptable(before)) return before;
            const previous = state.actions.find(row => row.action === action && row.outcome === 'unknown');
            if (previous && ['submit', 'submit-confirm'].includes(action)) throw new Error('SUBMIT_OUTCOME_UNKNOWN');
            if (['submit', 'submit-confirm'].includes(action)) submitGuard();
            const entry = { action, at: new Date(now()).toISOString(), outcome: 'unknown', actor: 'unknown' };
            state.actions.push(entry); await save();
            let result;
            try { result = await api.click(action); }
            catch (error) {
                if (/CONTROL_AMBIGUOUS|CONTROL_DISABLED|IDENTITY_MISMATCH/.test(error.message)) entry.outcome = 'not-sent';
                await save(); throw error;
            }
            const view = acceptable(result.state) ? result.state :
                await until(observe, acceptable, { signal, timeoutMs: options.observationTimeoutMs ?? 5000 });
            entry.outcome = 'state-confirmed';
            entry.actor = result.performed ? 'automation' : 'unknown';
            entry.clickError = result.error || null;
            await event('action-confirmed', { action, actor: entry.actor });
            return view;
        };
        const finish = async view => {
            if (!view.result?.confirmed) throw new Error('SUBMISSION_EVIDENCE_MISSING');
            if (!state.completion) {
                const readyGroups = Object.values(state.groups).filter(group => group.status === 'ready');
                const chargedGroups = Object.values(state.groups).filter(group => group.status === 'ready' || group.receipt);
                const creditKnown = chargedGroups.every(group => Number.isFinite(group.usage?.credit) && group.usage.credit >= 0);
                state.completion = { key: digest({ identityKey, enteredAt: state.enteredAt }), identity,
                    submitted: true, score: view.result.score ?? null, confirmedAt: new Date(now()).toISOString(),
                    persistedAnswers: state.persisted?.answers ?? null, modelCalls: chargedGroups.length,
                    uncertainModelCalls: Object.values(state.groups).filter(group => group.status === 'request-started').length,
                    observedCredit: creditKnown ? chargedGroups.reduce((total, group) => total + group.usage.credit, 0) : null,
                    manualInterventions: state.actions.filter(row => row.actor === 'manual').length + (state.manualVerifications?.length || 0),
                    unknownActions: state.actions.filter(row => row.actor === 'unknown').length,
                    initialPageState: state.initialPageState || 'unknown',
                    fullyAutomated: ['consent', 'entry', 'entry-confirm', 'submit', 'submit-confirm']
                        .every(action => state.actions.some(row => row.action === action && row.actor === 'automation')) &&
                        !state.actions.some(row => row.actor === 'manual' || row.actor === 'unknown') && !state.manualVerifications?.length };
            }
            await event('submitted-confirmed');
            // Durable outbox first; callback is the current conversation's
            // completion consumer. Reporting never precedes this notification.
            await atomicJson(join(directory, 'completion-event.json'), state.completion);
            if (!state.notification) {
                state.notification = 'pending'; await save();
                try {
                    await options.onCompletion?.(state.completion);
                    state.notification = options.onCompletion ? 'delivered' : 'ready-for-reader';
                } catch { state.notification = 'delivery-unknown'; }
                await save();
            }
            if (!state.reportedAt) {
                try {
                    if (options.archive) await options.archive(state.completion);
                    else await atomicJson(join(directory, 'result.json'), { ...state.completion,
                        usage: Object.values(state.groups).map(group => group.usage ?? null) });
                    state.reportedAt = new Date(now()).toISOString();
                    await event('reported');
                } catch { state.reportWarning = 'REPORT_NOT_ARCHIVED'; await save(); }
            }
            return { ...state.completion, phase: state.phase, notification: state.notification, reportWarning: state.reportWarning || null };
        };
        try {
            let view = await observe();
            if (!state.initialPageState) { state.initialPageState = view.kind; await save(); }
            if (options.manualActions?.length) {
                for (const row of options.manualActions) {
                    if (!['consent', 'entry', 'entry-confirm', 'submit', 'submit-confirm'].includes(row.action) || !Number.isFinite(Date.parse(row.at))) throw new Error('INVALID_MANUAL_ACTION_RECORD');
                    if (!state.actions.some(old => old.actor === 'manual' && old.action === row.action && old.at === row.at))
                        state.actions.push({ action: row.action, at: row.at, actor: 'manual', outcome: 'reported-by-user' });
                }
                await save();
            }
            if (view.kind === 'submitted') return finish(view);
            if (state.completion) throw new Error('COMPLETION_REQUIRES_PLATFORM_RECHECK');
            if (options.minimumMinutes !== undefined && (!Number.isFinite(options.minimumMinutes) || options.minimumMinutes < 0 || options.minimumMinutes > 1440))
                throw new Error('INVALID_MINIMUM_SUBMIT_MINUTES');
            state.minimumMinutes = Math.max(view.minimumMinutes ?? 0, options.minimumMinutes ?? 0, state.minimumMinutes ?? 0);
            const initialDeadline = options.deadline ? Date.parse(options.deadline) : Infinity;
            if (Number.isNaN(initialDeadline) || now() >= initialDeadline) throw new Error('EXAM_DEADLINE_REACHED');
            if (['entry-ready', 'entry-confirmation'].includes(view.kind) && now() + state.minimumMinutes * 60000 > initialDeadline)
                throw new Error('EXAM_DEADLINE_REACHED');
            await options.preflight?.(); // No model probe is needed.
            if (view.kind === 'entry-ready') {
                await event('entry-ready');
                if (view.consent?.length) view = await advance('consent', row => row.kind !== 'entry-ready' || row.consent.length === 1 && row.consent[0].checked);
                if (view.kind === 'entry-ready') view = await advance('entry', row => ['entry-confirmation', 'in-exam', 'submitted'].includes(row.kind));
            }
            if (view.kind === 'entry-confirmation') {
                await event('entry-confirmation');
                view = await advance('entry-confirm', row => ['in-exam', 'submitted'].includes(row.kind));
            }
            if (view.kind === 'submitted') return finish(view);
            if (view.kind === 'submit-confirmation') {
                if (!state.persisted || !state.answers || !state.snapshot) throw new Error('SUBMIT_CHECKPOINT_MISSING');
            } else {
                if (view.kind !== 'in-exam') throw new Error('EXAM_PAGE_UNSUPPORTED');
                if (!state.enteredAt) { state.enteredAt = new Date(now()).toISOString(); await event('in-exam'); }
                if (state.actions.some(row => ['submit', 'submit-confirm'].includes(row.action) && row.outcome === 'unknown')) throw new Error('SUBMIT_OUTCOME_UNKNOWN');
                if (adapter.openWholePaper) {
                    const whole = await adapter.openWholePaper();
                    if (!whole.wholePaper) throw new Error('EXAM_WHOLE_PAPER_UNCONFIRMED');
                    if (whole.page && !options.pageAdapter) api.page = whole.page;
                    await observe(); // Recheck identity on a possible overview popup.
                    await event('whole-paper-confirmed', { source: whole.source });
                }
                if (state.fingerprint && state.failure && adapter.refresh) await adapter.refresh();
                await event('paper-extract-started');
                const snapshot = await adapter.extract();
                if (state.fingerprint && state.fingerprint !== snapshot.fingerprint) throw new Error('EXAM_CHANGED_SINCE_CHECKPOINT');
                groupExamQuestions(snapshot.questions.map(question => ({sourceId:question.id,question})), 'paper');
                const plannedTextGroups = textGroups(snapshot);
                state.fingerprint = snapshot.fingerprint;
                state.snapshot = { ...snapshot, audio: snapshot.audio.map(({ sourceUrl, ...audio }) => audio) };
                await event('paper-materials-checked', {questions:snapshot.questions.length, audio:snapshot.audio.length,
                    imageReferences:snapshot.questions.reduce((count,q)=>count+(q.images?.length||0),0)});
                let requestTail = Promise.resolve(), executionFailure = null;
                const requestGroup = group => {
                    const task = requestTail.then(async () => {
                        checkAbort(signal);
                        if (executionFailure) throw new Error('PREVIOUS_GROUP_FAILED');
                        if (!validQuestions(group.questions) || group.questions.length !== group.sourceIds.length) throw new Error('EXAM_GROUP_INVALID');
                        const key = digest({ sourceIds: group.sourceIds, questions: group.questions });
                        if (Object.entries(state.groups).some(([previousKey, groupState]) => groupState.name === group.name && previousKey !== key))
                            throw new Error('EXAM_GROUP_MATERIAL_CHANGED');
                        let previous = state.groups[key];
                        // The receipt file is written before validation/checkpoint updates.
                        // Discovering it also recovers a crash in that small local gap.
                        const record = await loadGroupReceipt(directory, key, identityKey, previous?.receipt);
                        let answers;
                        if (previous?.status === 'ready') answers = validateAnswers(group.questions, previous.answers);
                        else if (record) {
                            const recovered = inspectStoredGroup(group.questions, record);
                            state.groups[key] = { ...previous, name: group.name, status: recovered.complete ? 'ready' : 'known-validation-failed',
                                receipt: {key,sha256:record.sha256}, usage: recovered.meta, answers: recovered.answers,
                                invalidIds: recovered.invalidIds, recoveredLocally: true };
                            await event(recovered.complete ? 'model-recovered' : 'model-needs-review', { group: group.name, count: recovered.answers.length });
                            if (!recovered.complete) throw new Error('MODEL_ANSWERS_NEED_REVIEW');
                            answers = recovered.answers;
                        } else {
                            if (previous || Object.values(state.groups).some(row => row.status === 'request-started')) throw new Error('MODEL_OUTCOME_UNKNOWN');
                            state.groups[key] = { name: group.name, status: 'request-started', at: new Date(now()).toISOString() };
                            await event('model-started', { group: group.name });
                            let usage = null;
                            const requester = options.requester || (await import('../deepseek-console/wb-cli-request.mjs?receipts-v1')).requestAnswers;
                            try {
                                answers = validateAnswers(group.questions, await requester(group.questions, undefined, {
                                    signal, onMeta: meta => { usage = meta; },
                                    onReceipt: async receipt => {
                                        const reference = await saveGroupReceipt(directory, key, identityKey, receipt);
                                        state.groups[key] = { ...state.groups[key], receipt: reference, usage: receipt.meta,
                                            status: receipt.execution?.status === 'completed' ? 'response-received' : 'request-started' };
                                        await event('model-response-retained', { group: group.name });
                                    },
                                }));
                            } catch (error) {
                                const retained = await loadGroupReceipt(directory, key, identityKey, state.groups[key]?.receipt);
                                if (retained?.receipt.execution?.status === 'completed') {
                                    const checked = inspectStoredGroup(group.questions, retained);
                                    state.groups[key] = { ...state.groups[key], status: checked.complete ? 'response-received' : 'known-validation-failed',
                                        usage: checked.meta, answers: checked.answers, invalidIds: checked.invalidIds };
                                    await event('model-validation-stopped', { group: group.name, count: checked.answers.length });
                                }
                                throw error;
                            }
                            state.groups[key] = { ...state.groups[key], name: group.name, status: 'ready', answers, usage: usage || state.groups[key].usage };
                            await event('model-ready', { group: group.name, count: answers.length });
                        }
                        const mapped = answers.map(answer => ({ ...answer, id: group.sourceIds[answer.id - 1] }));
                        // A save failure retains the validated model answers.
                        await adapter.fill(snapshot, mapped);
                        await event('group-saved', { group: group.name, count: mapped.length });
                        return mapped;
                    });
                    requestTail = task.catch(error => { executionFailure = error; });
                    return task;
                };
                const listeningOptions = { ...options.listening, directory, signal,
                    onEvent: row => event(row.phase, { audioId: row.audioId, start: row.start, end: row.end }) };
                const materialPromise = Promise.resolve().then(() => (options.prepareMaterials || prepareExamListening)(snapshot, listeningOptions))
                    .catch(error => { executionFailure = error; throw error; });
                // Start materials before text requests; both branches are always
                // observed, even if one fails. Paid requests remain serialized.
                const branches = await Promise.allSettled([
                    (async () => { const answers = []; for (const group of plannedTextGroups) answers.push(...await requestGroup(group)); return answers; })(),
                    (async () => { const answers = []; for (const group of await materialPromise) answers.push(...await requestGroup(group)); return answers; })(),
                ]);
                const errors = branches.filter(row => row.status === 'rejected');
                if (errors.length) throw errors[0].reason;
                const answers = branches.flatMap(row => row.value).sort((a, b) => a.id - b.id);
                if (new Set(answers.map(row => row.id)).size !== snapshot.questions.length || answers.length !== snapshot.questions.length) throw new Error('EXAM_ANSWERS_INCOMPLETE');
                state.answers = answers;
                await event('answers-saved');
                state.persisted = await adapter.verifyPersisted(snapshot, answers);
                if (!state.persisted?.confirmed) throw new Error('EXAM_PERSISTENCE_NOT_CONFIRMED');
                await event('save-verified', { count: state.persisted.answers });
                view = await observe();
            }
            if (view.kind === 'submitted') return finish(view);
            const configured = options.notBefore ? Date.parse(options.notBefore) : 0;
            if (options.notBefore && !Number.isFinite(configured)) throw new Error('INVALID_EARLIEST_SUBMIT_TIME');
            const minimum = Date.parse(state.enteredAt) + (state.minimumMinutes || 0) * 60000;
            const notBefore = Math.max(configured, minimum || 0);
            const deadline = options.deadline ? Date.parse(options.deadline) : Infinity;
            if (options.deadline && !Number.isFinite(deadline)) throw new Error('INVALID_EXAM_DEADLINE');
            if (notBefore > deadline || now() >= deadline) throw new Error('EXAM_DEADLINE_REACHED');
            submitGuard = () => {
                checkAbort(signal);
                if (now() < notBefore) throw new Error('SUBMIT_WINDOW_NOT_OPEN');
                if (now() >= deadline) throw new Error('EXAM_DEADLINE_REACHED');
            };
            while (now() < notBefore) {
                await event('waiting-submit-window', { until: new Date(notBefore).toISOString() });
                await (options.wait || delay)(Math.min(5000, notBefore - now()), signal);
                view = await observe();
                if (view.kind === 'submitted') return finish(view);
            }
            if (now() >= deadline) throw new Error('EXAM_DEADLINE_REACHED');
            if (view.kind === 'in-exam') {
                if (adapter.verifyCurrent) await adapter.verifyCurrent(state.snapshot, state.answers);
                view = await advance('submit', row => ['submit-confirmation', 'submitted'].includes(row.kind));
            }
            if (view.kind === 'submit-confirmation') {
                if (adapter.verifyCurrent) await adapter.verifyCurrent(state.snapshot, state.answers);
                view = await advance('submit-confirm', row => row.kind === 'submitted');
            }
            if (view.kind !== 'submitted') throw new Error('SUBMIT_OUTCOME_UNKNOWN');
            return finish(view);
        } catch (error) {
            // A human action or platform deadline can have advanced the page
            // while a local action failed. Inspect that fact before reporting.
            if (!signal?.aborted) {
                const current = await api.observe().catch(() => null);
                if (current?.identityMatches && current.kind === 'submitted') return finish(current);
            }
            state.failure = /^[A-Z][A-Z0-9_:, -]*$/.test(error.message) ? error.message : 'WORKFLOW_STEP_FAILED';
            await event(signal?.aborted ? 'stopped' : 'needs-review', { code: state.failure });
            throw error;
        }
    });
}
