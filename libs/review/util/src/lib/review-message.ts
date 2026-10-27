import type { ReviewComment } from '@pi-kit/protocol';

/**
 * The prompt a batch of review comments becomes: a short preamble and one block per comment, ordered by
 * file and then by line, each with `path:line`, the quoted snippet and the text. The structured batch travels
 * beside it in `forwardedProps.review`, so this text is only what pi (and the model) reads.
 */

/** File first (by path, case-sensitive so the order is the same everywhere), then line, then the old side before the new one. */
export function orderComments(comments: readonly ReviewComment[]): ReviewComment[] {
  return [...comments].sort(
    (a, b) =>
      (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) ||
      a.line - b.line ||
      (a.side === b.side ? 0 : a.side === 'old' ? -1 : 1) ||
      a.id.localeCompare(b.id),
  );
}

/** `path:line`, or `path:line-endLine` for a range, with the side spelled out for a comment on lines the change removed. */
export function commentRef(comment: Pick<ReviewComment, 'file' | 'line' | 'side'> & { endLine?: number }): string {
  const range = comment.endLine !== undefined && comment.endLine > comment.line;
  const where = range ? `${comment.line}-${comment.endLine}` : `${comment.line}`;
  return `${comment.file}:${where}${comment.side === 'old' ? (range ? ' (removed lines, as they were before the change)' : ' (removed line, as it was before the change)') : ''}`;
}

function quote(snippet: string): string {
  const lines = snippet.replace(/\s+$/, '').split('\n');
  return lines.map((line) => `> ${line}`.replace(/\s+$/, '')).join('\n');
}

export function buildReviewMessage(comments: readonly ReviewComment[]): string {
  const ordered = orderComments(comments);
  const files = new Set(ordered.map((c) => c.file)).size;
  const count = ordered.length;
  const preamble = `I reviewed your changes and left ${count} ${count === 1 ? 'comment' : 'comments'} on ${files} ${files === 1 ? 'file' : 'files'}. Please address each one.`;
  const blocks = ordered.map((comment) => {
    const parts = [commentRef(comment)];
    if (comment.snippet.trim()) parts.push(quote(comment.snippet));
    parts.push(comment.text.trim());
    return parts.join('\n');
  });
  return [preamble, ...blocks].join('\n\n');
}
