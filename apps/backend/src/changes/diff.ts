import { parseUnifiedPatch } from '@pi-kit/pi-adapter';
import { type Baseline, type DiffModel, type FileStatus, type PiDiffHunk, countChanges, hunksToModel } from '@pi-kit/protocol';
import { structuredPatch } from 'diff';

/** Files whose text is longer than this are not diffed here (the viewer says so and offers the editor). */
export const MAX_DIFF_CHARS = 1_000_000;
/** More changed rows than this and the viewer would only slow the page down. */
export const MAX_DIFF_ROWS = 20_000;

/** NUL in the first 8 KB: git's own test for "this is not text". */
export function looksBinary(text: string | Buffer): boolean {
  const head = typeof text === 'string' ? text.slice(0, 8000) : text.subarray(0, 8000).toString('latin1');
  return head.includes('\0');
}

/** Hunks of the difference between two texts, three lines of context, in the unified form `PiDiffHunk` uses. */
export function textHunks(oldText: string, newText: string): PiDiffHunk[] {
  const patch = structuredPatch('a', 'b', oldText, newText, '', '', { context: 3 });
  return patch.hunks.map((hunk) => ({
    oldStart: hunk.oldStart,
    oldLines: hunk.oldLines,
    newStart: hunk.newStart,
    newLines: hunk.newLines,
    // jsdiff keeps git's "\ No newline at end of file" marker as a line of its own.
    lines: hunk.lines.filter((line) => !line.startsWith('\\')),
  }));
}

export interface ModelInput {
  path: string;
  status: FileStatus;
  hunks: PiDiffHunk[];
  baseline?: Baseline;
  note?: string;
}

function build(input: ModelInput): DiffModel {
  const hunks = hunksToModel(input.hunks);
  const rows = hunks.reduce((n, h) => n + h.lines.length, 0);
  const tooLarge = rows > MAX_DIFF_ROWS;
  return {
    path: input.path,
    status: input.status,
    ...countChanges(hunks),
    binary: false,
    tooLarge,
    hunks: tooLarge ? [] : hunks,
    ...(input.baseline ? { baseline: input.baseline } : {}),
    ...(input.note ? { note: input.note } : {}),
  };
}

/** The model for a file whose before and after text we hold (the "This thread" source). */
export function modelFromTexts(input: { path: string; status: FileStatus; oldText: string; newText: string; baseline?: Baseline; note?: string }): DiffModel {
  const { oldText, newText, ...rest } = input;
  if (looksBinary(oldText) || looksBinary(newText)) return { path: rest.path, status: rest.status, added: 0, removed: 0, binary: true, tooLarge: false, hunks: [], ...(rest.baseline ? { baseline: rest.baseline } : {}), ...(rest.note ? { note: rest.note } : {}) };
  if (oldText.length > MAX_DIFF_CHARS || newText.length > MAX_DIFF_CHARS) return { path: rest.path, status: rest.status, added: 0, removed: 0, binary: false, tooLarge: true, hunks: [], ...(rest.baseline ? { baseline: rest.baseline } : {}), ...(rest.note ? { note: rest.note } : {}) };
  return build({ ...rest, hunks: textHunks(oldText, newText) });
}

/** The model for a unified patch git printed (the "Working tree" source). */
export function modelFromPatch(input: { path: string; status: FileStatus; patch: string; note?: string }): DiffModel {
  return build({ path: input.path, status: input.status, hunks: parseUnifiedPatch(input.patch), ...(input.note ? { note: input.note } : {}) });
}

/** A model that only says why there is nothing to draw. */
export function emptyModel(path: string, status: FileStatus, flags: { binary?: boolean; tooLarge?: boolean; note?: string }): DiffModel {
  return { path, status, added: 0, removed: 0, binary: flags.binary ?? false, tooLarge: flags.tooLarge ?? false, hunks: [], ...(flags.note ? { note: flags.note } : {}) };
}
