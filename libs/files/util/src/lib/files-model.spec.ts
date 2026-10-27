import { english } from '@pi-kit/i18n/testing';
import type { FileNode, WorkspaceStatus } from '@pi-kit/protocol';
import { describe, expect, it } from 'vitest';
import {
  decorator,
  enterAction,
  formatMtime,
  formatSize,
  joinPath,
  menuItems,
  nameProblem,
  parentOf,
  revertWords,
  typeAhead,
  visibleRows,
} from './files-model';

const node = (path: string, dir = false): FileNode => ({ name: path.split('/').pop() as string, path, dir });

const status: WorkspaceStatus = {
  git: true,
  entries: [
    { path: 'src/a.ts', badge: 'M', staged: false },
    { path: 'src/new.ts', badge: 'U', staged: false },
    { path: 'src/lib/old.ts', badge: 'D', staged: true },
    { path: 'README.md', badge: 'A', staged: true },
  ],
  thread: ['src/a.ts', 'src/committed.ts'],
};

describe('decorator', () => {
  const deco = decorator(status);
  it('gives a changed file its badge, tint and label', () => {
    expect(deco('src/a.ts', false)).toMatchObject({
      badge: 'M',
      badgeLabel: 'Modified',
      tone: 'warning',
      staged: false,
    });
    expect(deco('src/new.ts', false)).toMatchObject({ badge: 'U', tone: 'success' });
    expect(deco('src/lib/old.ts', false)).toMatchObject({ badge: 'D', tone: 'error', staged: true });
  });
  it('keeps the thread marker apart from the git badge: pi changed it, git may know nothing', () => {
    expect(deco('src/a.ts', false)).toMatchObject({ badge: 'M', thread: true });
    expect(deco('src/committed.ts', false)).toEqual({ thread: true });
    expect(deco('src/new.ts', false).thread).toBe(false);
    expect(deco('untouched.ts', false)).toEqual({ thread: false });
  });
  it('puts a dot on a folder with changes inside, in the colour of the worst one', () => {
    expect(deco('src', true).dot).toBe('D');
    expect(deco('src/lib', true).dot).toBe('D');
    expect(deco('docs', true).dot).toBeUndefined();
    expect(deco('src', true).badge).toBeUndefined();
  });
  it('decorates nothing outside git, and the thread marker still works', () => {
    const plain = decorator({ git: false, entries: [], thread: ['a.ts'] });
    expect(plain('a.ts', false)).toEqual({ thread: true });
    expect(decorator(undefined)('a.ts', false)).toEqual({ thread: false });
  });
});

describe('size and time', () => {
  it('words sizes in kB and MB', () => {
    expect(formatSize(undefined)).toBe('');
    expect(formatSize(340)).toBe('340 B');
    expect(formatSize(4_100)).toBe('4.1 kB');
    expect(formatSize(48_000)).toBe('48 kB');
    expect(formatSize(1_250_000)).toBe('1.3 MB');
  });
  it('says today as a clock time, this year as month and day, older as a date', () => {
    const now = new Date(2026, 9, 16, 15, 30).getTime();
    expect(formatMtime(english, new Date(2026, 9, 16, 9, 5).getTime(), now)).toBe('09:05');
    expect(formatMtime(english, new Date(2026, 9, 15, 9, 5).getTime(), now)).toBe('Oct 15');
    expect(formatMtime(english, new Date(2024, 2, 1).getTime(), now)).toBe('2024-03-01');
    expect(formatMtime(english, undefined)).toBe('');
  });
});

describe('visibleRows and type-ahead', () => {
  const children = new Map<string, FileNode[]>([
    ['', [node('docs', true), node('src', true), node('README.md')]],
    ['src', [node('src/lib', true), node('src/alpha.ts'), node('src/beta.ts')]],
    ['src/lib', [node('src/lib/x.ts')]],
  ]);
  it('walks the open folders in order with their depth', () => {
    const rows = visibleRows(children, new Set(['src', 'src/lib']));
    expect(rows.map((r) => [r.node.path, r.depth])).toEqual([
      ['docs', 0],
      ['src', 0],
      ['src/lib', 1],
      ['src/lib/x.ts', 2],
      ['src/alpha.ts', 1],
      ['src/beta.ts', 1],
      ['README.md', 0],
    ]);
    expect(visibleRows(children, new Set()).map((r) => r.node.path)).toEqual(['docs', 'src', 'README.md']);
  });
  it('jumps to the next row whose name starts with what was typed, wrapping, ignoring case', () => {
    const rows = visibleRows(children, new Set(['src']));
    expect(typeAhead(rows, -1, 'b')).toBe(4);
    expect(typeAhead(rows, 0, 'rea')).toBe(5);
    expect(typeAhead(rows, 5, 'd')).toBe(0);
    expect(typeAhead(rows, 0, 'zzz')).toBe(-1);
    expect(typeAhead(rows, 0, '')).toBe(-1);
  });
  it('typing the same letter again cycles through the rows that start with it', () => {
    const rows = [node('app.ts'), node('api.ts'), node('b.ts')].map((n) => ({ node: n, depth: 0 }));
    expect(typeAhead(rows, -1, 'a')).toBe(0);
    expect(typeAhead(rows, 0, 'a')).toBe(1);
    expect(typeAhead(rows, 1, 'aa')).toBe(0);
  });
});

