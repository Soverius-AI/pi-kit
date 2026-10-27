import {
  type DiffModel,
  type DiffRow,
  type PiActivityContent,
  type ReviewComment,
  countChanges,
  hunkId,
  hunksToModel,
} from '@pi-kit/protocol';

/**
 * Pure part of the diff viewer: turns a `DiffModel` plus the comments and the open editor into the flat
 * list of rows the viewer draws, in unified or split layout. No Angular, no state.
 */

export type DiffMode = 'unified' | 'split';

/** A place a comment can be attached to: a line of the old or of the new file, or a range of lines on one side. */
export interface Anchor {
  side: 'old' | 'new';
  line: number;
  /** The last line of a range (inclusive); absent for one line. */
  endLine?: number;
  /** The line's text (the lines' texts, joined with newlines, for a range), kept with the comment. */
  snippet: string;
}

/** The last line a comment or editor covers: where its card sits. */
export const lastLine = (a: Pick<Anchor, 'line' | 'endLine'>): number => a.endLine ?? a.line;

/** Is `line` on `side` inside the anchor's range? */
export const covers = (a: Pick<Anchor, 'side' | 'line' | 'endLine'>, side: 'old' | 'new', line: number): boolean =>
  a.side === side && line >= a.line && line <= lastLine(a);

/** The text of lines `from` to `to` (inclusive) on one side of the model, joined with newlines, for a range's snippet. */
export function snippetOf(model: DiffModel, side: 'old' | 'new', from: number, to: number): string {
  const lines: string[] = [];
  for (const hunk of model.hunks) {
    for (const row of hunk.lines) {
      const no = side === 'old' ? row.oldNo : row.newNo;
      if (no !== undefined && no !== null && no >= from && no <= to) lines.push(row.text);
    }
  }
  return lines.join('\n');
}

/** The editor that is open: a new comment on `anchor`, or an existing comment (`id`) being changed. */
export interface Draft extends Anchor {
  id?: string;
  text?: string;
}

export interface HunkRow {
  kind: 'hunk';
  key: string;
  header: string;
  /** `path@oldStart:newStart`, the id a hunk label is stored under. */
  id: string;
}

export interface UnifiedRow {
  kind: 'unified';
  key: string;
  row: DiffRow;
  /** The anchor a click on `+` uses: the new side of a context or added line, the old side of a removed one. */
  anchor: Anchor;
  /** Inside the range of a comment or of the open editor (the card itself sits under the range's last line). */
  marked: boolean;
  comments: ReviewComment[];
  draft?: Draft;
}

/** One half of a split row. */
export interface Cell {
  row: DiffRow;
  anchor: Anchor;
}

export interface SplitViewRow {
  kind: 'split';
  key: string;
  left: Cell | null;
  right: Cell | null;
  /** Each half inside the range of a comment or of the open editor. */
  markedOld: boolean;
  markedNew: boolean;
  comments: ReviewComment[];
  draft?: Draft;
}

export type ViewRow = HunkRow | UnifiedRow | SplitViewRow;

export const sameAnchor = (a: Pick<Anchor, 'side' | 'line'>, b: Pick<Anchor, 'side' | 'line'>): boolean =>
  a.side === b.side && a.line === b.line;
/** A comment or editor is hosted by the row of its last line. */
const hostedBy = (host: Pick<Anchor, 'side' | 'line'>, a: Pick<Anchor, 'side' | 'line' | 'endLine'>): boolean =>
  host.side === a.side && host.line === lastLine(a);

const oldAnchor = (row: DiffRow): Anchor => ({ side: 'old', line: row.oldNo ?? 0, snippet: row.text });
const newAnchor = (row: DiffRow): Anchor => ({ side: 'new', line: row.newNo ?? 0, snippet: row.text });
const cell = (row: DiffRow | null, side: 'old' | 'new'): Cell | null =>
  row ? { row, anchor: side === 'old' ? oldAnchor(row) : newAnchor(row) } : null;

/** A removed line is commented on its old number; every other line on its new one. */
export function defaultAnchor(row: DiffRow): Anchor {
  return row.kind === 'del' ? oldAnchor(row) : newAnchor(row);
}

export function buildRows(
  model: DiffModel,
  mode: DiffMode,
  comments: readonly ReviewComment[],
  draft: Draft | null,
): ViewRow[] {
  const out: ViewRow[] = [];
  // A comment or an editor appears once, under the first row that has its line, even when a line shows up twice.
  const placed = new Set<string>();
  const claim = (hosts: readonly Anchor[]): { comments: ReviewComment[]; draft?: Draft } => {
    const mine: ReviewComment[] = [];
    for (const comment of comments) {
      if (placed.has(comment.id)) continue;
      if (hosts.some((a) => hostedBy(a, comment))) {
        placed.add(comment.id);
        mine.push(comment);
      }
    }
    let editor: Draft | undefined;
    if (draft && !placed.has('draft') && hosts.some((a) => hostedBy(a, draft))) {
      placed.add('draft');
      editor = draft;
    }
    // The comment being edited is shown as the editor, not as a card as well.
    const shown = editor?.id ? mine.filter((c) => c.id !== editor?.id) : mine;
    return { comments: shown, ...(editor ? { draft: editor } : {}) };
  };
  // A row is marked when any comment's range, or the editor's, covers its line on that side (the edited comment counts once).
  const ranges: Pick<Anchor, 'side' | 'line' | 'endLine'>[] = [
    ...comments.filter((c) => !draft?.id || c.id !== draft.id),
    ...(draft ? [draft] : []),
  ];
  const marked = (hosts: readonly Anchor[]): boolean =>
    hosts.some((h) => ranges.some((a) => covers(a, h.side, h.line)));

  model.hunks.forEach((hunk, h) => {
    out.push({ kind: 'hunk', key: `h${h}`, header: hunk.header, id: hunkId(model.path, hunk.oldStart, hunk.newStart) });
    if (mode === 'unified') {
      hunk.lines.forEach((row, r) => {
        const hosts = row.kind === 'ctx' ? [newAnchor(row), oldAnchor(row)] : [defaultAnchor(row)];
        out.push({
          kind: 'unified',
          key: `h${h}:${r}`,
          row,
          anchor: defaultAnchor(row),
          marked: marked(hosts),
          ...claim(hosts),
        });
      });
    } else {
      hunk.split.forEach((pair, r) => {
        const left = cell(pair.left, 'old');
        const right = cell(pair.right, 'new');
        const hosts = [left?.anchor, right?.anchor].filter((a): a is Anchor => !!a);
        out.push({
          kind: 'split',
          key: `h${h}:${r}`,
          left,
          right,
          markedOld: left ? marked([left.anchor]) : false,
          markedNew: right ? marked([right.anchor]) : false,
          ...claim(hosts),
        });
      });
    }
  });
  return out;
}

/** The model of a `pi.diff` activity (an `edit` patch, or a written file shown as added), for the transcript's rows. */
export function modelFromActivity(content: PiActivityContent<'pi.diff'>): DiffModel {
  const hunks = hunksToModel(content.hunks);
  return {
    path: content.path,
    status: content.written ? 'A' : 'M',
    ...countChanges(hunks),
    binary: false,
    tooLarge: false,
    hunks,
  };
}

/** Comments per file, for the badges of the file list. */
export function countByFile(comments: readonly ReviewComment[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const comment of comments) counts.set(comment.file, (counts.get(comment.file) ?? 0) + 1);
  return counts;
}
