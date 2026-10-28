import type { OutcomeKind, ThreadOutcomeBadge, ThreadScoreBadge } from '@pi-kit/protocol';
import type { OutcomeRow } from '../db/outcomes.repository';

/**
 * The rules that decide whose outcome a commit is. Pure, so every edge case is a unit test: the service only gathers the facts
 * (the commit's files, the threads of the folder and the files each one touched) and calls these.
 */

/** A thread of the folder a commit was made in, as the attribution sees it. */
export interface Candidate {
  threadId: string;
  /** The files the thread touched before the commit was made (its change baselines), relative to the folder. */
  touched: ReadonlySet<string>;
  /** The thread's session is open in the app right now. */
  open: boolean;
  /** The thread ran last in this folder (the newest run among the threads that work there). */
  lastToRun: boolean;
  /** When the thread's latest run started; breaks a tie. 0 for a thread that never ran here. */
  lastRunAt: number;
}

/** How many of the commit's files the thread touched. */
export function overlap(files: readonly string[], touched: ReadonlySet<string>): number {
  let n = 0;
  for (const file of files) if (touched.has(file)) n += 1;
  return n;
}

/**
 * The thread a commit belongs to: among the threads that are open or ran last in the folder and touched at least one of the committed files, the one
 * with the largest overlap; a tie goes to the thread that ran most recently, a further tie to the lexically first id (so the answer never depends on
 * the order of the list). No overlap, no outcome: `undefined`.
 */
export function attribute(files: readonly string[], candidates: readonly Candidate[]): string | undefined {
  let best: { id: string; overlap: number; lastRunAt: number } | undefined;
  for (const candidate of candidates) {
    if (!candidate.open && !candidate.lastToRun) continue;
    const n = overlap(files, candidate.touched);
    if (n === 0) continue;
    if (
      !best ||
      n > best.overlap ||
      (n === best.overlap &&
        (candidate.lastRunAt > best.lastRunAt ||
          (candidate.lastRunAt === best.lastRunAt && candidate.threadId < best.id)))
    ) {
      best = { id: candidate.threadId, overlap: n, lastRunAt: candidate.lastRunAt };
    }
  }
  return best?.id;
}

/** What a finished piece of work reports to the store. */
export interface Incoming {
  threadId: string;
  kind: OutcomeKind;
  base: string;
  head: string;
  merge?: string | null;
  prUrl?: string | null;
  at: number;
  files: readonly string[];
}

const union = (a: readonly string[], b: readonly string[]): string[] => [...new Set([...a, ...b])];

/**
 * The outcome a thread has after `incoming`, or `undefined` when nothing changes. A merge or a pull request always replaces what the thread had (the
 * latest of the two wins). A commit becomes the outcome of a thread that has none, extends a `committed` outcome (the head moves, the files grow, the
 * base stays where the first commit put it) and never replaces a merge or a pull request.
 */
export function nextOutcome(
  existing: OutcomeRow | undefined,
  incoming: Incoming,
): Omit<OutcomeRow, 'scores' | 'hunkLabels'> | undefined {
  if (incoming.kind !== 'committed') {
    return {
      threadId: incoming.threadId,
      kind: incoming.kind,
      baseCommit: incoming.base,
      headCommit: incoming.head,
      mergeCommit: incoming.merge ?? null,
      prUrl: incoming.prUrl ?? null,
      at: incoming.at,
      files: [...incoming.files],
    };
  }
  if (existing && existing.kind !== 'committed') return undefined;
  if (existing && existing.headCommit === incoming.head) return undefined;
  return {
    threadId: incoming.threadId,
    kind: 'committed',
    baseCommit: existing?.baseCommit ?? incoming.base,
    headCommit: incoming.head,
    mergeCommit: null,
    prUrl: null,
    at: Math.max(incoming.at, existing?.at ?? 0),
    files: union(existing?.files ?? [], incoming.files),
  };
}

/** The reflog subjects of a `HEAD` move that made commits (as opposed to a checkout, a reset or a branch switch). */
const COMMIT_SUBJECT = /^(commit|merge|cherry-pick|revert|rebase|pull)\b/;

export function isCommitSubject(subject: string): boolean {
  return COMMIT_SUBJECT.test(subject.trim());
}

/** The badge the thread state carries for an outcome row. */
export function outcomeBadge(row: OutcomeRow | undefined, score?: ThreadScoreBadge): ThreadOutcomeBadge | null {
  if (!row) return null;
  return {
    kind: row.kind,
    head: row.headCommit,
    at: row.at,
    ...(row.prUrl ? { url: row.prUrl } : {}),
    ...(score ? { score } : {}),
  };
}

/** The git empty tree: what a root commit's "base" is, so `git diff <empty>..<head>` shows everything the commit added. */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
