import { z } from 'zod';
import type { PiDiffHunk } from './activities';

/**
 * The diff model: what `GET /api/threads/:id/changes/:file` returns and what the diff viewer
 * (`libs/shared/ui`) draws. The backend computes it (so the renderer never parses a patch); `hunksToModel` is the one
 * place that turns unified-diff hunks into rows, and the renderer reuses it for the `pi.diff` activity of an
 * `edit` / `write` call in the transcript.
 */

export const DiffRowSchema = z.object({
  kind: z.enum(['ctx', 'add', 'del']),
  /** Line number in the old file; `null` for an added line. */
  oldNo: z.number().int().nullable(),
  /** Line number in the new file; `null` for a removed line. */
  newNo: z.number().int().nullable(),
  /** The line without its leading ` `, `+` or `-`. */
  text: z.string(),
});
export type DiffRow = z.infer<typeof DiffRowSchema>;

/** One row of the split view: a removed line beside the line that replaced it, or a context line on both sides. */
export const SplitRowSchema = z.object({ left: DiffRowSchema.nullable(), right: DiffRowSchema.nullable() });
export type SplitRow = z.infer<typeof SplitRowSchema>;

export const DiffHunkModelSchema = z.object({
  header: z.string(),
  oldStart: z.number().int(),
  oldLines: z.number().int(),
  newStart: z.number().int(),
  newLines: z.number().int(),
  lines: z.array(DiffRowSchema),
  split: z.array(SplitRowSchema),
});
export type DiffHunkModel = z.infer<typeof DiffHunkModelSchema>;

export const FileStatusSchema = z.enum(['M', 'A', 'D']);
export type FileStatus = z.infer<typeof FileStatusSchema>;

/**
 * Where the "before" side of a "This thread" diff came:
 * - `captured`: the file as it was when the first `edit` / `write` of the thread started (the backend read it);
 * - `reconstructed`: rebuilt from the `edit` patches stored in the session file, by undoing them on the file;
 * - `git-head`: the backend has no copy from before pi's edit, so the file is compared with git's `HEAD` instead;
 * - `empty`: no copy and no git, so the whole file is shown as added.
 */
export const BaselineSchema = z.enum(['captured', 'reconstructed', 'git-head', 'empty']);
export type Baseline = z.infer<typeof BaselineSchema>;

export const DiffModelSchema = z.object({
  path: z.string(),
  status: FileStatusSchema,
  added: z.number().int(),
  removed: z.number().int(),
  binary: z.boolean(),
  /** The file is too big to diff here; `hunks` is empty. */
  tooLarge: z.boolean(),
  hunks: z.array(DiffHunkModelSchema),
  baseline: BaselineSchema.optional(),
  /** Said to the user above the diff (a fallback, a binary file, a file that is gone). */
  note: z.string().optional(),
}).meta({ id: 'DiffModel' });
export type DiffModel = z.infer<typeof DiffModelSchema>;

/** Rows for one hunk: numbers the lines from the hunk header and pairs removed lines with the added ones for the split view. */
function hunkRows(hunk: PiDiffHunk): { lines: DiffRow[]; split: SplitRow[] } {
  const lines: DiffRow[] = [];
  let oldNo = hunk.oldStart;
  let newNo = hunk.newStart;
  for (const raw of hunk.lines) {
    const sign = raw[0];
    const text = raw.slice(1);
    if (sign === '+') lines.push({ kind: 'add', oldNo: null, newNo: newNo++, text });
    else if (sign === '-') lines.push({ kind: 'del', oldNo: oldNo++, newNo: null, text });
    else lines.push({ kind: 'ctx', oldNo: oldNo++, newNo: newNo++, text });
  }
  return { lines, split: splitRows(lines) };
}

/** A run of removed lines followed by a run of added ones becomes side-by-side pairs; the longer run overhangs. */
export function splitRows(lines: readonly DiffRow[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let removed: DiffRow[] = [];
  let added: DiffRow[] = [];
  const flush = (): void => {
    const count = Math.max(removed.length, added.length);
    for (let i = 0; i < count; i++) rows.push({ left: removed[i] ?? null, right: added[i] ?? null });
    removed = [];
    added = [];
  };
  for (const line of lines) {
    if (line.kind === 'del') {
      // A removal after additions starts a new pair block.
      if (added.length > 0) flush();
      removed.push(line);
    } else if (line.kind === 'add') {
      added.push(line);
    } else {
      flush();
      rows.push({ left: line, right: line });
    }
  }
  flush();
  return rows;
}

export function hunksToModel(hunks: readonly PiDiffHunk[]): DiffHunkModel[] {
  return hunks.map((hunk) => ({
    header: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
    oldStart: hunk.oldStart,
    oldLines: hunk.oldLines,
    newStart: hunk.newStart,
    newLines: hunk.newLines,
    ...hunkRows(hunk),
  }));
}

export function countChanges(hunks: readonly DiffHunkModel[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.kind === 'add') added += 1;
      else if (line.kind === 'del') removed += 1;
    }
  }
  return { added, removed };
}
