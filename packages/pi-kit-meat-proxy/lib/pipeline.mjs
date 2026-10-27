// The whole scoring of one thread, written once against a `host` that answers the plugin API's requests: the pi extension's host asks pi-kit over the event bus
// (`extensions/meat-proxy.ts`), pi-kit's backend answers the same questions directly when it scores after an outcome without a pi session. Plain ESM, no dependencies.
//
//   host.outcome()      -> pi-kit:thread:outcome  { diff: true, annotations: true }   { ok, outcome, diff, annotations }
//   host.transcript()   -> pi-kit:thread:transcript                                    { ok, transcript }
//   host.baselines()    -> pi-kit:thread:baselines                                     { ok, files }
//   host.outsideEdits() -> pi-kit:thread:outside-edits                                 { ok, edits }
//   host.run(prompt, progress) -> pi-kit:attendant:run { task: 'score', system, user }  { ok, text, model } | { ok: false, code: 'consent', error, model }
//                          progress is { batch, batches } (1-based): a long diff is labelled in several model calls, and the host can say which one this is.
//   host.annotate(body) -> pi-kit:thread:annotate { base, head, labels, scores, model }
import { attributionBatches, buildAttributionPrompt, buildLabelEntries, parseAttribution } from './attribution.mjs';
import { splitDiff } from './hunks.mjs';
import { buildLedger } from './ledger.mjs';
import { computeScores, effectiveLabels } from './score.mjs';

// pi-kit's backend loads this file from the installed package and uses these two as they are: the arithmetic exists once.
export { computeScores, effectiveLabels };

const fail = (code, error, extra = {}) => ({ ok: false, code, error, ...extra });

/**
 * Scores a thread: reads the records, builds the ledger, asks the model to label the hunks, writes the labels and the scores back. Returns `{ ok: true, scores, labels, model, ledger }` or
 * `{ ok: false, code, error, model? }` (`consent`: the attendant is off and the person has not agreed to send this thread to the model; the caller asks and calls again with a host whose `run` sends `consent: true`).
 */
export async function scoreThread(host) {
  const found = await host.outcome();
  if (!found.ok) return found;
  if (!found.outcome) return fail('not-found', 'This thread has no outcome yet, so there is nothing to score. It gets one when its worktree is merged back, a pull request is opened, or a commit contains files it changed.');
  const hunks = splitDiff(found.diff ?? '');
  if (hunks.length === 0) return fail('invalid', 'The outcome changed no text file, so there is nothing to weigh.');

  const [transcript, baselines, outside] = await Promise.all([host.transcript(), host.baselines(), host.outsideEdits()]);
  for (const reply of [transcript, baselines, outside]) if (!reply.ok) return reply;

  const ledger = buildLedger({ transcript: transcript.transcript, baselines: baselines.files, outsideEdits: outside.edits, hunks });
  let model = null;
  const labels = [];
  // One model call per batch, in diff order; a failed or cancelled call stops here, and nothing of the earlier batches is written.
  const batches = [...attributionBatches(hunks, ledger)];
  for (const [index, batch] of batches.entries()) {
    const prompt = buildAttributionPrompt({ ledger, hunks: batch, stored: found.annotations?.hunkLabels ?? null });
    const keys = prompt.plan.shown.map((shown) => shown.key);
    let parsed = { labels: new Map(), missing: [], unknown: [] };
    if (keys.length > 0) {
      const answer = await host.run({ system: prompt.system, user: prompt.user }, { batch: index + 1, batches: batches.length });
      if (!answer.ok) return answer;
      model = answer.model ?? null;
      parsed = parseAttribution(answer.text, keys);
      if (parsed.missing.length) return fail('failed', `The model did not label ${parsed.missing.length} of ${keys.length} hunks in this batch. No new score was saved.`, { model });
    }
    labels.push(...buildLabelEntries({ plan: prompt.plan, parsed, ledger, hunks: batch }));
  }
  // The person's earlier corrections stay: the score is of the labels as they stand.
  const stored = found.annotations?.hunkLabels ?? null;
  const effective = effectiveLabels({ labels, corrections: stored?.corrections ?? {} });
  const scores = computeScores(effective);
  if (!scores) return fail('invalid', 'The outcome has no changed lines to weigh.');

  const saved = await host.annotate({ base: found.outcome.base, head: found.outcome.head, model, labels, scores });
  if (!saved.ok) return saved;
  return { ok: true, scores, labels: effective, model, ledger };
}
