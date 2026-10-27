// The arithmetic of @pi-kit/meat-proxy. Plain ESM, no dependencies; pi-kit's backend loads this file from the installed package to recompute a score when the person
// relabels a hunk, so there is one implementation of the sum.
//
// A label entry is `{ id, file, header, label, input, turn?, trace, lines, excerpt?, by, was? }`:
//   label  specified | corrected | autonomous | manual
//   input  what the hunk traces to: first-prompt | follow-up | review | hand | dialog | chip | person | none
//   lines  the hunk's weight: lines added plus lines removed
//   by     model (the attendant's model), ledger (a rule: a file only the person's hand touched), default (the model said nothing about it), person (relabelled by hand)
//   was    the label before the person changed it

export const LABELS = ['specified', 'corrected', 'autonomous', 'manual'];
/** The labels that count as the person's: they said it, corrected it, or did it themselves. */
export const STEERED = ['specified', 'corrected', 'manual'];
export const INPUTS = ['first-prompt', 'follow-up', 'review', 'hand', 'dialog', 'chip', 'person', 'none'];

/** The label entries as they stand: the model's, with the person's corrections laid over them (`stored` is `thread_outcomes.hunk_labels`). */
export function effectiveLabels(stored) {
  if (!stored || !Array.isArray(stored.labels)) return [];
  const corrections = stored.corrections ?? {};
  return stored.labels.map((entry) => {
    const fix = corrections[entry.id];
    if (!fix) return entry;
    return { ...entry, label: fix.label, was: fix.was ?? entry.label, by: 'person', input: STEERED.includes(fix.label) ? (entry.input === 'none' ? 'person' : entry.input) : 'none' };
  });
}

const share = (part, whole) => (whole === 0 ? 0 : Math.round((part / whole) * 100));

const PARTS = [
  ['first-prompt', (n) => `${n} by the first prompt`],
  ['follow-up', (n) => `${n} by later prompts`],
  ['review', (n) => `${n} by review comments`],
  ['hand', (n) => `${n} by hand`],
  ['dialog', (n) => `${n} by dialog answers`],
  ['chip', (n) => `${n} by skill chips`],
  ['person', (n) => `${n} by your relabelling`],
];

/** "62 % steered: 14 of 23 hunks, 9 by the first prompt, 3 by review comments, 2 by hand" — never a bare number. */
export function describeScore(scores) {
  const parts = PARTS.filter(([key]) => (scores.byInput[key] ?? 0) > 0).map(([key, say]) => say(scores.byInput[key]));
  const other = scores.steered - PARTS.reduce((n, [key]) => n + (scores.byInput[key] ?? 0), 0);
  if (other > 0) parts.push(`${other} by other input`);
  return `${scores.meat} % steered: ${scores.steered} of ${scores.hunks} ${scores.hunks === 1 ? 'hunk' : 'hunks'}${parts.length > 0 ? `, ${parts.join(', ')}` : ''}`;
}

/**
 * The Meat Proxy Score of a set of label entries: the share of changed lines in hunks labelled specified, corrected or manual, rounded to whole percent; the Vibe Score is the rest.
 * `null` when there is nothing to weigh (no text hunks). The result carries its inputs: counts by label, steered hunks by what they trace to, and the sentence that says it.
 */
export function computeScores(entries) {
  const hunks = entries.filter((e) => LABELS.includes(e.label));
  const lines = hunks.reduce((n, e) => n + Math.max(0, e.lines ?? 0), 0);
  if (hunks.length === 0 || lines === 0) return null;
  const byLabel = Object.fromEntries(LABELS.map((l) => [l, { hunks: 0, lines: 0 }]));
  const byInput = {};
  let steeredLines = 0;
  let steered = 0;
  for (const e of hunks) {
    const weight = Math.max(0, e.lines ?? 0);
    byLabel[e.label].hunks += 1;
    byLabel[e.label].lines += weight;
    if (!STEERED.includes(e.label)) continue;
    steered += 1;
    steeredLines += weight;
    const input = INPUTS.includes(e.input) && e.input !== 'none' ? e.input : 'other';
    byInput[input] = (byInput[input] ?? 0) + 1;
  }
  const meat = share(steeredLines, lines);
  const scores = { meat, vibe: 100 - meat, hunks: hunks.length, steered, lines, steeredLines, byLabel, byInput };
  return { ...scores, line: describeScore(scores) };
}
