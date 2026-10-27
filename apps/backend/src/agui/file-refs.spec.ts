import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { expandFileRefs, fileRefsOf } from './file-refs';

describe('expandFileRefs', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pk-refs-'));
  mkdirSync(join(cwd, 'src'));
  writeFileSync(join(cwd, 'src', 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(cwd, 'empty.txt'), '');
  writeFileSync(join(cwd, 'bin.dat'), Buffer.from([1, 2, 0, 3]));

  it('inlines text files like pi does for @file arguments', () => {
    expect(expandFileRefs(cwd, ['src/a.ts'])).toBe(`<file name="${join(cwd, 'src', 'a.ts')}">\nexport const a = 1;\n\n</file>\n`);
  });

  it('skips missing, empty, binary, duplicate and out-of-folder paths', () => {
    expect(expandFileRefs(cwd, ['nope.ts', 'empty.txt', 'bin.dat', '../outside.txt', '/etc/hosts', 'src'])).toBe('');
    const once = expandFileRefs(cwd, ['src/a.ts', './src/a.ts']);
    expect(once.match(/<file /g)).toHaveLength(1);
  });
});

describe('fileRefsOf', () => {
  it('reads string refs from the forwarded props and ignores anything else', () => {
    expect(fileRefsOf({ forwardedProps: { fileRefs: ['a', 1, 'b'] } })).toEqual(['a', 'b']);
    expect(fileRefsOf({ forwardedProps: { fileRefs: 'a' } })).toEqual([]);
    expect(fileRefsOf({})).toEqual([]);
  });
});
