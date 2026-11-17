import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readSession, readTree } from './session-files';

vi.mock('./load-pi', () => ({ loadPi: () => import('@earendil-works/pi-coding-agent') }));

let dir: string;
let path: string;
let bytes: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pk-session-file-reads-'));
  path = join(dir, 'session.jsonl');
  const timestamp = '2026-01-01T00:00:00.000Z';
  bytes = [
    { type: 'session', version: 3, id: 'abc12345', timestamp, cwd: '/project' },
    {
      type: 'message',
      id: 'u1',
      parentId: null,
      timestamp,
      message: { role: 'user', content: 'first', timestamp: Date.parse(timestamp) },
    },
    {
      type: 'message',
      id: 'u2',
      parentId: null,
      timestamp,
      message: { role: 'user', content: 'other branch', timestamp: Date.parse(timestamp) },
    },
  ]
    .map((entry) => JSON.stringify(entry))
    .join('\n');
  // Deliberately no final newline: a read must not repair or modify this file.
  writeFileSync(path, bytes);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('read-only session file integration', () => {
  it('preserves file identity and returns the active branch without opening a persistent manager', async () => {
    const session = await readSession(path);
    expect(session).toMatchObject({ id: 'abc12345', path, cwd: '/project', leafId: 'u2' });
    expect(session.entries.map((entry) => entry.id)).toEqual(['u2']);
    expect(readFileSync(path, 'utf8')).toBe(bytes);
  });

  it('returns every branch and honors only valid leaf hints, without altering the file', async () => {
    const tree = await readTree(path, 'u1');
    expect(tree).toMatchObject({ path, leafId: 'u1' });
    expect(tree.entries.map((entry) => entry.id)).toEqual(['u1', 'u2']);
    expect((await readTree(path, 'nonexistent')).leafId).toBe('u2');
    expect(readFileSync(path, 'utf8')).toBe(bytes);
  });

  it('treats missing tree files as drafts but does not swallow invalid-file failures', async () => {
    await expect(readTree(join(dir, 'missing.jsonl'))).resolves.toEqual({ entries: [], leafId: null, path: undefined });
    writeFileSync(path, 'not a session\n');
    await expect(readTree(path)).rejects.toThrow('not a valid session');
    expect(readFileSync(path, 'utf8')).toBe('not a session\n');
  });
});
