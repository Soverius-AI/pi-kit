import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { excerptOf, hunkId, splitDiff, weightOf } from './hunks.mjs';

const diff = readFileSync(new URL('./fixtures/outcome.diff', import.meta.url), 'utf8');

describe('splitDiff', () => {
  const hunks = splitDiff(diff);

  it('finds every hunk of every text file, in order, and none for a binary file', () => {
    expect(hunks.map((h) => h.id)).toEqual([
      'notes/alpha.md@0:1',
      'notes/beta.md@0:1',
      'notes/gamma.md@1:1',
      'notes/gamma.md@20:21',
      'src/map.ts@1:1',
    ]);
    expect(hunks.some((h) => h.file === 'image.png')).toBe(false);
  });

  it('counts the lines each hunk adds and removes', () => {
    expect(hunks.map((h) => [h.added, h.removed])).toEqual([
      [3, 0],
      [4, 0],
      [2, 1],
      [1, 0],
      [2, 1],
    ]);
    expect(hunks.map(weightOf)).toEqual([3, 4, 3, 1, 3]);
  });

  it('does not mistake an added line that starts with dashes for a file header', () => {
    const beta = hunks.find((h) => h.file === 'notes/beta.md');
    expect(beta.lines).toContain('+-- a line that starts with two dashes');
    expect(beta.added).toBe(4);
  });

  it('keeps the header as git printed it and the section after it', () => {
    expect(hunks[0].header).toBe('@@ -0,0 +1,3 @@');
    expect(hunks[3].header).toBe('@@ -20,3 +21,4 @@');
    expect(hunks[3].section).toBe('The end.');
  });

  it('id is the file and the two start lines, the same string the diff viewer derives', () => {
    expect(hunkId('src/map.ts', 1, 1)).toBe('src/map.ts@1:1');
    expect(hunks[2].oldStart).toBe(1);
    expect(hunks[2].newStart).toBe(1);
  });

  it('a hunk with no count in its header means one line', () => {
    const one = splitDiff('diff --git a/x.txt b/x.txt\n--- a/x.txt\n+++ b/x.txt\n@@ -3 +3 @@\n-old\n+new\n');
    expect(one).toHaveLength(1);
    expect(one[0]).toMatchObject({ id: 'x.txt@3:3', oldLines: 1, newLines: 1, added: 1, removed: 1 });
  });

  it('reads a path with spaces and a quoted path', () => {
    const spaced = splitDiff(
      'diff --git a/my notes/a b.md b/my notes/a b.md\n--- a/my notes/a b.md\n+++ b/my notes/a b.md\n@@ -1 +1 @@\n-x\n+y\n',
    );
    expect(spaced[0].file).toBe('my notes/a b.md');
    const quoted = splitDiff(
      'diff --git "a/caf\\303\\251.txt" "b/caf\\303\\251.txt"\n--- "a/caf\\303\\251.txt"\n+++ "b/caf\\303\\251.txt"\n@@ -1 +1 @@\n-x\n+y\n',
    );
    expect(quoted[0].file).toBe('café.txt');
  });

  it('survives a diff that was cut in the middle of a hunk, an empty diff and nothing at all', () => {
    const cut = splitDiff('diff --git a/x.txt b/x.txt\n@@ -1,5 +1,5 @@\n-a\n+b\n');
    expect(cut).toHaveLength(1);
    expect(cut[0].added).toBe(1);
    expect(splitDiff('')).toEqual([]);
    expect(splitDiff(null)).toEqual([]);
  });

  // These valid POSIX filenames cannot be created on Windows.
  it.skipIf(process.platform === 'win32').each(['true', 'false'])(
    'keeps real Git filenames and hunk ids with core.quotepath=%s',
    (quotePath) => {
      const cwd = mkdtempSync(join(tmpdir(), 'pk-score-paths-'));
      const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });
      const names = [
        'bell\x07.txt',
        'back\bspace.txt',
        'form\ffeed.txt',
        'vertical\vtab.txt',
        '😀\t.txt',
        'quote"backslash\\名.txt',
        'line\nbreak.txt',
        'plain b/tricky b/file',
      ];
      try {
        git('init', '-q');
        for (const name of names) {
          mkdirSync(dirname(join(cwd, name)), { recursive: true });
          writeFileSync(join(cwd, name), 'before\n');
        }
        git('add', '.');
        const added = splitDiff(git('-c', `core.quotepath=${quotePath}`, 'diff', '--cached', '--no-renames', '-U0'));
        expect(added.map((hunk) => hunk.file).sort()).toEqual([...names].sort());
        for (const hunk of added) {
          expect(hunk.id).toBe(`${hunk.file}@0:1`);
          expect(hunk.lines).toEqual(['+before']);
        }
        for (const name of names) rmSync(join(cwd, name));
        const deleted = splitDiff(git('-c', `core.quotepath=${quotePath}`, 'diff', '--no-renames', '-U0'));
        expect(deleted.map((hunk) => hunk.file).sort()).toEqual([...names].sort());
        for (const hunk of deleted) {
          expect(hunk.id).toBe(`${hunk.file}@1:0`);
          expect(hunk.lines).toEqual(['-before']);
        }
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    },
  );

  it('does not invent a context line from the trailing newline of a truncated hunk', () => {
    const [hunk] = splitDiff('diff --git a/x b/x\n@@ -1,5 +1,5 @@\n-a\n+b\n');
    expect(hunk.lines).toEqual(['-a', '+b']);
  });

  it('excerpt: the first changed lines, signs kept and long lines cut', () => {
    expect(excerptOf(hunks[2], 2)).toEqual(['-One old line.', '+One new line.']);
    expect(excerptOf({ lines: [`+${'x'.repeat(300)}`] }, 1, 20)[0]).toHaveLength(20);
  });
});
