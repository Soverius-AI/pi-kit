import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseService } from './database.service';
import { FeedbackRepository } from './feedback.repository';

let dir: string;
let db: DatabaseService;
let repo: FeedbackRepository;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'pk-feedback-'));
  db = await DatabaseService.create({ dataDir: dir });
  repo = new FeedbackRepository(db);
});
afterEach(async () => {
  await db.onApplicationShutdown();
  rmSync(dir, { recursive: true, force: true });
});

describe('FeedbackRepository', () => {
  it('starts empty', async () => {
    expect(await repo.list('t1')).toEqual([]);
  });

  it('sets a rating and lists it', async () => {
    await repo.set('t1', 'm1', 'up', 100);
    expect(await repo.list('t1')).toEqual([{ messageId: 'm1', rating: 'up', updatedAt: 100 }]);
  });

  it('changes a rating in place and keeps one row per message', async () => {
    await repo.set('t1', 'm1', 'up', 100);
    await repo.set('t1', 'm1', 'down', 200);
    expect(await repo.list('t1')).toEqual([{ messageId: 'm1', rating: 'down', updatedAt: 200 }]);
  });

  it('clears a rating with null, and clearing an unrated message is harmless', async () => {
    await repo.set('t1', 'm1', 'up', 100);
    await repo.set('t1', 'm1', null);
    await repo.set('t1', 'm2', null);
    expect(await repo.list('t1')).toEqual([]);
  });

  it('lists the ratings of one thread only, oldest first', async () => {
    await repo.set('t1', 'm2', 'down', 100);
    await repo.set('t1', 'm1', 'up', 200);
    await repo.set('t2', 'm1', 'up', 300);
    expect((await repo.list('t1')).map((e) => e.messageId)).toEqual(['m2', 'm1']);
    expect(await repo.list('t2')).toHaveLength(1);
  });

  it('keeps the original order when a rating changes', async () => {
    await repo.set('t1', 'm1', 'up', 100);
    await repo.set('t1', 'm2', 'up', 200);
    await repo.set('t1', 'm1', 'down', 300);
    expect((await repo.list('t1')).map((e) => e.messageId)).toEqual(['m1', 'm2']);
  });

  it('rejects a rating the table does not know', async () => {
    await expect(repo.set('t1', 'm1', 'meh' as never)).rejects.toThrow();
  });
});
