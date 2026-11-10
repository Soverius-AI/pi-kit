import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseService } from './database.service';
import { ThreadProtectionRepository } from './thread-protection.repository';

let dir: string;
let repo: ThreadProtectionRepository;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pk-protection-'));
  repo = new ThreadProtectionRepository(new DatabaseService({ dataDir: dir }));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('ThreadProtectionRepository', () => {
  it('keeps a thread’s mode until the thread is forgotten', () => {
    expect(repo.binding('t1')).toBeUndefined();
    repo.setBinding('t1', { version: 1, mode: 'sandboxed', generation: 1, experimentalWindowsAccepted: true });
    repo.setBinding('t1', { version: 1, mode: 'bypass', generation: 2, experimentalWindowsAccepted: true });
    expect(repo.binding('t1')).toEqual({
      version: 1,
      mode: 'bypass',
      generation: 2,
      experimentalWindowsAccepted: true,
    });
    repo.deleteBinding('t1');
    expect(repo.binding('t1')).toBeUndefined();
  });

  it('keeps a sandbox owner until its shutdown is confirmed', () => {
    repo.setOwnerState('thread:t1', 'starting');
    repo.setOwnerState('thread:t1', 'active');
    expect(repo.ownerState('thread:t1')).toBe('active');
    repo.clearOwner('thread:t1');
    expect(repo.ownerState('thread:t1')).toBeUndefined();
  });
});
