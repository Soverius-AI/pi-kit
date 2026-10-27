import {
  type AnnotateRequest,
  type HunkCorrection,
  type HunkLabel,
  type HunkLabelsStore,
  HunkLabelsStoreSchema,
  type OutcomeScores,
  OutcomeScoresSchema,
  type PiDialogRequest,
  type ProjectScores,
  type ThreadScoreBadge,
  type TranscriptAnswer,
} from '@pi-kit/protocol';
import type { DialogAnswer } from '../pi/ui-bridge';

/**
 * The rules of the Meat Proxy Score that belong to pi-kit: what counts as a change by hand, how the person's relabelling and a new scoring combine, what is
 * stored and drawn. Pure, so every edge case is a unit test. The arithmetic of the score itself is the package's (`lib/score.mjs`).
 */

/** A run that ended this recently still owns the writes the watcher reports: its debounced batch can arrive after the run's end. */
export const RUN_GRACE_MS = 2500;
/** At most this many of the person's corrections are kept per thread. */
export const MAX_CORRECTIONS = 200;

export interface HandEditFacts {
  /** The paths of one watcher batch, relative to the folder. */
  paths: readonly string[];
  /** Some thread's run in this folder is going on. */
  running: boolean;
  /** Milliseconds since the last run in this folder ended; null if none did. */
  sinceRunEnd: number | null;
  /** The batch includes a sign of `HEAD` or a branch moving (a checkout, a pull, a merge): the files changed because git changed them. */
  headMoved: boolean;
}

/** The paths of a watcher batch that are a person's hand: nothing of pi is writing, git did not move, and the path is a file of the project (not `.git`). */
export function handEditedPaths(facts: HandEditFacts): string[] {
  if (facts.running || facts.headMoved) return [];
  if (facts.sinceRunEnd !== null && facts.sinceRunEnd < RUN_GRACE_MS) return [];
  return facts.paths.filter((path) => path !== '' && path !== '.git' && !path.startsWith('.git/'));
}

/** `thread_outcomes.hunk_labels` as stored, or `null` when there is none or it is not what pi-kit writes. */
export function parseLabelsStore(raw: unknown): HunkLabelsStore | null {
  const parsed = HunkLabelsStoreSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export function parseScores(raw: unknown): OutcomeScores | null {
  const parsed = OutcomeScoresSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * What a new scoring does to the stored labels: the package's labels replace the earlier ones, the person's corrections stay (they are the person's, and the next prompt shows them
 * as examples); `null` clears the labels and the corrections with them.
 */
export function mergeLabels(existing: HunkLabelsStore | null, body: Pick<AnnotateRequest, 'base' | 'head' | 'model' | 'labels'>, now: number): HunkLabelsStore | null | undefined {
  if (body.labels === undefined) return undefined;
  if (body.labels === null) return null;
  return { base: body.base, head: body.head, model: body.model ?? null, at: now, labels: body.labels, corrections: existing?.corrections ?? {} };
}

/**
 * The person says what a hunk is. A label that is the model's own is no correction (it takes an earlier one back); `null` takes the correction back. Returns the new store, or
 * `undefined` when the store has no such hunk.
 */
export function relabelHunk(store: HunkLabelsStore, hunk: string, label: HunkLabel | null, now: number): HunkLabelsStore | undefined {
  const entry = store.labels.find((l) => l.id === hunk);
  if (!entry) return undefined;
  const corrections = { ...store.corrections };
  if (label === null || label === entry.label) {
    delete corrections[hunk];
  } else {
    const correction: HunkCorrection = { label, was: entry.label, file: entry.file, header: entry.header, ...(entry.excerpt ? { excerpt: entry.excerpt } : {}), at: now };
    delete corrections[hunk];
    corrections[hunk] = correction;
  }
  // Oldest corrections go first when there are too many.
  const keys = Object.keys(corrections);
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_CORRECTIONS))) delete corrections[key];
  return { ...store, corrections };
}

/**
 * The part of a score the thread state carries while the package is installed: the number and the sentence and whether the outcome moved on since the hunks were labelled, or
 * nulls for a thread that was not scored (the badge's menu then offers "Score this thread").
 */
export function scoreBadgeOf(scores: OutcomeScores | null, store: HunkLabelsStore | null, outcome: { base: string; head: string }): ThreadScoreBadge {
  if (!scores || !store) return { meat: null, vibe: null, line: null, stale: false };
  return { meat: scores.meat, vibe: scores.vibe, line: scores.line, stale: store.head !== outcome.head || store.base !== outcome.base };
}

/** Ten bins of the steered share: 0–9 %, 10–19 %, ... 90–100 %. */
export function histogram(percents: readonly number[]): number[] {
  const bins = Array.from({ length: 10 }, () => 0);
  for (const p of percents) bins[Math.min(9, Math.max(0, Math.floor(p / 10)))] += 1;
  return bins;
}

export interface ScoredThread {
  threadId: string;
  title: string | null;
  cwd: string;
  meat: number;
  line: string;
  at: number;
}

/** The distribution of a project's scored threads: the bins, the mean and the newest ones. */
export function projectScores(cwd: string, scored: readonly ScoredThread[], recent = 8): ProjectScores {
  const mine = scored.filter((s) => s.cwd === cwd);
  const mean = mine.length === 0 ? null : Math.round(mine.reduce((n, s) => n + s.meat, 0) / mine.length);
  return {
    cwd,
    scored: mine.length,
    bins: histogram(mine.map((s) => s.meat)),
    mean,
    recent: [...mine]
      .sort((a, b) => b.at - a.at)
      .slice(0, recent)
      .map((s) => ({ threadId: s.threadId, title: s.title, meat: s.meat, line: s.line, at: s.at })),
  };
}

/** A dialog the person answered, as the ledger keeps it; `undefined` for a method the ledger has no word for. */
export function answerFromDialog(request: PiDialogRequest, answer: DialogAnswer): TranscriptAnswer | undefined {
  const method = request.method;
  if (method !== 'confirm' && method !== 'select' && method !== 'input' && method !== 'editor') return undefined;
  const title = request.title ?? '';
  if (answer.status === 'cancelled') return { method, title, status: 'cancelled' };
  return {
    method,
    title,
    status: 'resolved',
    ...(answer.confirmed !== undefined ? { confirmed: answer.confirmed } : {}),
    ...(answer.value !== undefined ? { value: answer.value.slice(0, 300) } : {}),
  };
}
