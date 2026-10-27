import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { skillTextProblems } from '@pi-kit/protocol';
import { ChangedError, createSkill, locateSkill, readSkill, readTemplate, saveSkill, skillFromTemplate, templateCandidates, titleOf } from './skill-editor';

function folders() {
  const root = mkdtempSync(join(tmpdir(), 'pk-skills-'));
  const agentDir = join(root, 'agent');
  const cwd = join(root, 'work');
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  return { agentDir, cwd };
}
const TEMPLATE = readFileSync(resolve(__dirname, '..', '..', '..', '..', 'packages', 'pi-kit-learn', 'templates', 'SKILL.md'), 'utf8');

describe('a new skill from the template', () => {
  it('has the name, a title, and a description to finish, and pi can load it', () => {
    const text = skillFromTemplate(TEMPLATE, 'add-a-migration');
    expect(text).toMatch(/^---\nname: add-a-migration\ndescription: Use when /);
    expect(text).toContain('# Add a migration');
    expect(text).toContain('## When to use');
    expect(text).toContain('## Verify');
    expect(skillTextProblems(text)).toEqual([]);
  });
  it('finds the template the app ships', () => {
    expect(templateCandidates().some((file) => existsSync(file))).toBe(true);
    expect(readTemplate()).toContain('## Steps');
    expect(readTemplate(['/nowhere/SKILL.md'])).toContain('## Pitfalls');
  });
  it('titles a name', () => {
    expect(titleOf('add-a-migration')).toBe('Add a migration');
  });
});

describe('createSkill', () => {
  it('makes <agent>/skills/<name>/SKILL.md for the user and <cwd>/.pi/skills/<name> for the project', () => {
    const { agentDir, cwd } = folders();
    const user = createSkill({ name: 'one', scope: 'user', agentDir, cwd });
    expect(user.path).toBe(join(agentDir, 'skills', 'one', 'SKILL.md'));
    expect(readFileSync(user.path, 'utf8')).toBe(user.text);
    expect(user).toMatchObject({ name: 'one', scope: 'user' });
    expect(user.mtime).toBeGreaterThan(0);
    const project = createSkill({ name: 'two', scope: 'project', agentDir, cwd });
    expect(project.path).toBe(join(cwd, '.pi', 'skills', 'two', 'SKILL.md'));
  });
  it('refuses a name pi would not load, one that leaves the folder, and one that exists', () => {
    const { agentDir, cwd } = folders();
    for (const name of ['Bad Name', '../escape', 'two--hyphens', '', 'x'.repeat(65)]) expect(() => createSkill({ name, scope: 'user', agentDir, cwd }), name).toThrow();
    createSkill({ name: 'taken', scope: 'user', agentDir, cwd });
    expect(() => createSkill({ name: 'taken', scope: 'user', agentDir, cwd })).toThrow(/exists already/);
    expect(existsSync(join(agentDir, 'skills', '..', 'escape'))).toBe(false);
  });
});

describe('the editor of a skill file', () => {
  it('only opens a SKILL.md directly inside a skills folder of the user or the project', () => {
    const { agentDir, cwd } = folders();
    const made = createSkill({ name: 'one', scope: 'user', agentDir, cwd });
    expect(locateSkill(made.path, agentDir, cwd)).toEqual({ name: 'one', scope: 'user' });
    expect(readSkill(made.path, agentDir, cwd).text).toBe(made.text);
    for (const path of [join(agentDir, 'auth.json'), join(agentDir, 'skills', 'one', 'other.md'), join(agentDir, 'skills', 'one', 'deep', 'SKILL.md'), join(cwd, 'SKILL.md'), join(agentDir, 'skills', '..', 'SKILL.md')]) {
      expect(locateSkill(path, agentDir, cwd), path).toBeUndefined();
      expect(() => readSkill(path, agentDir, cwd), path).toThrow();
    }
  });

  it('saves text pi can load, over the file as it was opened', () => {
    const { agentDir, cwd } = folders();
    const made = createSkill({ name: 'one', scope: 'user', agentDir, cwd });
    const text = made.text.replace('<describe the task this skill is for>', 'migrations are added');
    const saved = saveSkill({ path: made.path, text, mtime: made.mtime, agentDir, cwd });
    expect(saved.text).toBe(text);
    expect(readFileSync(made.path, 'utf8')).toBe(text);
  });

  it('refuses text pi would not load, and a file that changed since it was opened', () => {
    const { agentDir, cwd } = folders();
    const made = createSkill({ name: 'one', scope: 'user', agentDir, cwd });
    expect(() => saveSkill({ path: made.path, text: 'just text', mtime: made.mtime, agentDir, cwd })).toThrow(/frontmatter/);
    expect(() => saveSkill({ path: made.path, text: '---\nname: one\n---\nBody', mtime: made.mtime, agentDir, cwd })).toThrow(/description/);
    expect(readFileSync(made.path, 'utf8')).toBe(made.text);
    writeFileSync(made.path, made.text + '\nmore');
    utimesSync(made.path, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
    expect(() => saveSkill({ path: made.path, text: made.text, mtime: made.mtime, agentDir, cwd })).toThrow(ChangedError);
  });
});
