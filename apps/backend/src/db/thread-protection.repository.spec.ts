import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseService } from './database.service';
import { ThreadProtectionRepository } from './thread-protection.repository';

let dir: string;
let db: DatabaseService;
let repo: ThreadProtectionRepository;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'pk-protection-'));
  db = await DatabaseService.create({ dataDir: dir });
  repo = new ThreadProtectionRepository(db);
});
afterEach(async () => {
  await db.onApplicationShutdown();
  rmSync(dir, { recursive: true, force: true });
});

describe('ThreadProtectionRepository', () => {
  it('keeps a thread’s mode until the thread is forgotten', async () => {
    expect(await repo.binding('t1')).toBeUndefined();
    await repo.setBinding('t1', { version: 1, mode: 'sandboxed', generation: 1, experimentalWindowsAccepted: true });
    await repo.setBinding('t1', { version: 1, mode: 'bypass', generation: 2, experimentalWindowsAccepted: true });
    expect(await repo.binding('t1')).toEqual({
      version: 1,
      mode: 'bypass',
      generation: 2,
      experimentalWindowsAccepted: true,
    });
    await repo.deleteBinding('t1');
    expect(await repo.binding('t1')).toBeUndefined();
  });

  it('keeps a sandbox owner until its shutdown is confirmed', async () => {
    await repo.setOwnerState('thread:t1', 'starting');
    await repo.setOwnerState('thread:t1', 'active');
    expect(await repo.ownerState('thread:t1')).toBe('active');
    await repo.clearOwner('thread:t1');
    expect(await repo.ownerState('thread:t1')).toBeUndefined();
  });
});
