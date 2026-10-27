import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type SkillScope, stampProvenance } from '@pi-kit/protocol';
import { ChangedError, ManagedSkillConflict, deleteSkill, locateSkill, readSkill } from './managed-skills';

function folders() {
  const root = mkdtempSync(join(tmpdir(), 'pk-skills-'));
  const agentDir = join(root, 'agent');
  const cwd = join(root, 'work');
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  return { agentDir, cwd };
}
function writeSkill(input: { name: string; scope: SkillScope; agentDir: string; cwd: string }) {
  const root = input.scope === 'user' ? join(input.agentDir, 'skills') : join(input.cwd, '.pi', 'skills');
  const folder = join(root, input.name);
  mkdirSync(folder, { recursive: true });
  const path = join(folder, 'SKILL.md');
  writeFileSync(path, `---\nname: ${input.name}\ndescription: Use when testing skills\n---\nInstructions\n`);
  return readSkill(path, input.agentDir, input.cwd);
}

describe('deleteSkill', () => {
  it('removes a complete user or project skill folder, including supporting files', async () => {
    const dirs = folders();
    for (const scope of ['user', 'project'] as const) {
      const file = writeSkill({ name: 'remove-me', scope, ...dirs });
      const folder = resolve(file.path, '..');
      mkdirSync(join(folder, 'references'));
      writeFileSync(join(folder, 'references', 'guide.md'), 'reference');
      await deleteSkill({ ...dirs, path: file.path, mtime: file.mtime });
      expect(existsSync(folder)).toBe(false);
    }
  });

  it('refuses stale files, learned skills, and paths outside managed roots', async () => {
    const dirs = folders();
    const file = writeSkill({ name: 'keep-me', scope: 'user', ...dirs });
    await expect(deleteSkill({ ...dirs, path: file.path, mtime: file.mtime - 1 })).rejects.toBeInstanceOf(ChangedError);
    writeFileSync(file.path, stampProvenance(file.text, { learnedFrom: 'thread-id', base: 'abc', head: 'def' }));
    await expect(deleteSkill({ ...dirs, path: file.path, mtime: file.mtime })).rejects.toBeInstanceOf(
      ManagedSkillConflict,
    );
    await expect(deleteSkill({ ...dirs, path: join(dirs.cwd, 'SKILL.md'), mtime: 0 })).rejects.toThrow(
      /individually managed/,
    );
    expect(existsSync(file.path)).toBe(true);
  });

  it('refuses symlinked skill folders, files, and managed roots without touching targets', async () => {
    const dirs = folders();
    const external = writeSkill({ name: 'external', scope: 'project', ...dirs });
    mkdirSync(join(dirs.agentDir, 'skills'));
    const linked = join(dirs.agentDir, 'skills', 'linked');
    symlinkSync(resolve(external.path, '..'), linked);
    await expect(deleteSkill({ ...dirs, path: join(linked, 'SKILL.md'), mtime: external.mtime })).rejects.toThrow(
      /Symlinked/,
    );
    const file = writeSkill({ name: 'file-link', scope: 'user', ...dirs });
    const linkedFile = join(resolve(file.path, '..'), 'linked-file.md');
    symlinkSync(external.path, linkedFile);
    const fileLinkDir = join(dirs.agentDir, 'skills', 'another-link');
    mkdirSync(fileLinkDir);
    symlinkSync(external.path, join(fileLinkDir, 'SKILL.md'));
    await expect(deleteSkill({ ...dirs, path: join(fileLinkDir, 'SKILL.md'), mtime: external.mtime })).rejects.toThrow(
      /Symlinked/,
    );
    const second = folders();
    symlinkSync(resolve(external.path, '..', '..'), join(second.agentDir, 'skills'));
    await expect(
      deleteSkill({ ...second, path: join(second.agentDir, 'skills', 'external', 'SKILL.md'), mtime: external.mtime }),
    ).rejects.toThrow(/Symlinked/);
    expect(existsSync(external.path)).toBe(true);
  });
});

describe('readSkill', () => {
  it('only opens a SKILL.md directly inside a skills folder of the user or the project', () => {
    const { agentDir, cwd } = folders();
    const made = writeSkill({ name: 'one', scope: 'user', agentDir, cwd });
    expect(locateSkill(made.path, agentDir, cwd)).toEqual({ name: 'one', scope: 'user' });
    expect(readSkill(made.path, agentDir, cwd).text).toBe(made.text);
    for (const path of [
      join(agentDir, 'auth.json'),
      join(agentDir, 'skills', 'one', 'other.md'),
      join(agentDir, 'skills', 'one', 'deep', 'SKILL.md'),
      join(cwd, 'SKILL.md'),
      join(agentDir, 'skills', '..', 'SKILL.md'),
    ]) {
      expect(locateSkill(path, agentDir, cwd), path).toBeUndefined();
      expect(() => readSkill(path, agentDir, cwd), path).toThrow();
    }
  });

  it('reads both scopes with metadata and refuses a missing file', () => {
    const dirs = folders();
    for (const scope of ['user', 'project'] as const) {
      const file = writeSkill({ name: 'read-me', scope, ...dirs });
      expect(file).toMatchObject({ name: 'read-me', scope, mtime: expect.any(Number) });
      expect(file.mtime).toBeGreaterThan(0);
      expect(file.text).toBe(readFileSync(file.path, 'utf8'));
    }
    expect(() => readSkill(join(dirs.agentDir, 'skills', 'missing', 'SKILL.md'), dirs.agentDir, dirs.cwd)).toThrow(
      /gone/,
    );
  });
});
