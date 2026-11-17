import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseService } from './database.service';
import { MetaRepository } from './meta.repository';
import { ThreadsRepository } from './threads.repository';

let dir: string;
let db: DatabaseService;
let meta: MetaRepository;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'pk-projects-'));
  db = await DatabaseService.create({ dataDir: dir });
  meta = new MetaRepository(db);
});
afterEach(async () => {
  await db.onApplicationShutdown();
  rmSync(dir, { recursive: true, force: true });
});

describe('projects (workspaces)', () => {
  it('list in the order they were added, and a new one goes to the end', async () => {
    await meta.touchWorkspace('/a', 100);
    await meta.touchWorkspace('/b', 300);
    await meta.touchWorkspace('/c', 200);
    expect((await meta.listWorkspaces()).map((w) => w.cwd)).toEqual(['/a', '/b', '/c']);
    // opening one again moves its time, not its place
    await meta.touchWorkspace('/a', 999);
    expect((await meta.listWorkspaces()).map((w) => w.cwd)).toEqual(['/a', '/b', '/c']);
  });

  it('are reordered by a list; folders it does not name follow in their old order', async () => {
    for (const cwd of ['/a', '/b', '/c', '/d']) await meta.touchWorkspace(cwd);
    await meta.orderWorkspaces(['/c', '/a', '/gone']);
    expect((await meta.listWorkspaces()).map((w) => w.cwd)).toEqual(['/c', '/a', '/b', '/d']);
    await meta.touchWorkspace('/e');
    expect((await meta.listWorkspaces()).at(-1)?.cwd).toBe('/e');
  });

  it('keep the fold, hide and attendant flags per project, and patching an unknown folder says so', async () => {
    await meta.touchWorkspace('/a');
    await meta.touchWorkspace('/b');
    expect(await meta.patchWorkspace('/a', { collapsed: true, hidden: true })).toBe(true);
    expect(await meta.patchWorkspace('/b', { attendantOff: true })).toBe(true);
    expect(await meta.patchWorkspace('/zzz', { collapsed: true })).toBe(false);
    const [a, b] = await meta.listWorkspaces();
    expect([a.collapsed, a.hidden, a.attendantOff]).toEqual([true, true, false]);
    expect([b.collapsed, b.hidden, b.attendantOff]).toEqual([false, false, true]);
    await meta.patchWorkspace('/a', { collapsed: false });
    expect((await meta.listWorkspaces())[0]).toMatchObject({ collapsed: false, hidden: true });
  });

  it('a forgotten project leaves the list and stays away when a session file is read again, but comes back when the person opens it', async () => {
    for (const cwd of ['/a', '/b', '/c']) await meta.touchWorkspace(cwd);
    await meta.patchWorkspace('/b', { hidden: true });
    expect(await meta.forgetWorkspace('/b')).toBe(true);
    expect(await meta.forgetWorkspace('/b')).toBe(false);
    expect(await meta.forgetWorkspace('/zzz')).toBe(false);
    expect((await meta.listWorkspaces()).map((w) => w.cwd)).toEqual(['/a', '/c']);
    // the pass over pi's session files finds the folder again: it is not a reason to list it
    await meta.touchWorkspace('/b', Date.now(), { passive: true });
    expect((await meta.listWorkspaces()).map((w) => w.cwd)).toEqual(['/a', '/c']);
    // a passive touch of a folder nobody has seen lists it
    await meta.touchWorkspace('/d', Date.now(), { passive: true });
    expect((await meta.listWorkspaces()).map((w) => w.cwd)).toEqual(['/a', '/c', '/d']);
    // opening it again does, and its flags are as they were
    await meta.touchWorkspace('/b');
    expect((await meta.listWorkspaces()).find((w) => w.cwd === '/b')).toMatchObject({ hidden: true });
  });

  it('a thread found by the pi command line after the first pass is unseen, one found during it is seen', async () => {
    const threads = new ThreadsRepository(db);
    const facts = (id: string) => ({
      id,
      sessionPath: `/s/${id}.jsonl`,
      cwd: '/a',
      title: undefined,
      preview: 'p',
      parentSessionPath: undefined,
      messageCount: 1,
      createdAt: 1,
      updatedAt: 2,
    });
    await threads.upsertFromSession(facts('early'), 500);
    await threads.upsertFromSession(facts('late'));
    expect((await threads.get('early'))?.seenAt).toBe(500);
    expect((await threads.get('late'))?.seenAt).toBeNull();
    await threads.markSeen('late', 700);
    expect((await threads.get('late'))?.seenAt).toBe(700);
    await threads.setContext('late', 96, 123);
    expect(await threads.get('late')).toMatchObject({ contextPct: 96, contextAt: 123 });
  });
});
