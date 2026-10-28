import { describe, expect, it } from 'vitest';
import { emptyModel, looksBinary, modelFromAddedText, modelFromPatch } from './diff';

describe('modelFromPatch', () => {
  it("reads git's unified output into numbered unified and split rows", () => {
    const patch = [
      'diff --git a/x.ts b/x.ts',
      'index 1..2 100644',
      '--- a/x.ts',
      '+++ b/x.ts',
      '@@ -2,7 +2,7 @@',
      ' b',
      ' c',
      ' d',
      '-e',
      '+E',
      ' f',
      ' g',
      ' h',
      '',
    ].join('\n');
    const model = modelFromPatch({ path: 'x.ts', status: 'M', patch });
    expect(model).toMatchObject({ path: 'x.ts', status: 'M', added: 1, removed: 1, binary: false, tooLarge: false });
    const [hunk] = model.hunks;
    expect(hunk.header).toBe('@@ -2,7 +2,7 @@');
    expect(hunk.lines.map((l) => `${l.kind}:${l.oldNo ?? '-'}:${l.newNo ?? '-'}:${l.text}`)).toEqual([
      'ctx:2:2:b',
      'ctx:3:3:c',
      'ctx:4:4:d',
      'del:5:-:e',
      'add:-:5:E',
      'ctx:6:6:f',
      'ctx:7:7:g',
      'ctx:8:8:h',
    ]);
    expect(hunk.split.find((r) => r.left?.kind === 'del')).toMatchObject({ left: { text: 'e' }, right: { text: 'E' } });
  });

  it('builds an empty model with a note', () => {
    expect(emptyModel('a.ts', 'M', { note: 'nothing' })).toMatchObject({ hunks: [], note: 'nothing', binary: false });
  });
});

describe('modelFromAddedText', () => {
  it('shows a new file as every line added', () => {
    const model = modelFromAddedText('n.ts', 'x\ny\n');
    expect(model).toMatchObject({ path: 'n.ts', status: 'A', added: 2, removed: 0 });
    expect(model.hunks[0].lines.map((l) => `${l.kind}:${l.newNo}:${l.text}`)).toEqual(['add:1:x', 'add:2:y']);
  });
});

describe('looksBinary', () => {
  it('is git’s own test: a NUL in the first 8 KB', () => {
    expect(looksBinary(Buffer.from([0x61, 0, 0x62]))).toBe(true);
    expect(looksBinary('plain text')).toBe(false);
  });
});
