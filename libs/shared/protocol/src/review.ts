import { z } from 'zod';
import { FileStatusSchema } from './diff-model';

/**
 * Changes and review comments: the two sources of the Changes panel, the REST shapes around
 * them, and the structured comment batch that travels with a prompt (`forwardedProps.review`) and is recorded in
 * the pi session as a `custom` entry.
 */

/**
 * "This thread": files touched by `edit` / `write` calls of the thread. "Working tree": `git diff` of the folder. "Outcome": `git diff base..head` of the
 * thread's outcome, committed history that cannot be reverted or staged.
 */
export const ChangeSourceSchema = z.enum(['thread', 'worktree', 'outcome']);
export type ChangeSource = z.infer<typeof ChangeSourceSchema>;
/** The sources whose files can be reverted and staged: the two that are about the files on disk. */
export const EditableSourceSchema = z.enum(['thread', 'worktree']);
export type EditableSource = z.infer<typeof EditableSourceSchema>;

export const ChangedFileSchema = z
  .object({
    /** Relative to the thread's folder, with `/` separators. */
    path: z.string(),
    status: FileStatusSchema,
    added: z.number().int(),
    removed: z.number().int(),
    binary: z.boolean().optional(),
    /** "This thread": the 1-based number of the thread's run that first changed the file. */
    run: z.number().int().optional(),
    /** "Working tree": the file has unresolved merge conflicts (a sync with the base stopped on it); the viewer shows it with its markers. */
    conflict: z.boolean().optional(),
  })
  .meta({ id: 'ChangedFile' });
export type ChangedFile = z.infer<typeof ChangedFileSchema>;

export const ChangesListSchema = z
  .object({
    source: ChangeSourceSchema,
    cwd: z.string(),
    /** The folder is inside a git work tree (so "Working tree", revert to HEAD and staging exist). */
    git: z.boolean(),
    files: z.array(ChangedFileSchema),
    /** Said above the list ("Not a git repository", "Showing the first 300 files"). */
    note: z.string().optional(),
  })
  .meta({ id: 'ChangesList' });
export type ChangesList = z.infer<typeof ChangesListSchema>;

export const RevertRequestSchema = z
  .object({ file: z.string().min(1), source: EditableSourceSchema, confirm: z.literal(true) })
  .strict()
  .meta({ id: 'RevertRequest' });
export type RevertRequest = z.infer<typeof RevertRequestSchema>;
export const StageRequestSchema = z
  .object({ source: EditableSourceSchema, files: z.array(z.string().min(1)).optional() })
  .strict()
  .meta({ id: 'StageRequest' });
export type StageRequest = z.infer<typeof StageRequestSchema>;
export const OpenPathRequestSchema = z
  .object({ path: z.string().min(1) })
  .strict()
  .meta({ id: 'OpenPathRequest' });
export const OpenPathResultSchema = z
  .object({ opened: z.boolean(), reason: z.string().optional() })
  .meta({ id: 'OpenPathResult' });
export type OpenPathResult = z.infer<typeof OpenPathResultSchema>;

export const ReviewCommentSchema = z
  .object({
    id: z.string().min(1),
    /** Relative to the thread's folder. */
    file: z.string().min(1),
    /** `old` is a line of the file before the change (a removed line), `new` a line of the file now. */
    side: z.enum(['old', 'new']),
    line: z.number().int().min(0),
    /** The last line of a comment that covers a range (inclusive, same side); absent for a single line. */
    endLine: z.number().int().min(0).optional(),
    /** The text of the line (or lines, joined with newlines), so pi (and a reader of the transcript) sees what was meant even after the file moved on. */
    snippet: z.string(),
    text: z.string().min(1),
  })
  .meta({ id: 'ReviewComment' });
export type ReviewComment = z.infer<typeof ReviewCommentSchema>;

/** `forwardedProps.review` of a run, and the `data` of the `pi-kit.review` custom entry. */
export const ReviewBatchSchema = z.object({ comments: z.array(ReviewCommentSchema).min(1).max(200) });
export type ReviewBatch = z.infer<typeof ReviewBatchSchema>;

/** `PUT /api/threads/:id/review-comments`: the whole pending batch (the renderer's state, mirrored). */
export const PutReviewCommentsSchema = z
  .object({ comments: z.array(ReviewCommentSchema).max(200) })
  .meta({ id: 'PutReviewComments' });

export const REVIEW_ENTRY_TYPE = 'pi-kit.review';

/** Reads `forwardedProps.review`; anything that is not a valid batch is ignored (the prompt still runs). */
export function reviewBatchOf(forwardedProps: unknown): ReviewBatch | undefined {
  const raw = (forwardedProps as { review?: unknown } | undefined)?.review;
  const parsed = ReviewBatchSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

/** `GET /api/threads/:id/changes?source=` and `.../changes/:file?source=`: `thread` unless said otherwise. */
export const ChangesQuerySchema = z.object({ source: ChangeSourceSchema.default('thread') });

/** `POST /api/threads/:id/stage`: how many files were staged. */
export const StageResultSchema = z.object({ staged: z.number().int() }).meta({ id: 'StageResult' });
export type StageResult = z.infer<typeof StageResultSchema>;
