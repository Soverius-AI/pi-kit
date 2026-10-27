import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionIndex, titleText } from './session-index';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pi-kit-index-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function writeSession(project: string, id: string, turns: number, options: { name?: string; parent?: string } = {}): string {
  const dir = join(root, 'sessions', `--${project}--`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `2026-10-15T09-00-00.000Z_${id}.jsonl`);
  const lines: unknown[] = [{ type: 'session', version: 3, id, timestamp: '2026-10-15T09:00:00.000Z', cwd: `/work/${project}`, ...(options.parent ? { parentSession: options.parent } : {}) }];
  let parent: string | null = null;
  for (let i = 1; i <= turns; i++) {
    const u = `${id}-u${i}`;
    const a = `${id}-a${i}`;
    lines.push({ type: 'message', id: u, parentId: parent, timestamp: `2026-10-15T09:${String(i % 60).padStart(2, '0')}:00.000Z`, message: { role: 'user', content: [{ type: 'text', text: `question ${i}` }], timestamp: 1_792_000_000_000 + i * 1000 } });
    lines.push({ type: 'message', id: a, parentId: u, timestamp: `2026-10-15T09:${String(i % 60).padStart(2, '0')}:30.000Z`, message: { role: 'assistant', content: [{ type: 'text', text: `answer ${i}` }, { type: 'toolCall', id: 'c', name: 'read', arguments: {} }], timestamp: 1_792_000_000_500 + i * 1000 } });
    parent = a;
  }
  if (options.name) lines.push({ type: 'session_info', id: `${id}-n`, parentId: parent, timestamp: '2026-10-15T10:00:00.000Z', name: options.name });
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return path;
}

describe('SessionIndex', () => {
  it('reads the same facts as pi’s own listAll()', async () => {
    writeSession('a', 'aaaa0001', 3, { name: 'First' });
    writeSession('a', 'aaaa0002', 1);
    writeSession('b', 'bbbb0001', 5, { parent: '/somewhere/parent.jsonl' });
    writeFileSync(join(root, 'sessions', '--a--', 'broken.jsonl'), 'not json\n');
    const pi = await import('@earendil-works/pi-coding-agent');
    const theirs = await pi.SessionManager.listAll(join(root, 'sessions', '--a--')).then(async (a) => [...a, ...(await pi.SessionManager.listAll(join(root, 'sessions', '--b--')))]);
    const ours = (await new SessionIndex(() => join(root, 'sessions')).scan()).all;
    const key = (id: string) => id;
    const pick = (s: { id: string; path: string; cwd: string; name?: string; parentSessionPath?: string; messageCount: number; firstMessage: string; created: number | Date; modified: number | Date }) => ({
      id: s.id, path: s.path, cwd: s.cwd, name: s.name, parent: s.parentSessionPath, count: s.messageCount, first: s.firstMessage, created: +s.created, modified: +s.modified,
    });
    expect(ours.map(pick).sort((x, y) => key(x.id).localeCompare(y.id))).toEqual(theirs.map(pick).sort((x, y) => key(x.id).localeCompare(y.id)));
  });

  it('reads only new and changed files on the next pass, and forgets deleted ones', async () => {
    const a = writeSession('a', 'aaaa0001', 2);
    writeSession('a', 'aaaa0002', 2);
    const index = new SessionIndex(() => join(root, 'sessions'));
    const first = await index.scan();
    expect(first).toMatchObject({ files: 2, read: 2 });
    expect((await index.scan())).toMatchObject({ files: 2, read: 0, changed: [] });

    writeSession('b', 'bbbb0001', 1);
    const third = await index.scan();
    expect(third.read).toBe(1);
    expect(third.changed.map((s) => s.id)).toEqual(['bbbb0001']);

    // A file that grew (a run appended to it) is read again, an untouched one is not.
    writeSession('a', 'aaaa0001', 4);
    const fourth = await index.scan();
    expect(fourth.changed.map((s) => [s.id, s.messageCount])).toEqual([['aaaa0001', 8]]);

    rmSync(a);
    const fifth = await index.scan();
    expect(fifth.all.map((s) => s.id).sort()).toEqual(['aaaa0002', 'bbbb0001']);
  });

  it('notices a touched file even when its size is unchanged', async () => {
    const path = writeSession('a', 'aaaa0001', 2);
    const index = new SessionIndex(() => join(root, 'sessions'));
    await index.scan();
    const later = new Date(statSync(path).mtimeMs + 5000);
    utimesSync(path, later, later);
    expect((await index.scan()).read).toBe(1);
  });

  it('names a session that opens with skill blocks by the sentence after them (the chips are drawn beside it), or by the invocations when there is no sentence', async () => {
    const path = writeSession('a', 'aaaa0003', 0);
    const block = (name: string) => `<skill name="${name}" location="/s/${name}/SKILL.md">\nReferences are relative to /s/${name}.\n\nDo ${name}.\n</skill>`;
    const user = { type: 'message', id: 'u1', parentId: null, timestamp: '2026-10-15T09:01:00.000Z', message: { role: 'user', content: `${block('alpha')}\n\n${block('beta')}\n\nsay hi`, timestamp: 1_792_000_001_000 } };
    writeFileSync(path, `${JSON.stringify({ type: 'session', version: 3, id: 'aaaa0003', timestamp: '2026-10-15T09:00:00.000Z', cwd: '/work/a' })}\n${JSON.stringify(user)}\n`);
    const [summary] = (await new SessionIndex(() => join(root, 'sessions')).scan()).all;
    expect(summary.firstMessage).toBe('say hi');
    expect(titleText('/skill:alpha /skill:beta')).toBe('/skill:alpha /skill:beta');
    expect(titleText('plain words')).toBe('plain words');
  });

  it('copes with a missing sessions folder', async () => {
    expect(await new SessionIndex(() => join(root, 'nope')).scan()).toEqual({ all: [], changed: [], files: 0, read: 0 });
  });
});
