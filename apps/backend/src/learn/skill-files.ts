import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { type SkillVerification, isSkillName, provenanceOf, stampVerified } from '@pi-kit/protocol';

/**
 * The places besides Approve (`LearnService.approve`) and the save of an edited skill (`LearnService.saveApproved`) that touch a skill file, guarded here so a unit test can pin
 * what they refuse and the "Approve is the only writer" scan can allow exactly this file. Two are for verification, two for retiring:
 *
 * - `writeScratchSkill` puts the draft into the `.pi/skills/<name>/` of a **scratch worktree** of a verification run, so pi loads it there. It refuses anything that is not a linked git
 *   worktree (a worktree's `.git` is a file, the main checkout's is a folder) strictly inside the worktree root, so the project's own `.pi/skills/` and the user's can never be the target.
 * - `restampVerified` rewrites only the `x-pi-kit.verified` lines of a skill file that Approve wrote for this draft, when it is verified again.
 * - `retireSkillFolder` / `restoreSkillFolder` move a learned skill's folder to `<skills>/.retired/<name>/` and back. They rename, never delete or overwrite, and refuse a folder that
 *   is not `…/skills/<name>/SKILL.md` of that name with this thread in its provenance.
 */

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/** Is `child` strictly inside `parent` (both real paths)? */
export function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !rel.startsWith(sep) && rel !== '..';
}

/** Writes the skill into the scratch worktree and returns the file. Refuses a target outside the worktree root, a main checkout, a bad name, or a skill that exists there already. */
export function writeScratchSkill(scratch: string, name: string, text: string, worktreeRoot: string): string {
  if (!isSkillName(name)) throw new Error(`“${name}” is not a skill name.`);
  if (!existsSync(scratch)) throw new Error('The scratch worktree is gone.');
  const real = realpathSync(scratch);
  const root = existsSync(worktreeRoot) ? realpathSync(worktreeRoot) : resolve(worktreeRoot);
  if (!isInside(root, real)) throw new Error('The scratch folder is not inside the worktree root, so the skill is not written there.');
  // A linked worktree has a `.git` file that points at the repository; the main checkout has a `.git` folder. Never write a skill into the latter.
  if (!isFile(join(real, '.git'))) throw new Error('The scratch folder is not a linked git worktree, so the skill is not written there.');
  const skills = join(real, '.pi', 'skills');
  const folder = resolve(skills, name);
  if (!isInside(skills, folder)) throw new Error('That name would leave the skills folder.');
  const file = join(folder, 'SKILL.md');
  if (existsSync(file)) throw new Error(`The base commit has a skill named ${name} already, so the draft cannot be pinned there.`);
  mkdirSync(folder, { recursive: true });
  writeFileSync(file, text, { flag: 'wx' });
  return file;
}

/**
 * Updates the `x-pi-kit.verified` entry of the skill file Approve wrote for a draft. Only that entry changes. Refuses (returns false) a file that is not
 * `…/skills/<name>/SKILL.md` of that name, is gone, or does not name the thread in its provenance (it is not pi-kit's).
 */
export function restampVerified(path: string, expect: { name: string; threadId: string }, verification: SkillVerification | null): boolean {
  if (basename(path) !== 'SKILL.md' || basename(dirname(path)) !== expect.name || basename(dirname(dirname(path))) !== 'skills' || !isFile(path)) return false;
  const current = readFileSync(path, 'utf8');
  if (provenanceOf(current).learnedFrom !== expect.threadId) return false;
  const next = stampVerified(current, verification);
  if (next === current) return true;
  writeFileSync(path, next);
  return true;
}

/** The retired folder of a skill whose file is `…/skills/<name>/SKILL.md`: `…/skills/.retired/<name>`. pi skips folders that start with a dot, so a retired skill is not loaded. */
export const retiredFolderOf = (file: string, name: string): string => join(dirname(dirname(file)), '.retired', name);

const isOurs = (file: string, expect: { name: string; threadId: string }): boolean => {
  if (basename(file) !== 'SKILL.md' || basename(dirname(file)) !== expect.name || basename(dirname(dirname(file))) !== 'skills' || !isFile(file)) return false;
  return provenanceOf(readFileSync(file, 'utf8')).learnedFrom === expect.threadId;
};

/** Moves the skill's folder into `.retired/`. Returns the new `SKILL.md`. Throws (and moves nothing) when the folder is not a learned skill of this thread, or `.retired/<name>` exists. */
export function retireSkillFolder(file: string, expect: { name: string; threadId: string }): string {
  if (!isSkillName(expect.name)) throw new Error(`“${expect.name}” is not a skill name.`);
  if (!isOurs(file, expect)) throw new Error('The skill file is not where pi-kit wrote it, or is not a skill learned from this thread, so it is left alone.');
  const target = retiredFolderOf(file, expect.name);
  if (existsSync(target)) throw new Error(`There is a retired skill named ${expect.name} already (${target}). Restore or remove it first.`);
  mkdirSync(dirname(target), { recursive: true });
  renameSync(dirname(file), target);
  return join(target, 'SKILL.md');
}

/** Moves a retired skill's folder back where it was (`file` is its original `SKILL.md`). Throws when there is nothing retired, or the original place is taken. */
export function restoreSkillFolder(file: string, expect: { name: string; threadId: string }): void {
  if (!isSkillName(expect.name)) throw new Error(`“${expect.name}” is not a skill name.`);
  const retired = join(retiredFolderOf(file, expect.name), 'SKILL.md');
  if (basename(file) !== 'SKILL.md' || basename(dirname(file)) !== expect.name || basename(dirname(dirname(file))) !== 'skills') throw new Error('That is not a skill file.');
  if (!isFile(retired) || provenanceOf(readFileSync(retired, 'utf8')).learnedFrom !== expect.threadId) throw new Error('There is no retired copy of this skill.');
  if (existsSync(dirname(file))) throw new Error(`A folder named ${expect.name} exists in the skills folder now. Rename or remove it, then restore the skill.`);
  renameSync(dirname(retired), dirname(file));
}
