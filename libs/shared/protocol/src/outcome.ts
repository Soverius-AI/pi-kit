import { z } from 'zod';
import { ThreadScoreBadgeSchema } from './score';

/**
 * How a thread ended: a worktree merged back into its base (`merged`), a pull request opened for the branch (`pr`), or
 * commits made in the thread's folder that contain files the thread changed (`committed`). One outcome per thread; the latest kind of a
 * merge or pull request wins over a commit.
 */
export const OutcomeKindSchema = z.enum(['merged', 'committed', 'pr']);
export type OutcomeKind = z.infer<typeof OutcomeKindSchema>;

/** Where `base` of an outcome comes from: the HEAD the thread started on, or an estimate from the first message's timestamp (a thread older than the outcomes). */
export const BaseSourceSchema = z.enum(['start', 'estimated']);
export type BaseSource = z.infer<typeof BaseSourceSchema>;

/** The part of an outcome the thread state carries: enough for the badge, its tooltip and "Open the pull request". */
export const ThreadOutcomeBadgeSchema = z.object({
  kind: OutcomeKindSchema,
  /** The commit the outcome ends at, in full: the merge commit, the branch tip of a pull request, or the latest attributed commit. */
  head: z.string(),
  /** Epoch milliseconds. */
  at: z.number(),
  /** `pr`: the pull request's address. */
  url: z.string().optional(),
  /** The Meat Proxy Score of the outcome, while the meat-proxy package is installed and has scored the thread. */
  score: ThreadScoreBadgeSchema.optional(),
}).meta({ id: 'ThreadOutcomeBadge' });
export type ThreadOutcomeBadge = z.infer<typeof ThreadOutcomeBadgeSchema>;

/** `GET /api/threads/:id/outcome`: the whole outcome of a thread. The Outcome source of review mode is `git diff base..head` in the thread's folder. */
export const ThreadOutcomeSchema = z.object({
  kind: OutcomeKindSchema,
  /** The commit the thread started from (`merged`: the base tip the merge landed on). */
  base: z.string(),
  head: z.string(),
  /** `merged`: the merge commit on the base branch. */
  merge: z.string().nullable(),
  prUrl: z.string().nullable(),
  at: z.number(),
  /** The files of the outcome, relative to the folder the thread works in. */
  files: z.array(z.string()),
  /** The branch the thread was merged into or cut from (worktree threads). */
  baseBranch: z.string().nullable(),
  /** Is `base` the HEAD the thread started on, or an estimate for a thread that is older than outcomes? */
  baseSource: BaseSourceSchema.nullable(),
}).meta({ id: 'ThreadOutcome' });
export type ThreadOutcome = z.infer<typeof ThreadOutcomeSchema>;
