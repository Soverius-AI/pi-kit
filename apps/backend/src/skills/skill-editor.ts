import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { type SkillFile, type SkillScope, isSkillName, skillTextProblems } from '@pi-kit/protocol';
import { isInside } from '../learn/skill-files';

/**
 * The person's own skills, made and edited from Settings › Extensions and skills › Your skills. This is the one place besides Approve (`learn/learn.service.ts`, a skill
 * learned from a thread) that creates a skill folder, and it does so only on the person's click on "+": the folder is `<agent dir>/skills/<name>` or `<project>/.pi/skills/<name>`, and the
 * file the template (`packages/pi-kit-learn/templates/SKILL.md`, the same skeleton the analysis prompt fills) with the name in it. Editing refuses any path that is not a `SKILL.md`
 * directly inside such a folder, so the editor can never write elsewhere.
 */

/** The skeleton, used when the template that ships with the learn package is not found next to the backend. */
const FALLBACK_TEMPLATE = `---
name: <name>
description: <one line, at most 300 characters, saying what the skill does and when to use it: start with "Use when">
---

# <Title>

## When to use
<one or two sentences>

## Steps
1. <step>
2. <step>

## Pitfalls
- <something that went wrong, and how to avoid it>

## Verify
- \`<command>\` <what a pass looks like>
`;

/** Where the template can be: the folder the app ships (`packages/pi-kit-learn`), or the repository's, or the one a test names. */
export function templateCandidates(): string[] {
  return [process.env['PI_KIT_LEARN_PACKAGE_DIR'], join(__dirname, 'packages', 'pi-kit-learn'), resolve(__dirname, '..', '..', '..', '..', 'packages', 'pi-kit-learn'), resolve(__dirname, '..', '..', '..', 'packages', 'pi-kit-learn')]
    .filter((dir): dir is string => !!dir)
    .map((dir) => join(dir, 'templates', 'SKILL.md'));
}

export function readTemplate(candidates: readonly string[] = templateCandidates()): string {
  for (const file of candidates) {
    try {
      return readFileSync(file, 'utf8');
    } catch {
      // the next place
    }
  }
  return FALLBACK_TEMPLATE;
}

/** "add-a-migration" -> "Add a migration". */
export const titleOf = (name: string): string => {
  const words = name.replace(/-+/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** The template with the skill's name in its frontmatter and its title in the heading, and the description a person finishes ("Use when …"). */
export function skillFromTemplate(template: string, name: string): string {
  const lines = template.replace(/\r\n/g, '\n').split('\n');
  let frontmatter = 0;
  const out = lines.map((line) => {
    if (line.trim() === '---') frontmatter++;
    if (frontmatter === 1 && line.startsWith('name:')) return `name: ${name}`;
    if (frontmatter === 1 && line.startsWith('description:')) return 'description: Use when <describe the task this skill is for>';
    if (frontmatter >= 2 && /^#\s+<Title>/.test(line)) return `# ${titleOf(name)}`;
    return line;
  });
  return out.join('\n').replace(/\n*$/, '\n');
}

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

function writeAtomically(file: string, text: string): void {
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, text);
  renameSync(temp, file);
}

/** Makes the folder and the file of a new skill; refuses a name pi would not load and a folder that exists. Returns the file as the editor opens it. */
export function createSkill(input: { name: string; scope: SkillScope; agentDir: string; cwd: string; template?: string }): SkillFile {
  const { name, scope } = input;
  if (!isSkillName(name)) throw new Error('A skill name uses lowercase letters, digits and single hyphens, at most 64 characters.');
  const root = skillsDir(scope, input.agentDir, input.cwd);
  const folder = resolve(root, name);
  if (!isInside(root, folder)) throw new Error('That name would leave the skills folder.');
  if (existsSync(folder)) throw new Error(`${folder} exists already. Pick another name, or edit that skill.`);
  mkdirSync(folder, { recursive: true });
  const file = join(folder, 'SKILL.md');
  const text = skillFromTemplate(input.template ?? readTemplate(), name);
  writeFileSync(file, text, { flag: 'wx' });
  return { path: file, text, mtime: mtimeOf(file), name, scope };
}

/** The scope and name of a skill file, when the path is `<skills folder>/<name>/SKILL.md` of the user's or the project's; undefined for any other path. */
export function locateSkill(path: string, agentDir: string, cwd: string): { name: string; scope: SkillScope } | undefined {
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

/** Saves the editor's text over a skill file that pi can load, and that has not changed since it was opened. */
export function saveSkill(input: { path: string; text: string; mtime: number; agentDir: string; cwd: string }): SkillFile {
  const current = readSkill(input.path, input.agentDir, input.cwd);
  const problems = skillTextProblems(input.text);
  if (problems.length > 0) throw new Error(problems[0]);
  if (current.mtime !== input.mtime) throw new ChangedError();
  writeAtomically(current.path, input.text);
  return readSkill(input.path, input.agentDir, input.cwd);
}

/** The skill file changed on disk since the editor opened it; the controller answers with a conflict. */
export class ChangedError extends Error {
  constructor() {
    super('The file changed since you opened it. Reload and try again.');
  }
}
