import type { PiDiffHunk } from '@pi-kit/protocol';

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Hunks of a unified patch, as pi's `edit` tool reports it in `result.details.patch` (jsdiff's
 * `createTwoFilesPatch`: an `Index:` line, a rule, `---` / `+++` headers, then `@@` hunks). Anything
 * before the first hunk header is ignored; a `\ No newline at end of file` marker is dropped.
 */
export function parseUnifiedPatch(patch: string): PiDiffHunk[] {
  const hunks: PiDiffHunk[] = [];
  let current: PiDiffHunk | undefined;
  for (const line of patch.split('\n')) {
    const header = HUNK_HEADER.exec(line);
    if (header) {
      current = {
        oldStart: Number(header[1]),
        oldLines: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newLines: header[4] === undefined ? 1 : Number(header[4]),
        lines: [],
      };
      hunks.push(current);
    } else if (current && (line.startsWith(' ') || line.startsWith('+') || line.startsWith('-'))) {
      current.lines.push(line);
    }
  }
  return hunks;
}

/** One hunk that shows the whole content as added; what a `write` call looks like, since pi does not report what it replaced. */
export function addedFileHunks(content: string): PiDiffHunk[] {
  if (content === '') return [];
  const lines = content.replace(/\n$/, '').split('\n');
  return [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length, lines: lines.map((l) => `+${l}`) }];
}

export function diffStat(hunks: readonly PiDiffHunk[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith('+')) added += 1;
      else if (line.startsWith('-')) removed += 1;
    }
  }
  return { added, removed };
}