describe('Enter and the menu', () => {
  const changed = decorator(status)('src/a.ts', false);
  const clean = decorator(status)('src/clean.ts', false);
  it('opens the diff of a changed file, inserts @path for any other, and opens or closes a folder', () => {
    expect(enterAction({ dir: true }, clean)).toBe('toggle');
    expect(enterAction({ dir: false }, changed)).toBe('diff');
    expect(enterAction({ dir: false }, clean)).toBe('mention');
    // pi changed it but git sees nothing (committed): still a changed file
    expect(enterAction({ dir: false }, { thread: true })).toBe('diff');
  });
  const ids = (items: ReturnType<typeof menuItems>) => items.filter((i) => !i.disabled).map((i) => i.id);
  it('offers the whole menu on a file, with diff and revert only for a changed one', () => {
    expect(
      ids(menuItems(english, { dir: false }, { decoration: clean, hasThread: true, composerAvailable: true })),
    ).toEqual([
      'open',
      'reveal',
      'copy-path',
      'copy-relative',
      'mention',
      'new-file',
      'new-folder',
      'rename',
      'delete',
    ]);
    expect(
      ids(menuItems(english, { dir: false }, { decoration: changed, hasThread: true, composerAvailable: true })),
    ).toEqual([
      'open',
      'reveal',
      'copy-path',
      'copy-relative',
      'mention',
      'new-file',
      'new-folder',
      'rename',
      'delete',
      'diff',
      'revert',
    ]);
  });
  it('offers no diff or revert without a thread, and no open for a folder', () => {
    const items = menuItems(
      english,
      { dir: true },
      { decoration: changed, hasThread: false, composerAvailable: false },
    );
    expect(items.find((i) => i.id === 'open')?.disabled).toBe(true);
    expect(items.find((i) => i.id === 'mention')?.disabled).toBe(true);
    expect(items.some((i) => i.id === 'diff' || i.id === 'revert')).toBe(false);
  });
  it('says what a revert does to an untracked file', () => {
    const untracked = decorator(status)('src/new.ts', false);
    expect(
      menuItems(english, { dir: false }, { decoration: untracked, hasThread: true, composerAvailable: true }).find(
        (i) => i.id === 'revert',
      )?.label,
    ).toContain('delete new file');
    expect(revertWords(english, 'U')).toContain('deletes it');
    expect(revertWords(english, 'M')).toContain('HEAD');
  });
  it('disables what cannot work on a file that is gone from the disk', () => {
    const items = menuItems(
      english,
      { dir: false },
      {
        decoration: decorator(status)('src/lib/old.ts', false),
        hasThread: true,
        missing: true,
        composerAvailable: true,
      },
    );
    for (const id of ['open', 'reveal', 'rename', 'delete'])
      expect(items.find((i) => i.id === id)?.disabled).toBe(true);
    expect(items.find((i) => i.id === 'revert')?.disabled).toBeFalsy();
  });
});

describe('names and paths', () => {
  it('rejects names that leave the folder or touch .git', () => {
    expect(nameProblem(english, '')).toBeDefined();
    expect(nameProblem(english, '../x')).toBeDefined();
    expect(nameProblem(english, '/etc/x')).toBeDefined();
    expect(nameProblem(english, 'a//b')).toBeDefined();
    expect(nameProblem(english, '.git/config')).toBeDefined();
    expect(nameProblem(english, 'notes.md')).toBeUndefined();
    expect(nameProblem(english, 'docs/notes.md')).toBeUndefined();
  });
  it('splits and joins relative paths', () => {
    expect(parentOf('src/lib/x.ts')).toBe('src/lib');
    expect(parentOf('README.md')).toBe('');
    expect(joinPath('', 'a.ts')).toBe('a.ts');
    expect(joinPath('src', 'a.ts')).toBe('src/a.ts');
  });
});
