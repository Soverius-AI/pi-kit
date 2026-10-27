import { describe, expect, it } from 'vitest';
import { emptyModel, looksBinary, modelFromPatch, modelFromTexts, textHunks } from './diff';

describe('textHunks / modelFromTexts', () => {
  it('diffs two texts into numbered unified and split rows with three lines of context', () => {
    const oldText = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'].join('\n') + '\n';
    const newText = ['a', 'b', 'c', 'd', 'E', 'f', 'g', 'h', 'i', 'j'].join('\n') + '\n';
    const model = modelFromTexts({ path: 'x.ts', status: 'M', oldText, newText, baseline: 'captured' });
    expect(model).toMatchObject({ path: 'x.ts', status: 'M', added: 1, removed: 1, binary: false, tooLarge: false, baseline: 'captured' });
    expect(model.hunks).toHaveLength(1);
    const [hunk] = model.hunks;
    expect(hunk.header).toBe('@@ -2,7 +2,7 @@');
    expect(hunk.lines.map((l) => `${l.kind}:${l.oldNo ?? '-'}:${l.newNo ?? '-'}:${l.text}`)).toEqual([
      'ctx:2:2:b', 'ctx:3:3:c', 'ctx:4:4:d', 'del:5:-:e', 'add:-:5:E', 'ctx:6:6:f', 'ctx:7:7:g', 'ctx:8:8:h',
    ]);
    expect(hunk.split.find((r) => r.left?.kind === 'del')).toMatchObject({ left: { text: 'e' }, right: { text: 'E' } });
  });

  it('shows a new file as all added and a deleted file as all removed', () => {
    expect(modelFromTexts({ path: 'n.ts', status: 'A', oldText: '', newText: 'x\ny\n' })).toMatchObject({ added: 2, removed: 0 });
    expect(modelFromTexts({ path: 'n.ts', status: 'D', oldText: 'x\ny\n', newText: '' })).toMatchObject({ added: 0, removed: 2 });
  });

  it('drops the "no newline at end of file" marker', () => {
    const hunks = textHunks('a\nb', 'a\nB');
    expect(hunks[0].lines.every((l) => !l.startsWith('\\'))).toBe(true);
  });

  it('says binary and too large instead of drawing rows', () => {
    expect(modelFromTexts({ path: 'b.bin', status: 'M', oldText: 'a\0b', newText: 'a\0c' })).toMatchObject({ binary: true, hunks: [] });
    const big = 'x\n'.repeat(600_000);
    expect(modelFromTexts({ path: 'big.txt', status: 'M', oldText: big, newText: big + 'y' })).toMatchObject({ tooLarge: true, hunks: [] });
    expect(looksBinary(Buffer.from([0x61, 0, 0x62]))).toBe(true);
    expect(looksBinary('plain text')).toBe(false);
  });
});

describe('modelFromPatch', () => {
  it('reads git\'s unified output', () => {
    const patch = ['diff --git a/x.ts b/x.ts', 'index 1..2 100644', '--- a/x.ts', '+++ b/x.ts', '@@ -1,2 +1,2 @@', ' keep', '-old', '+new', ''].join('\n');
    const model = modelFromPatch({ path: 'x.ts', status: 'M', patch });
    expect(model).toMatchObject({ added: 1, removed: 1 });
    expect(model.hunks[0].lines.map((l) => l.kind)).toEqual(['ctx', 'del', 'add']);
  });

  it('builds an empty model with a note', () => {
    expect(emptyModel('a.ts', 'M', { note: 'nothing' })).toMatchObject({ hunks: [], note: 'nothing', binary: false });
  });
});
