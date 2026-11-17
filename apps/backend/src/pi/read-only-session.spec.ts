import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PiModule } from './load-pi';
import { readOnlySession } from './read-only-session';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pk-read-only-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const header = { type: 'session', version: 3, id: 'abc12345', timestamp: '2026-01-01T00:00:00.000Z', cwd: '/project' };
const entry = {
  type: 'message',
  id: 'u1',
  parentId: null,
  timestamp: header.timestamp,
  message: { role: 'user', content: 'hello', timestamp: Date.parse(header.timestamp) },
};

describe('readOnlySession', () => {
  it('matches SDK tree and branch semantics without repairing a missing final newline', async () => {
    const pi = await import('@earendil-works/pi-coding-agent');
    const path = join(dir, 'session.jsonl');
    const bytes = [header, entry].map((value) => JSON.stringify(value)).join('\n');
    writeFileSync(path, bytes);
    const before = statSync(path).mtimeMs;
    const manager = await readOnlySession(pi, path);
    const expected = pi.SessionManager.inMemory('/project', undefined, [header, entry] as never);
    expect(manager.getSessionId()).toBe(expected.getSessionId());
    expect(manager.getEntries()).toEqual(expected.getEntries());
    expect(manager.getBranch()).toEqual(expected.getBranch());
    expect(manager.getLeafId()).toBe(expected.getLeafId());
    expect(manager.isPersisted()).toBe(false);
    expect(readFileSync(path, 'utf8')).toBe(bytes);
    expect(statSync(path).mtimeMs).toBe(before);
  });

  it('skips malformed lines and preserves an incomplete concurrently-appended tail on disk', async () => {
    const pi = await import('@earendil-works/pi-coding-agent');
    const path = join(dir, 'partial.jsonl');
    const bytes = `${JSON.stringify(header)}\nmalformed\n${JSON.stringify(entry)}\n{"type":"message"`;
    writeFileSync(path, bytes);
    const manager = await readOnlySession(pi, path);
    expect(manager.getEntries()).toEqual([entry]);
    expect(readFileSync(path, 'utf8')).toBe(bytes);
  });

  it('rejects missing and invalid files without creating or rewriting them', async () => {
    const pi = await import('@earendil-works/pi-coding-agent');
    await expect(readOnlySession(pi, join(dir, 'missing.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' });
    const path = join(dir, 'invalid.jsonl');
    writeFileSync(path, '{}\n');
    await expect(readOnlySession(pi, path)).rejects.toThrow('not a valid session');
    expect(readFileSync(path, 'utf8')).toBe('{}\n');
  });

  it('yields during buffered parsing when its CPU budget is exhausted', async () => {
    const path = join(dir, 'many.jsonl');
    writeFileSync(path, [header, entry, entry].map((value) => JSON.stringify(value)).join('\n') + '\n');
    let ioRan = false;
    let calls = 0;
    let immediate: NodeJS.Immediate | undefined;
    // Schedule the sentinel from inside parsing, not before the async file read (which would
    // trivially let a timer run even if all subsequent parsing monopolized the event loop).
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => {
      calls++;
      if (calls === 2)
        immediate = setImmediate(() => {
          ioRan = true;
        });
      return calls === 1 ? 0 : 9;
    });
    const inMemory = vi.fn(() => {
      expect(ioRan).toBe(true);
      return {};
    });
    try {
      await readOnlySession({ SessionManager: { inMemory } } as unknown as PiModule, path);
      expect(inMemory).toHaveBeenCalledOnce();
    } finally {
      clock.mockRestore();
      if (immediate) clearImmediate(immediate);
    }
  });
});
