import type { PiDiffHunk } from '@pi-kit/protocol';

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Hunks of a unified patch, as pi's `edit` tool reports it in `result.details.patch` (jsdiff's
 * `createTwoFilesPatch`: an `Index:` line, a rule, `---` / `+++` headers, then `@@` hunks). Anything
 * before the first hunk header is ignored; a `\ No newline at end of file` marker is dropped.
 * Counts bound each hunk's body and file sections reset it, so later file headers cannot become changes.
 * Partial tool patches keep the available lines and the header's original coordinates/counts.
 */
export function parseUnifiedPatch(patch: string): PiDiffHunk[] {
  const hunks: PiDiffHunk[] = [];
  let current: PiDiffHunk | undefined;
  let oldLeft = 0;
  let newLeft = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ') || line.startsWith('Index: ')) {
      current = undefined;
      continue;
    }
    const header = HUNK_HEADER.exec(line);
    if (header) {
      current = {
        oldStart: Number(header[1]),
        oldLines: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newLines: header[4] === undefined ? 1 : Number(header[4]),
        lines: [],
      };
      oldLeft = current.oldLines;
      newLeft = current.newLines;
      hunks.push(current);
    } else if (current && (oldLeft > 0 || newLeft > 0)) {
      const sign = line[0];
      if (sign === ' ' || sign === '+' || sign === '-') {
        current.lines.push(line);
        if (sign !== '+') oldLeft -= 1;
        if (sign !== '-') newLeft -= 1;
      }
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
