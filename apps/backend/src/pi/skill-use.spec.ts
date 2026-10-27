import { describe, expect, it } from 'vitest';
import { expandChips, skillBlock } from '../agui/chip-expansion';
import { skillsUsedBy } from './skill-use';

const skills = [
  { name: 'add-notes', filePath: '/p/.pi/skills/add-notes/SKILL.md', baseDir: '/p/.pi/skills/add-notes' },
  { name: 'review', filePath: '/home/.pi/agent/skills/review/SKILL.md', baseDir: '/home/.pi/agent/skills/review' },
];
const resources = { skills, templates: [], read: () => '---\nname: x\ndescription: d\n---\nBody', stripFrontmatter: (c: string) => c.replace(/^---[\s\S]*?---\n/, '') };
const find = (name: string): string | undefined => skills.find((s) => s.name === name)?.filePath;

describe('skillsUsedBy: which skills a prompt uses', () => {
  it('reads the block a chip expands to (the shape pins), one use per file', () => {
    const text = expandChips([{ kind: 'skill', name: 'add-notes', pinned: false }, { kind: 'skill', name: 'review', pinned: false }], 'Write six notes', resources);
    expect(text).toContain(skillBlock(skills[0], resources));
    expect(skillsUsedBy(text, find)).toEqual([
      { name: 'add-notes', path: '/p/.pi/skills/add-notes/SKILL.md' },
      { name: 'review', path: '/home/.pi/agent/skills/review/SKILL.md' },
    ]);
  });

  it('reads a typed /skill:name command at the start of the message, and finds its file in the session’s skills', () => {
    expect(skillsUsedBy('/skill:add-notes write six notes', find)).toEqual([{ name: 'add-notes', path: '/p/.pi/skills/add-notes/SKILL.md' }]);
    expect(skillsUsedBy('  /skill:review', find)).toEqual([{ name: 'review', path: '/home/.pi/agent/skills/review/SKILL.md' }]);
  });

  it('does not count a command pi would not expand (not at the start), a skill pi does not list, or a prompt without skills', () => {
    expect(skillsUsedBy('please use /skill:add-notes here', find)).toEqual([]);
    expect(skillsUsedBy('/skill:unknown do it', find)).toEqual([]);
    expect(skillsUsedBy('Write six notes', find)).toEqual([]);
    expect(skillsUsedBy('', find)).toEqual([]);
  });

  it('counts a skill once when a chip and a typed command name the same file', () => {
    const text = `${skillBlock(skills[0], resources)}\n\n/skill:add-notes more`;
    expect(skillsUsedBy(text, find)).toHaveLength(1);
  });
});
