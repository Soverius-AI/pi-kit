import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type SkillVerification, stampProvenance, stampVerified } from '@pi-kit/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isInside, restampVerified, restoreSkillFolder, retireSkillFolder, retiredFolderOf, writeScratchSkill } from './skill-files';

const git = (cwd: string, ...args: string[]): void => void execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, stdio: 'ignore' });
const SKILL = '---\nname: add-notes\ndescription: Use when adding notes\n---\n\n# Steps\n1. Write them\n';

let base: string;
let project: string;
let root: string;
let scratch: string;
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'pk-skillfiles-')));
  project = join(base, 'project');
  root = join(base, 'worktrees');
  scratch = join(root, 'project', 'verify-add-notes');
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, 'README.md'), '# p\n');
  git(project, 'init', '-q', '-b', 'main');
  git(project, 'add', '-A');
  git(project, 'commit', '-q', '-m', 'init');
  mkdirSync(join(root, 'project'), { recursive: true });
  git(project, 'worktree', 'add', '-q', scratch, '-b', 'pi-kit/verify-add-notes', 'HEAD');
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe('writeScratchSkill: the draft goes into a scratch worktree and nowhere else', () => {
  it('writes .pi/skills/<name>/SKILL.md in a linked worktree under the worktree root', () => {
    const file = writeScratchSkill(scratch, 'add-notes', SKILL, root);
    expect(file).toBe(join(scratch, '.pi', 'skills', 'add-notes', 'SKILL.md'));
    expect(readFileSync(file, 'utf8')).toBe(SKILL);
    expect(existsSync(join(project, '.pi'))).toBe(false);
  });

  it('refuses the main checkout, even when it is under the root', () => {
    expect(() => writeScratchSkill(project, 'add-notes', SKILL, base)).toThrow(/not a linked git worktree/);
    expect(existsSync(join(project, '.pi'))).toBe(false);
  });

  it('refuses a folder outside the worktree root', () => {
    expect(() => writeScratchSkill(scratch, 'add-notes', SKILL, join(base, 'elsewhere'))).toThrow(/not inside the worktree root/);
    expect(() => writeScratchSkill(root, 'add-notes', SKILL, root)).toThrow(/not inside the worktree root/);
    expect(existsSync(join(scratch, '.pi'))).toBe(false);
  });

  it('refuses a name that is not a skill name, and one that would leave the skills folder', () => {
    for (const name of ['../escape', 'a/b', 'Not A Name', '', '..']) expect(() => writeScratchSkill(scratch, name, SKILL, root), name).toThrow();
    expect(existsSync(join(scratch, '.pi'))).toBe(false);
    expect(existsSync(join(scratch, 'escape'))).toBe(false);
  });

  it('refuses a worktree that is gone, and a skill that exists there already', () => {
    expect(() => writeScratchSkill(join(root, 'nope'), 'add-notes', SKILL, root)).toThrow(/gone/);
    writeScratchSkill(scratch, 'add-notes', SKILL, root);
    expect(() => writeScratchSkill(scratch, 'add-notes', 'other', root)).toThrow(/already/);
    expect(readFileSync(join(scratch, '.pi', 'skills', 'add-notes', 'SKILL.md'), 'utf8')).toBe(SKILL);
  });

  it('a worktree root that lies inside the project does not make the project a target', () => {
    const inside = join(project, '.worktrees');
    const nested = join(inside, 'nested');
    mkdirSync(inside, { recursive: true });
    git(project, 'worktree', 'add', '-q', nested, '-b', 'pi-kit/nested', 'HEAD');
    expect(() => writeScratchSkill(project, 'add-notes', SKILL, inside)).toThrow(/not inside the worktree root/);
    expect(writeScratchSkill(nested, 'add-notes', SKILL, inside)).toBe(join(nested, '.pi', 'skills', 'add-notes', 'SKILL.md'));
    expect(existsSync(join(project, '.pi'))).toBe(false);
  });
});

describe('isInside', () => {
  it('is true only for a path strictly below the folder', () => {
    expect(isInside('/a/b', '/a/b/c')).toBe(true);
    expect(isInside('/a/b', '/a/b')).toBe(false);
    expect(isInside('/a/b', '/a/bc')).toBe(false);
    expect(isInside('/a/b', '/a')).toBe(false);
    expect(isInside('/a/b', '/x/y')).toBe(false);
  });
});

