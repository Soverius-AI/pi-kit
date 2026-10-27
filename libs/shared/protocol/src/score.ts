import { z } from 'zod';

/**
 * The Meat Proxy Score and the Vibe Score: the labels of an outcome's hunks and the scores computed from them. The plugin `@pi-kit/meat-proxy` writes them
 * through `pi-kit:thread:annotate`; pi-kit stores them with the outcome (`thread_outcomes.hunk_labels` and `scores`) and draws them, and only draws them while the package
 * is installed. The arithmetic lives in the package (`lib/score.mjs`); pi-kit loads that file to recompute when the person relabels a hunk.
 */

/** What a hunk of the outcome is, in one word. */
export const HunkLabelSchema = z.enum(['specified', 'corrected', 'autonomous', 'manual']);
export type HunkLabel = z.infer<typeof HunkLabelSchema>;
/** The labels that count as the person's: they said it, corrected it, or did it themselves. */
export const STEERED_LABELS: readonly HunkLabel[] = ['specified', 'corrected', 'manual'];

/** What a label traces to: the first message, a later one, review comments, the person's hand, a dialog answer, a skill chip, the person's own relabelling, nothing. */
export const HunkInputSchema = z.enum(['first-prompt', 'follow-up', 'review', 'hand', 'dialog', 'chip', 'person', 'none']);
export type HunkInput = z.infer<typeof HunkInputSchema>;

/**
 * The id of a hunk: its file and the two start lines of its `@@` header exactly as git prints them (`src/a.ts@10:12`). The package and the diff viewer derive it the same way, so a
 * label stored for a hunk finds the hunk on screen.
 */
export const hunkId = (file: string, oldStart: number, newStart: number): string => `${file}@${oldStart}:${newStart}`;

/** One hunk of the outcome diff with its label and what the label traces to. */
export const HunkLabelEntrySchema = z.object({
  id: z.string().min(1).max(600),
  file: z.string().max(500),
  /** `@@ -10,6 +10,8 @@`. */
  header: z.string().max(120),
  label: HunkLabelSchema,
  input: HunkInputSchema,
  /** The message (1-based) the input is, when it is one. */
  turn: z.number().int().positive().optional(),
  /** Why, in the model's words (at most twelve of them) or the rule's. */
  trace: z.string().max(400),
  /** The hunk's weight: lines added plus lines removed. */
  lines: z.number().int().nonnegative(),
  /** The first changed lines, so a correction can be shown to the model as an example. */
  excerpt: z.array(z.string().max(200)).max(5).optional(),
  /** Who decided: the model, a rule of the ledger (a file only the hand changed), the default (the model said nothing), or the person. */
  by: z.enum(['model', 'ledger', 'default', 'person']),
  /** The label before the person changed it. */
  was: HunkLabelSchema.optional(),
}).meta({ id: 'HunkLabelEntry' });
export type HunkLabelEntry = z.infer<typeof HunkLabelEntrySchema>;

const LabelCountSchema = z.object({ hunks: z.number().int().nonnegative(), lines: z.number().int().nonnegative() });

/** The scores of an outcome with the inputs they come from; `line` is the sentence that is shown wherever the score is. */
export const OutcomeScoresSchema = z.object({
  /** Meat Proxy Score: whole percent of the changed lines in specified, corrected and manual hunks. */
  meat: z.number().int().min(0).max(100),
  /** Vibe Score: 100 − meat. */
  vibe: z.number().int().min(0).max(100),
  hunks: z.number().int().nonnegative(),
  steered: z.number().int().nonnegative(),
  lines: z.number().int().nonnegative(),
  steeredLines: z.number().int().nonnegative(),
  byLabel: z.object({ specified: LabelCountSchema, corrected: LabelCountSchema, autonomous: LabelCountSchema, manual: LabelCountSchema }),
  /** The steered hunks by what they trace to (`first-prompt`, `follow-up`, `review`, `hand`, ...). */
  byInput: z.record(z.string(), z.number().int().nonnegative()),
  /** "62 % steered: 14 of 23 hunks, 9 by the first prompt, 3 by review comments, 2 by hand". */
  line: z.string().max(500),
}).meta({ id: 'OutcomeScores' });
export type OutcomeScores = z.infer<typeof OutcomeScoresSchema>;

/** The person's correction of one label; it outlives a new scoring of the thread and is shown to the model as an example the next time. */
export const HunkCorrectionSchema = z.object({
  label: HunkLabelSchema,
  was: HunkLabelSchema,
  file: z.string().max(500),
  header: z.string().max(120),
  excerpt: z.array(z.string().max(200)).max(5).optional(),
  at: z.number(),
});
export type HunkCorrection = z.infer<typeof HunkCorrectionSchema>;

