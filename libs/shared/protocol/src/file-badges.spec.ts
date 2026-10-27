import { describe, expect, it } from 'vitest';
import { GIT_BADGES, badgeOf, dirtyFolders, folderBadges, parseStatusZ } from './file-badges';

describe('badgeOf', () => {
  it('maps the porcelain columns to the six badges', () => {
    expect(badgeOf('?', '?')).toBe('U');
    expect(badgeOf(' ', 'M')).toBe('M');
    expect(badgeOf('M', ' ')).toBe('M');
    expect(badgeOf('M', 'M')).toBe('M');
    expect(badgeOf('A', ' ')).toBe('A');
    expect(badgeOf(' ', 'A')).toBe('A');
    expect(badgeOf(' ', 'D')).toBe('D');
    expect(badgeOf('D', ' ')).toBe('D');
    expect(badgeOf('R', ' ')).toBe('R');
    expect(badgeOf('R', 'M')).toBe('R');
  });
  it('calls every unmerged state a conflict', () => {
    for (const [x, y] of [['U', 'U'], ['A', 'A'], ['D', 'D'], ['A', 'U'], ['U', 'D'], ['D', 'U'], ['U', 'A']]) expect(badgeOf(x, y)).toBe('C');
  });
  it('tints like the Changes panel: modified warning, added success, deleted error', () => {
    expect(GIT_BADGES.M.tone).toBe('warning');
    expect(GIT_BADGES.A.tone).toBe('success');
    expect(GIT_BADGES.D.tone).toBe('error');
    expect(GIT_BADGES.U.tone).toBe('success');
    expect(GIT_BADGES.C.tone).toBe('error');
    expect(GIT_BADGES.R.tone).toBe('info');
  });
});

describe('parseStatusZ', () => {
  it('reads the -z format, with the origin of a rename as its own item', () => {
    const out = [' M src/a.ts', 'A  src/new.ts', ' D src/gone.ts', '?? notes.md', 'R  src/renamed.ts', 'src/before.ts', 'UU src/clash.ts', ''].join('\0');
    expect(parseStatusZ(out)).toEqual([
      { path: 'src/a.ts', badge: 'M', staged: false },
      { path: 'src/new.ts', badge: 'A', staged: true },
      { path: 'src/gone.ts', badge: 'D', staged: false },
      { path: 'notes.md', badge: 'U', staged: false },
      { path: 'src/renamed.ts', badge: 'R', staged: true, from: 'src/before.ts' },
      { path: 'src/clash.ts', badge: 'C', staged: true },
    ]);
  });
  it('makes paths relative to the folder and leaves out files above it', () => {
    const out = [' M app/src/a.ts', ' M other/b.ts', 'R  app/new.ts', 'app/old.ts', ''].join('\0');
    expect(parseStatusZ(out, 'app/')).toEqual([
      { path: 'src/a.ts', badge: 'M', staged: false },
      { path: 'new.ts', badge: 'R', staged: true, from: 'old.ts' },
    ]);
  });
  it('ignores ignored entries and empty output', () => {
    expect(parseStatusZ('!! dist/\0')).toEqual([]);
    expect(parseStatusZ('')).toEqual([]);
  });
});

describe('folders', () => {
  it('lists every folder above a changed file once', () => {
    expect([...dirtyFolders(['a/b/c.ts', 'a/d.ts', 'top.ts'])].sort()).toEqual(['a', 'a/b']);
  });
  it('gives each folder the most severe badge inside it', () => {
    const entries = [
      { path: 'src/new.ts', badge: 'U' as const, staged: false },
      { path: 'src/lib/x.ts', badge: 'M' as const, staged: false },
      { path: 'src/lib/y.ts', badge: 'D' as const, staged: false },
      { path: 'docs/a.md', badge: 'A' as const, staged: true },
    ];
    const map = folderBadges(entries);
    expect(map.get('src')).toBe('D');
    expect(map.get('src/lib')).toBe('D');
    expect(map.get('docs')).toBe('A');
    expect(map.has('')).toBe(false);
  });
});
