import type { PiSessionEntry } from '@pi-kit/pi-adapter';
import { createTwoFilesPatch } from 'diff';
import { describe, expect, it } from 'vitest';
import { collectTouched, normalizeToolPath, reconstructBaseline } from './touched';

const cwd = '/work/proj';
let n = 0;
const id = () => `e${++n}`;
const user = (text: string): PiSessionEntry => ({ type: 'message', id: id(), message: { role: 'user', content: text } });
const call = (callId: string, name: string, path: unknown): PiSessionEntry => ({
  type: 'message',
  id: id(),
  message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }, { type: 'toolCall', id: callId, name, arguments: { path } }] },
});
const result = (callId: string, details?: Record<string, unknown>, isError = false): PiSessionEntry => ({
  type: 'message',
  id: id(),
  message: { role: 'toolResult', toolCallId: callId, toolName: 'edit', isError, content: [{ type: 'text', text: 'done' }], ...(details ? { details } : {}) },
});
/** What pi's edit tool puts in `details.patch`. */
const patchOf = (before: string, after: string): string => createTwoFilesPatch('a.ts', 'a.ts', before, after, '', '', { context: 3 });

describe('normalizeToolPath', () => {
  it('makes relative, absolute and @-prefixed paths relative to the folder', () => {
    expect(normalizeToolPath(cwd, 'src/a.ts')).toBe('src/a.ts');
    expect(normalizeToolPath(cwd, './src/a.ts')).toBe('src/a.ts');
    expect(normalizeToolPath(cwd, '/work/proj/src/a.ts')).toBe('src/a.ts');
    expect(normalizeToolPath(cwd, '@src/a.ts')).toBe('src/a.ts');
  });

  it('refuses paths outside the folder and things that are not paths', () => {
    expect(normalizeToolPath(cwd, '../other/a.ts')).toBeUndefined();
    expect(normalizeToolPath(cwd, '/etc/hosts')).toBeUndefined();
    expect(normalizeToolPath(cwd, '/work/proj')).toBeUndefined();
    expect(normalizeToolPath(cwd, '')).toBeUndefined();
    expect(normalizeToolPath(cwd, 42)).toBeUndefined();
  });
});

describe('collectTouched', () => {
  it('lists the files of successful edit and write calls once, in the order they were first touched, with their turn', () => {
    const branch: PiSessionEntry[] = [
      user('first'),
      call('c1', 'write', 'src/new.ts'),
      result('c1'),
      call('c2', 'read', 'src/read-only.ts'),
      result('c2'),
      user('second'),
      call('c3', 'edit', '/work/proj/src/a.ts'),
      result('c3', { patch: 'p1' }),
      call('c4', 'edit', 'src/new.ts'),
      result('c4', { patch: 'p2' }),
    ];
    const touched = collectTouched(branch, cwd);
    expect(touched.map((t) => [t.path, t.turn, t.steps.map((s) => s.tool)])).toEqual([
      ['src/new.ts', 1, ['write', 'edit']],
      ['src/a.ts', 2, ['edit']],
    ]);
    expect(touched[1].steps[0].patch).toBe('p1');
  });

  it('ignores failed calls, calls without a result, and paths outside the folder', () => {
    const touched = collectTouched(
      [user('go'), call('c1', 'edit', 'a.ts'), result('c1', undefined, true), call('c2', 'write', 'b.ts'), call('c3', 'write', '/etc/x'), result('c3')],
      cwd,
    );
    expect(touched).toEqual([]);
  });
});

describe('reconstructBaseline', () => {
  const v0 = 'one\ntwo\nthree\nfour\nfive\nsix\nseven\n';
  const v1 = 'one\nTWO\nthree\nfour\nfive\nsix\nseven\n';
  const v2 = 'one\nTWO\nthree\nfour\nfive\nsix\nSEVEN\neight\n';

  it('undoes the edit patches, last first, to get the file as it was before the thread', () => {
    const steps = [
      { tool: 'edit' as const, patch: patchOf(v0, v1) },
      { tool: 'edit' as const, patch: patchOf(v1, v2) },
    ];
    expect(reconstructBaseline(v2, steps)).toBe(v0);
    expect(reconstructBaseline(v1, steps.slice(0, 1))).toBe(v0);
  });

  it('gives up when the file is no longer what the last edit left', () => {
    const steps = [{ tool: 'edit' as const, patch: patchOf(v0, v1) }];
    expect(reconstructBaseline('totally\ndifferent\n', steps)).toBeUndefined();
  });

  it('gives up when a write is among the steps (pi does not report what it replaced) or a patch is missing', () => {
    expect(reconstructBaseline(v1, [{ tool: 'write' }, { tool: 'edit', patch: patchOf(v0, v1) }])).toBeUndefined();
    expect(reconstructBaseline(v1, [{ tool: 'edit' }])).toBeUndefined();
    expect(reconstructBaseline(v1, [])).toBeUndefined();
  });
});