/** `thread_outcomes.hunk_labels`: what the plugin labelled (for the outcome `base..head` at `at`), and the person's corrections. */
export const HunkLabelsStoreSchema = z.object({
  base: z.string(),
  head: z.string(),
  model: z.string().nullable(),
  at: z.number(),
  labels: z.array(HunkLabelEntrySchema),
  corrections: z.record(z.string(), HunkCorrectionSchema),
});
export type HunkLabelsStore = z.infer<typeof HunkLabelsStoreSchema>;

/** The labels as they stand: the model's with the person's corrections over them. */
export function effectiveHunks(store: Pick<HunkLabelsStore, 'labels' | 'corrections'>): HunkLabelEntry[] {
  return store.labels.map((entry) => {
    const fix = store.corrections[entry.id];
    if (!fix) return entry;
    const steered = STEERED_LABELS.includes(fix.label);
    return { ...entry, label: fix.label, was: fix.was, by: 'person' as const, input: steered ? (entry.input === 'none' ? ('person' as const) : entry.input) : ('none' as const) };
  });
}

/** `GET /api/threads/:id/score`: the scores of the thread's outcome and the label of each hunk, as they stand now. */
export const OutcomeScoreViewSchema = z.object({
  scores: OutcomeScoresSchema,
  hunks: z.array(HunkLabelEntrySchema),
  /** The model that labelled the hunks, `provider/id`; null when no model was needed. */
  model: z.string().nullable(),
  /** When the plugin scored it. */
  at: z.number(),
  /** The outcome moved on (a later commit) since the hunks were labelled: the labels describe `base..head` as it was. */
  stale: z.boolean(),
  base: z.string(),
  head: z.string(),
  /** The hunks the person relabelled. */
  corrected: z.number().int().nonnegative(),
}).meta({ id: 'OutcomeScoreView' });
export type OutcomeScoreView = z.infer<typeof OutcomeScoreViewSchema>;

/**
 * The part of a score the thread state carries: enough for the badge's second line. Its presence says the meat-proxy package is installed (the badge menu offers
 * "Score this thread"); `meat`, `vibe` and `line` are null until the thread has been scored. `stale`: the outcome moved on since the hunks were labelled.
 */
export const ThreadScoreBadgeSchema = z.object({
  meat: z.number().int().min(0).max(100).nullable(),
  vibe: z.number().int().min(0).max(100).nullable(),
  line: z.string().nullable(),
  stale: z.boolean(),
}).meta({ id: 'ThreadScoreBadge' });
export type ThreadScoreBadge = z.infer<typeof ThreadScoreBadgeSchema>;

/** `POST /api/threads/:id/score`: score the thread now. `consent` answers the sentence of an earlier `consent` result (the attendant is off). */
export const RequestScoreSchema = z.object({ consent: z.boolean().optional() }).strict().meta({ id: 'RequestScore' });
export type RequestScore = z.infer<typeof RequestScoreSchema>;

export const ScoreRequestResultSchema = z.object({
  status: z.enum(['scored', 'consent']),
  score: OutcomeScoreViewSchema.optional(),
  /** `consent`: the model the thread would go to. */
  model: z.string().optional(),
  /** `consent`: the sentence the person agrees to. */
  message: z.string().optional(),
}).meta({ id: 'ScoreRequestResult' });
export type ScoreRequestResult = z.infer<typeof ScoreRequestResultSchema>;

/** `POST /api/threads/:id/score/relabel`: the person says what a hunk is. `label: null` takes the correction back. */
export const RelabelHunkSchema = z.object({ hunk: z.string().min(1).max(600), label: HunkLabelSchema.nullable() }).strict().meta({ id: 'RelabelHunk' });
export type RelabelHunk = z.infer<typeof RelabelHunkSchema>;

/** The distribution of a project's scored threads: how many fall in each tenth of the steered share, and the newest ones. */
export const ProjectScoresSchema = z.object({
  cwd: z.string(),
  scored: z.number().int().nonnegative(),
  /** Ten bins: 0–9 %, 10–19 %, ... 90–100 % steered. */
  bins: z.array(z.number().int().nonnegative()).length(10),
  /** The average steered share over the scored threads; null without any. */
  mean: z.number().int().min(0).max(100).nullable(),
  recent: z.array(z.object({ threadId: z.string(), title: z.string().nullable(), meat: z.number().int(), line: z.string(), at: z.number() })),
}).meta({ id: 'ProjectScores' });
export type ProjectScores = z.infer<typeof ProjectScoresSchema>;

export const ScoreOverviewSchema = z.object({
  /** The package is installed in pi; without it nothing is drawn. */
  installed: z.boolean(),
  projects: z.array(ProjectScoresSchema),
}).meta({ id: 'ScoreOverview' });
export type ScoreOverview = z.infer<typeof ScoreOverviewSchema>;
