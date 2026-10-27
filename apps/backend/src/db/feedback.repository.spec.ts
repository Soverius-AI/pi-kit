import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseService } from './database.service';
import { FeedbackRepository } from './feedback.repository';

let dir: string;
let repo: FeedbackRepository;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pk-feedback-'));
  repo = new FeedbackRepository(new DatabaseService({ dataDir: dir }));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('FeedbackRepository', () => {
  it('starts empty', () => {
    expect(repo.list('t1')).toEqual([]);
  });

  it('sets a rating and lists it', () => {
    repo.set('t1', 'm1', 'up', 100);
    expect(repo.list('t1')).toEqual([{ messageId: 'm1', rating: 'up', updatedAt: 100 }]);
  });

  it('changes a rating in place and keeps one row per message', () => {
    repo.set('t1', 'm1', 'up', 100);
    repo.set('t1', 'm1', 'down', 200);
    expect(repo.list('t1')).toEqual([{ messageId: 'm1', rating: 'down', updatedAt: 200 }]);
  });

  it('clears a rating with null, and clearing an unrated message is harmless', () => {
    repo.set('t1', 'm1', 'up', 100);
    repo.set('t1', 'm1', null);
    repo.set('t1', 'm2', null);
    expect(repo.list('t1')).toEqual([]);
  });

  it('lists the ratings of one thread only, oldest first', () => {
    repo.set('t1', 'm2', 'down', 100);
    repo.set('t1', 'm1', 'up', 200);
    repo.set('t2', 'm1', 'up', 300);
    expect(repo.list('t1').map((e) => e.messageId)).toEqual(['m2', 'm1']);
    expect(repo.list('t2')).toHaveLength(1);
  });

  it('keeps the original order when a rating changes', () => {
    repo.set('t1', 'm1', 'up', 100);
    repo.set('t1', 'm2', 'up', 200);
    repo.set('t1', 'm1', 'down', 300);
    expect(repo.list('t1').map((e) => e.messageId)).toEqual(['m1', 'm2']);
  });

  it('rejects a rating the table does not know', () => {
    expect(() => repo.set('t1', 'm1', 'meh' as never)).toThrow();
  });
});
