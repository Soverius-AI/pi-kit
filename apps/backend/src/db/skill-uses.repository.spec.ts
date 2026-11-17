import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseService } from './database.service';
import { SkillUsesRepository } from './skill-uses.repository';

let dir: string;
let db: DatabaseService;
let uses: SkillUsesRepository;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'pk-uses-'));
  db = await DatabaseService.create({ dataDir: dir });
  uses = new SkillUsesRepository(db);
});
afterEach(async () => {
  await db.onApplicationShutdown();
  rmSync(dir, { recursive: true, force: true });
});

const use = async (threadId: string, learnedFrom = 'origin', now = 1000) =>
  await uses.record({ learnedFrom, threadId }, now);

describe('skill_uses', () => {
  it('counts every use, the threads that used the skill and the last use', async () => {
    await use('a', 'origin', 1000);
    await use('a', 'origin', 2000);
    await use('b', 'origin', 3000);
    await use('c', 'other', 4000);
    expect(await uses.summary('origin')).toEqual({
      uses: 3,
      mergedAfterUse: 0,
      lastUsedAt: 3000,
      threads: [
        { threadId: 'a', lastUseAt: 2000, outcome: null },
        { threadId: 'b', lastUseAt: 3000, outcome: null },
      ],
    });
    expect(await uses.summary('nobody')).toEqual({ uses: 0, mergedAfterUse: 0, lastUsedAt: null, threads: [] });
  });

  it('marks a thread’s uses with its outcome; merged ones are counted, and a later outcome replaces an earlier one', async () => {
    await use('a');
    await use('a');
    await use('b');
    expect(await uses.markOutcome('a', 'committed')).toBe(2);
    expect((await uses.summary('origin')).mergedAfterUse).toBe(0);
    await uses.markOutcome('a', 'merged');
    await uses.markOutcome('b', 'pr');
    expect(await uses.summary('origin')).toMatchObject({ uses: 3, mergedAfterUse: 2 });
    expect((await uses.summary('origin')).threads.map((t) => t.outcome)).toEqual(['merged', 'pr']);
    expect(await uses.markOutcome('nobody', 'merged')).toBe(0);
  });

  it('a use after an outcome starts without one', async () => {
    await use('a');
    await uses.markOutcome('a', 'merged');
    await use('a', 'origin', 5000);
    expect(await uses.summary('origin')).toMatchObject({ uses: 2, mergedAfterUse: 1 });
  });

  it('refuses an outcome kind it does not know', async () => {
    await expect(
      db.db
        .prepare("INSERT INTO skill_uses (learned_from, thread_id, at, outcome) VALUES ('o', 't', 1, 'abandoned')")
        .run(),
    ).rejects.toThrow(/CHECK/);
  });
});
