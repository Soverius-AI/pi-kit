import type { ReviewComment } from '@pi-kit/protocol';
import { describe, expect, it } from 'vitest';
import { buildReviewMessage, commentRef, orderComments } from './review-message';

const c = (
  id: string,
  file: string,
  line: number,
  text: string,
  extra: Partial<ReviewComment> = {},
): ReviewComment => ({
  id,
  file,
  line,
  side: 'new',
  snippet: `line ${line}`,
  text,
  ...extra,
});

describe('orderComments', () => {
  it('orders by file, then line, then the removed side before the new one', () => {
    const ordered = orderComments([
      c('1', 'b.ts', 5, 'b5'),
      c('2', 'a.ts', 40, 'a40'),
      c('3', 'a.ts', 7, 'a7'),
      c('4', 'a.ts', 7, 'a7 old', { side: 'old' }),
    ]);
    expect(ordered.map((x) => x.id)).toEqual(['4', '3', '2', '1']);
  });

  it('names a range as path:line-endLine, with the removed side spelled out', () => {
    expect(commentRef(c('1', 'a.ts', 38, 'x', { endLine: 42 }))).toBe('a.ts:38-42');
    expect(commentRef(c('2', 'a.ts', 38, 'x', { endLine: 38 }))).toBe('a.ts:38');
    expect(commentRef(c('3', 'a.ts', 5, 'x', { endLine: 7, side: 'old' }))).toBe(
      'a.ts:5-7 (removed lines, as they were before the change)',
    );
  });

  it('does not change the list it is given', () => {
    const list = [c('1', 'b.ts', 1, 'x'), c('2', 'a.ts', 1, 'y')];
    orderComments(list);
    expect(list.map((x) => x.id)).toEqual(['1', '2']);
  });
});

describe('buildReviewMessage', () => {
  it('writes a preamble and one block per comment: path:line, the quoted snippet, the text', () => {
    const message = buildReviewMessage([
      c('1', 'src/b.ts', 118, 'Handle the empty list.', { snippet: 'return items[0];' }),
      c('2', 'src/a.ts', 43, 'Also carry parentToolCallId here.', {
        snippet: '  return [{ type: EventType.TOOL_CALL_START }];',
      }),
    ]);
    expect(message).toBe(
      [
        'I reviewed your changes and left 2 comments on 2 files. Please address each one.',
        'src/a.ts:43\n>   return [{ type: EventType.TOOL_CALL_START }];\nAlso carry parentToolCallId here.',
        'src/b.ts:118\n> return items[0];\nHandle the empty list.',
      ].join('\n\n'),
    );
  });

  it('counts in the singular, quotes every line of a multi-line snippet and keeps a multi-line comment whole', () => {
    const message = buildReviewMessage([c('1', 'a.ts', 2, 'First line.\n\nSecond paragraph.', { snippet: 'a\nb\n' })]);
    expect(message).toBe(
      'I reviewed your changes and left 1 comment on 1 file. Please address each one.\n\na.ts:2\n> a\n> b\nFirst line.\n\nSecond paragraph.',
    );
  });

  it('says when a comment is about a line the change removed, and leaves out an empty snippet', () => {
    expect(commentRef({ file: 'a.ts', line: 9, side: 'old' })).toBe(
      'a.ts:9 (removed line, as it was before the change)',
    );
    const message = buildReviewMessage([c('1', 'a.ts', 9, 'Why remove this?', { side: 'old', snippet: '  ' })]);
    expect(message).toContain('a.ts:9 (removed line, as it was before the change)\nWhy remove this?');
    expect(message).not.toContain('>');
  });
});
