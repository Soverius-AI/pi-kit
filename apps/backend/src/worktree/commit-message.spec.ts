import { describe, expect, it } from 'vitest';
import { generateCommitMessage, mergeCommitMessage } from './commit-message';

describe('generateCommitMessage', () => {
  it('says what happened to a single file', () => {
    expect(generateCommitMessage({ files: [{ path: 'src/map.ts', badge: 'M' }] })).toBe('Update map.ts\n\n- modified src/map.ts');
    expect(generateCommitMessage({ files: [{ path: 'a/new.ts', badge: 'U' }] }).split('\n')[0]).toBe('Add new.ts');
    expect(generateCommitMessage({ files: [{ path: 'old.ts', badge: 'D' }] }).split('\n')[0]).toBe('Remove old.ts');
  });

  it('names up to three files and counts the rest', () => {
    const three = generateCommitMessage({ files: ['a.ts', 'b.ts', 'c.ts'].map((path) => ({ path, badge: 'M' as const })) });
    expect(three.split('\n')[0]).toBe('Update a.ts, b.ts and c.ts');
    const five = generateCommitMessage({ files: ['a', 'b', 'c', 'd', 'e'].map((path) => ({ path: `${path}.ts`, badge: 'A' as const })) });
    expect(five.split('\n')[0]).toBe('Add a.ts, b.ts and 3 more files');
  });

  it('uses the thread title as the subject when there is one, and lists every file', () => {
    const message = generateCommitMessage({ title: 'Fix the end-to-end tests', files: [{ path: 'e2e/a.mjs', badge: 'M' }, { path: 'e2e/b.mjs', badge: 'D' }] });
    expect(message).toBe('Fix the end-to-end tests\n\n- modified e2e/a.mjs\n- removed e2e/b.mjs');
  });

  it('keeps the subject short and the list bounded', () => {
    const long = generateCommitMessage({ title: 'x'.repeat(200), files: Array.from({ length: 30 }, (_, i) => ({ path: `f${i}.ts`, badge: 'M' as const })) });
    const [subject, , ...lines] = long.split('\n');
    expect(subject.length).toBeLessThanOrEqual(72);
    expect(lines).toHaveLength(21);
    expect(lines.at(-1)).toBe('- and 10 more files');
  });

  it('has a message even without files', () => {
    expect(generateCommitMessage({ files: [] })).toBe('Update');
    expect(generateCommitMessage({ title: 'Reporting adapter', files: [] })).toBe('Reporting adapter');
  });
});

describe('mergeCommitMessage', () => {
  it('names both branches and carries the title', () => {
    expect(mergeCommitMessage('pi-kit/x', 'main')).toBe('Merge pi-kit/x into main');
    expect(mergeCommitMessage('pi-kit/x', 'main', 'Fix e2e')).toBe('Merge pi-kit/x into main\n\nFix e2e');
  });
});
