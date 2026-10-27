import { describe, expect, it } from 'vitest';
import { buildAnalysisPrompt, loadPrompt, parseDraftReply, slug, transcriptToText } from './analysis.mjs';

const transcript = {
  threadId: 't1',
  title: 'Add a migration',
  cwd: '/p',
  prompts: ['Add a migration for the invoices table with a test', 'Also run the linter'],
  toolCalls: 3,
  steps: [
    { n: 1, tool: 'read', target: 'db/schema.sql', outcome: 'ok' },
    { n: 2, tool: 'bash', target: 'npm test', outcome: 'error' },
    { n: 3, tool: 'bash', target: 'npm test', outcome: 'ok' },
  ],
  errors: [{ step: 2, tool: 'bash', target: 'npm test', message: 'migration 0003 missing', recovered: true, recoveredBy: 3 }],
  checks: [
    { step: 2, command: 'npm test', passed: false },
    { step: 3, command: 'npm test', passed: true },
  ],
  diff: 'diff --git a/db/0003.sql b/db/0003.sql\n+CREATE TABLE invoices (id INTEGER);',
  changedLines: 12,
  commitMessage: 'Add the invoices table',
  base: 'a'.repeat(40),
  head: 'b'.repeat(40),
  truncated: false,
  redactions: 0,
};

describe('the analysis prompt', () => {
  it('has a system and a user part, with the skeleton and the transcript filled in', () => {
    const { system, user } = buildAnalysisPrompt(transcript);
    expect(system).toContain('name: <lowercase words joined by single hyphens');
    expect(system).toContain('SKIP:');
    expect(system).not.toContain('{{');
    expect(user).toContain('First prompt: Add a migration for the invoices table with a test');
    expect(user).toContain('Follow-up 1: Also run the linter');
    expect(user).toContain('2. bash npm test  [failed]');
    expect(user).toContain('-> recovered at step 3');
    expect(user).toContain('- npm test  [passed]');
    expect(user).toContain('Add the invoices table');
    expect(user).toContain('+CREATE TABLE invoices');
    expect(user).not.toContain('{{');
  });

  it('says so when the thread has no outcome', () => {
    expect(transcriptToText({ ...transcript, diff: null, commitMessage: null, base: null, head: null })).toContain('no outcome yet');
    expect(transcriptToText({ ...transcript, diff: '' })).toContain('could not be read');
  });

  it('reads the two sections from the markers, whatever stands before them', () => {
    const loaded = loadPrompt({ prompt: 'ignored {{skeleton}}\n<!-- system -->\nS {{skeleton}}\n<!-- user -->\nU {{transcript}}', skeleton: 'SHAPE\n' });
    expect(loaded).toEqual({ system: 'S SHAPE', user: 'U {{transcript}}' });
  });
});

describe('parseDraftReply', () => {
  const skill = '---\nname: add-a-migration\ndescription: Use when adding a table with its migration\n---\n\n# Add a migration\n\n## Steps\n1. Write the SQL\n';

  it('reads a SKILL.md', () => {
    const parsed = parseDraftReply(skill);
    expect(parsed).toMatchObject({ ok: true, name: 'add-a-migration', description: 'Use when adding a table with its migration' });
    expect(parsed.text).toBe(`${skill.trim()}\n`.replace('---\n\n#', '---\n\n#'));
  });

  it('finds the skill inside a code fence and after a line of chatter', () => {
    expect(parseDraftReply(`Here is the skill:\n\n\`\`\`markdown\n${skill}\`\`\`\n`)).toMatchObject({ ok: true, name: 'add-a-migration' });
    expect(parseDraftReply(`Sure!\n${skill}`)).toMatchObject({ ok: true, name: 'add-a-migration' });
  });

  it('turns a name into pi’s rule and quotes a description that YAML would misread', () => {
    const parsed = parseDraftReply('---\nname: Add A Migration!\ndescription: Use when: adding a table\n---\n\nBody\n');
    expect(parsed).toMatchObject({ ok: true, name: 'add-a-migration' });
    expect(parsed.text).toContain('description: "Use when: adding a table"');
  });

  it('names a skill from its title when the model left the name out', () => {
    expect(parseDraftReply('---\ndescription: Use when X\n---\n\n# Rotate the Logs\n\nDo it.\n')).toMatchObject({ ok: true, name: 'rotate-the-logs' });
  });

  it('refuses what is not a skill, and passes on a SKIP with its reason', () => {
    expect(parseDraftReply('I could not find anything.')).toMatchObject({ ok: false, reason: expect.stringContaining('frontmatter') });
    expect(parseDraftReply('---\nname: x\n---\n\nBody')).toMatchObject({ ok: false, reason: expect.stringContaining('description') });
    expect(parseDraftReply('---\nname: x\ndescription: d\n---\n')).toMatchObject({ ok: false, reason: expect.stringContaining('instructions') });
    expect(parseDraftReply('SKIP: too specific to this repository')).toEqual({ ok: false, skip: true, reason: 'too specific to this repository' });
  });
});

describe('slug', () => {
  it('makes a pi skill name', () => {
    expect(slug('Ünïcode  Name -- here')).toBe('unicode-name-here');
    expect(slug('x'.repeat(100))).toHaveLength(64);
    expect(slug('!!!')).toBeUndefined();
  });
});