describe('restampVerified: only the verified entry of a skill Approve wrote', () => {
  const done: SkillVerification = { state: 'done', result: 'pass', finishedAt: Date.UTC(2026, 9, 17), files: { reproduced: 1, expected: 1, extra: 0 }, hunks: { matched: 1, expected: 1, actual: 1 } };
  const stamped = stampProvenance(SKILL, { learnedFrom: 'thread-1', base: null, head: null });
  const written = (name = 'add-notes'): string => {
    const folder = join(base, 'skills', name);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'SKILL.md'), stamped);
    return join(folder, 'SKILL.md');
  };

  it('rewrites the verified lines and leaves the rest as the person has it', () => {
    const file = written();
    const edited = readFileSync(file, 'utf8').replace('1. Write them', '1. Write them all\n2. Check them');
    writeFileSync(file, edited);
    expect(restampVerified(file, { name: 'add-notes', threadId: 'thread-1' }, done)).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe(stampVerified(edited, done));
    expect(readFileSync(file, 'utf8')).toContain('1. Write them all\n2. Check them');
    expect(restampVerified(file, { name: 'add-notes', threadId: 'thread-1' }, null)).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe(edited);
  });

  it('refuses a file that is not that skill’s, or not pi-kit’s', () => {
    const file = written();
    expect(restampVerified(file, { name: 'other', threadId: 'thread-1' }, done)).toBe(false);
    expect(restampVerified(file, { name: 'add-notes', threadId: 'thread-2' }, done)).toBe(false);
    expect(restampVerified(join(base, 'skills', 'add-notes', 'README.md'), { name: 'add-notes', threadId: 'thread-1' }, done)).toBe(false);
    expect(restampVerified(join(base, 'gone', 'add-notes', 'SKILL.md'), { name: 'add-notes', threadId: 'thread-1' }, done)).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe(stamped);
    // A skill file without pi-kit's provenance is somebody else's.
    const mine = join(base, 'skills', 'mine');
    mkdirSync(mine, { recursive: true });
    writeFileSync(join(mine, 'SKILL.md'), SKILL);
    expect(restampVerified(join(mine, 'SKILL.md'), { name: 'mine', threadId: 'thread-1' }, done)).toBe(false);
    expect(readFileSync(join(mine, 'SKILL.md'), 'utf8')).toBe(SKILL);
  });
});

describe('retireSkillFolder and restoreSkillFolder: a learned skill moves to .retired and back, and nothing is deleted', () => {
  const stamped = stampProvenance(SKILL, { learnedFrom: 'thread-1', base: null, head: null });
  const expectation = { name: 'add-notes', threadId: 'thread-1' };
  const written = (name = 'add-notes', text = stamped): string => {
    const folder = join(base, 'skills', name);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'SKILL.md'), text);
    writeFileSync(join(folder, 'notes.txt'), 'a file beside the skill');
    return join(folder, 'SKILL.md');
  };

  it('moves the whole folder to skills/.retired/<name>/ and moves it back', () => {
    const file = written();
    const retired = retireSkillFolder(file, expectation);
    expect(retired).toBe(join(base, 'skills', '.retired', 'add-notes', 'SKILL.md'));
    expect(retiredFolderOf(file, 'add-notes')).toBe(join(base, 'skills', '.retired', 'add-notes'));
    expect(existsSync(file)).toBe(false);
    expect(readFileSync(retired, 'utf8')).toBe(stamped);
    expect(readFileSync(join(base, 'skills', '.retired', 'add-notes', 'notes.txt'), 'utf8')).toBe('a file beside the skill');
    restoreSkillFolder(file, expectation);
    expect(readFileSync(file, 'utf8')).toBe(stamped);
    expect(existsSync(join(base, 'skills', '.retired', 'add-notes'))).toBe(false);
    expect(readFileSync(join(base, 'skills', 'add-notes', 'notes.txt'), 'utf8')).toBe('a file beside the skill');
  });

  it('refuses a file that is not that skill’s or not learned from that thread, and moves nothing', () => {
    const file = written();
    expect(() => retireSkillFolder(file, { name: 'other', threadId: 'thread-1' })).toThrow(/left alone/);
    expect(() => retireSkillFolder(file, { name: 'add-notes', threadId: 'thread-2' })).toThrow(/left alone/);
    expect(() => retireSkillFolder(join(base, 'skills', 'add-notes', 'README.md'), expectation)).toThrow(/left alone/);
    expect(() => retireSkillFolder(join(base, 'gone', 'add-notes', 'SKILL.md'), expectation)).toThrow(/left alone/);
    expect(() => retireSkillFolder(file, { name: '../x', threadId: 'thread-1' })).toThrow(/not a skill name/);
    const mine = written('mine', SKILL);
    expect(() => retireSkillFolder(mine, { name: 'mine', threadId: 'thread-1' })).toThrow(/left alone/);
    expect(existsSync(file)).toBe(true);
    expect(existsSync(mine)).toBe(true);
    expect(existsSync(join(base, 'skills', '.retired'))).toBe(false);
  });

  it('does not overwrite a retired folder of that name, nor restore over a folder that is there', () => {
    const file = written();
    retireSkillFolder(file, expectation);
    written();
    expect(() => retireSkillFolder(file, expectation)).toThrow(/retired skill named add-notes already/);
    expect(() => restoreSkillFolder(file, expectation)).toThrow(/exists in the skills folder/);
    expect(readFileSync(file, 'utf8')).toBe(stamped);
    expect(existsSync(join(base, 'skills', '.retired', 'add-notes', 'SKILL.md'))).toBe(true);
  });

  it('restores only a retired skill of this thread', () => {
    const file = written();
    expect(() => restoreSkillFolder(file, expectation)).toThrow(/no retired copy/);
    retireSkillFolder(file, expectation);
    expect(() => restoreSkillFolder(file, { name: 'add-notes', threadId: 'thread-2' })).toThrow(/no retired copy/);
    expect(() => restoreSkillFolder(join(base, 'skills', 'add-notes', 'README.md'), expectation)).toThrow(/not a skill file/);
  });
});
