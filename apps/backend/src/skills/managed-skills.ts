import { existsSync, readFileSync, statSync } from 'node:fs';
import { lstat, realpath, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { type SkillFile, type SkillScope, isSkillName, provenanceOf } from '@pi-kit/protocol';
import { isInside } from '../learn/skill-files';

export function skillsDir(scope: SkillScope, agentDir: string, cwd: string): string {
  return scope === 'user' ? join(agentDir, 'skills') : join(cwd, '.pi', 'skills');
}

export const mtimeOf = (path: string): number => {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
};

export function locateSkill(
  path: string,
  agentDir: string,
  cwd: string,
): { name: string; scope: SkillScope } | undefined {
  const file = resolve(path);
  if (basename(file) !== 'SKILL.md') return undefined;
  const folder = dirname(file);
  const name = basename(folder);
  for (const scope of ['user', 'project'] as const) {
    const root = resolve(skillsDir(scope, agentDir, cwd));
    if (dirname(folder) === root && isInside(root, folder)) return { name, scope };
  }
  return undefined;
}

export function readSkill(path: string, agentDir: string, cwd: string): SkillFile {
  const where = locateSkill(path, agentDir, cwd);
  if (!where) throw new Error('That is not the file of one of your skills.');
  const file = resolve(path);
  if (!existsSync(file)) throw new Error('That skill is gone.');
  return { path: file, text: readFileSync(file, 'utf8'), mtime: mtimeOf(file), ...where };
}

export async function deleteSkill(input: {
  path: string;
  mtime: number;
  agentDir: string;
  cwd: string;
}): Promise<void> {
  const where = locateSkill(input.path, input.agentDir, input.cwd);
  if (!where || !isSkillName(where.name)) throw new Error('That is not an individually managed skill.');
  const base = await realpath(where.scope === 'user' ? input.agentDir : input.cwd);
  const root = skillsDir(where.scope, input.agentDir, input.cwd);
  const expected = where.scope === 'user' ? join(base, 'skills') : join(base, '.pi', 'skills');
  const file = resolve(input.path);
  const folder = dirname(file);
  if (
    (await realpath(root)) !== expected ||
    (await lstat(root)).isSymbolicLink() ||
    (await lstat(folder)).isSymbolicLink() ||
    (await lstat(file)).isSymbolicLink()
  )
    throw new Error('Symlinked skills cannot be deleted here.');
  if (
    (await realpath(folder)) !== join(expected, where.name) ||
    (await realpath(file)) !== join(expected, where.name, 'SKILL.md')
  )
    throw new Error('That skill resolves outside its managed folder.');
  const current = readSkill(file, input.agentDir, input.cwd);
  if (provenanceOf(current.text)?.learnedFrom)
    throw new ManagedSkillConflict('This is a learned skill. Use Retire instead of Delete.');
  if (current.mtime !== input.mtime) throw new ChangedError();
  await rm(folder, { recursive: true });
}

export class ManagedSkillConflict extends Error {}

export class ChangedError extends Error {
  constructor() {
    super('The file changed since you opened it. Reload and try again.');
  }
}
