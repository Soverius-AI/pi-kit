import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import { compareDiffs, parseDiff, verdict } from './verify-rules';

it.each(['true', 'false'])('accounts for every real Git-quoted path with core.quotepath=%s', (quotePath) => {
  const cwd = mkdtempSync(join(tmpdir(), 'pk-verify-quoted-'));
  const git = (...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' });
  const names = ['tab\tname.md', 'quote"backslash\\名.txt', 'line\nbreak.txt', 'plain b/tricky b/file'];
  try {
    git('init', '-q');
    for (const name of names) {
      mkdirSync(dirname(join(cwd, name)), { recursive: true });
      writeFileSync(join(cwd, name), 'before\n');
    }
    git('add', '.');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'initial');
    for (const name of names) writeFileSync(join(cwd, name), 'after\n');
    const patch = git('-c', `core.quotepath=${quotePath}`, 'diff', '--no-renames', '-U0');
    const parsed = parseDiff(patch);
    expect(parsed.map((file) => file.path).sort()).toEqual([...names].sort());
    expect(parsed.every((file) => file.hunks.length === 1 && file.hunks[0].removed[0] === 'before' && file.hunks[0].added[0] === 'after')).toBe(true);
    // A replay that changed nothing must fail, even when every outcome filename needs Git quoting.
    expect(verdict(compareDiffs(parsed, []), [])).toBe('failed');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
