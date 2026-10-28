import { addedFileHunks, parseUnifiedPatch } from '@pi-kit/pi-adapter';
import { type DiffModel, type FileStatus, type PiDiffHunk, countChanges, hunksToModel } from '@pi-kit/protocol';

/** NUL in the first 8 KB: git's own test for "this is not text". */
export function looksBinary(text: string | Buffer): boolean {
  const head = typeof text === 'string' ? text.slice(0, 8000) : text.subarray(0, 8000).toString('latin1');
  return head.includes('\0');
}

export interface ModelInput {
  path: string;
  status: FileStatus;
  hunks: PiDiffHunk[];
  note?: string;
}

function build(input: ModelInput): DiffModel {
  const hunks = hunksToModel(input.hunks);
  return {
    path: input.path,
    status: input.status,
    ...countChanges(hunks),
    binary: false,
    tooLarge: false,
    hunks,
    ...(input.note ? { note: input.note } : {}),
  };
}

/** The model of a new file: every line added (an untracked file, which git has no diff of). */
export function modelFromAddedText(path: string, text: string): DiffModel {
  return build({ path, status: 'A', hunks: addedFileHunks(text) });
}

/** The model for a unified patch git printed (the "Working tree" source). */
export function modelFromPatch(input: { path: string; status: FileStatus; patch: string; note?: string }): DiffModel {
  return build({
    path: input.path,
    status: input.status,
    hunks: parseUnifiedPatch(input.patch),
    ...(input.note ? { note: input.note } : {}),
  });
}

/** A model that only says why there is nothing to draw. */
export function emptyModel(
  path: string,
  status: FileStatus,
  flags: { binary?: boolean; tooLarge?: boolean; note?: string },
): DiffModel {
  return {
    path,
    status,
    added: 0,
    removed: 0,
    binary: flags.binary ?? false,
    tooLarge: flags.tooLarge ?? false,
    hunks: [],
    ...(flags.note ? { note: flags.note } : {}),
  };
}
