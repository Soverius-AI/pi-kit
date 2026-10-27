import type { ViewRow } from './diff-rows';

export type FindSide = 'unified' | 'old' | 'new';
export interface DiffMatch {
  row: number;
  side: FindSide;
  start: number;
  end: number;
}
export interface DiffFindIndex {
  matches: DiffMatch[];
  byCell: Map<string, DiffMatch[]>;
}
export interface DiffTextPart {
  text: string;
  match?: DiffMatch;
}

/** Literal search over every model row, including rows outside the virtual window. */
export function findInDiff(rows: readonly ViewRow[], query: string, matchCase = false): DiffFindIndex {
  const index: DiffFindIndex = { matches: [], byCell: new Map() };
  if (!query) return index;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(escaped, matchCase ? 'gu' : 'giu');
  const add = (text: string, row: number, side: FindSide): void => {
    const matches = Array.from(text.matchAll(pattern), (match) => ({
      row,
      side,
      start: match.index,
      end: match.index + match[0].length,
    }));
    if (!matches.length) return;
    for (const match of matches) index.matches.push(match);
    index.byCell.set(`${row}:${side}`, matches);
  };
  rows.forEach((row, i) => {
    if (row.kind === 'unified') add(row.row.text, i, 'unified');
    else if (row.kind === 'split') {
      if (row.left) add(row.left.row.text, i, 'old');
      if (row.right) add(row.right.row.text, i, 'new');
    }
  });
  return index;
}

/** Keep code as plain text; user queries and source code never become HTML. */
export function diffTextParts(text: string, matches: readonly DiffMatch[] = [], active?: DiffMatch): DiffTextPart[] {
  if (!matches.length) return [{ text }];
  // Minified lines can contain hundreds of thousands of matches. Bound DOM marks while retaining
  // the complete index and always including the selected occurrence.
  const limit = 200;
  const selected = active ? matches.indexOf(active) : -1;
  const start = Math.max(0, Math.min(selected - limit / 2, matches.length - limit));
  const shown = matches.length > limit ? matches.slice(start, start + limit) : matches;
  const parts: DiffTextPart[] = [];
  let offset = 0;
  for (const match of shown) {
    if (offset < match.start) parts.push({ text: text.slice(offset, match.start) });
    parts.push({ text: text.slice(match.start, match.end), match });
    offset = match.end;
  }
  if (offset < text.length) parts.push({ text: text.slice(offset) });
  return parts;
}
