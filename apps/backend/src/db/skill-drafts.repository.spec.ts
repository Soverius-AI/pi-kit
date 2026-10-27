import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AttendantRepository } from './attendant.repository';
import { DatabaseService } from './database.service';
import { SkillDraftsRepository, draftBadge } from './skill-drafts.repository';
import { ThreadsRepository } from './threads.repository';

let dir: string;
let db: DatabaseService;
let drafts: SkillDraftsRepository;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pk-drafts-'));
  db = new DatabaseService({ dataDir: dir });
  drafts = new SkillDraftsRepository(db);
});
afterEach(() => {
  db.onApplicationShutdown();
  rmSync(dir, { recursive: true, force: true });
});

const draft = (threadId = 't1') => ({ threadId, name: 'add-a-migration', text: '---\nname: add-a-migration\ndescription: d\n---\nB\n', scope: 'project' as const, madeBy: 'attendant' as const, model: 'p/m' });

describe('skill_drafts', () => {
  it('keeps a draft as pending with the model and no decision', () => {
    const made = drafts.insert(draft(), 1000);
    expect(made).toMatchObject({ threadId: 't1', name: 'add-a-migration', state: 'pending', scope: 'project', madeBy: 'attendant', model: 'p/m', createdAt: 1000, decidedAt: null, path: null, verification: null });
    expect(drafts.forThread('t1')).toEqual(made);
    expect(drafts.pending().map((d) => d.id)).toEqual([made.id]);
    expect(drafts.all().get('t1')?.id).toBe(made.id);
  });

  it('has one draft per thread', () => {
    drafts.insert(draft());
    expect(() => drafts.insert(draft())).toThrow(/UNIQUE/);
  });

  it('moves through the states and remembers when and where', () => {
    const made = drafts.insert(draft());
    const approved = drafts.setState(made.id, 'approved', { path: '/p/.pi/skills/x/SKILL.md', now: 5000 });
    expect(approved).toMatchObject({ state: 'approved', decidedAt: 5000, path: '/p/.pi/skills/x/SKILL.md' });
    expect(drafts.pending()).toEqual([]);
    const discarded = drafts.setState(made.id, 'discarded', { now: 6000 });
    expect(discarded).toMatchObject({ state: 'discarded', decidedAt: 6000, path: null });
    expect(drafts.setState(made.id, 'pending')).toMatchObject({ state: 'pending', decidedAt: null });
  });

  it('keeps the person’s edits and a verification record', () => {
    const made = drafts.insert(draft());
    drafts.edit(made.id, { name: 'renamed', scope: 'user' });
    drafts.setVerification(made.id, { requested: true, state: 'not-run' });
    expect(drafts.get(made.id)).toMatchObject({ name: 'renamed', scope: 'user', text: made.text, verification: { requested: true, state: 'not-run' } });
    drafts.setVerification(made.id, null);
    expect(drafts.get(made.id)?.verification).toBeNull();
  });

  it('knows which drafts are being verified, and puts the result on the thread’s badge', () => {
    const made = drafts.insert(draft());
    expect(drafts.verifying()).toEqual([]);
    drafts.setVerification(made.id, { state: 'running', phase: 'run' });
    expect(drafts.verifying().map((d) => d.id)).toEqual([made.id]);
    expect(draftBadge(drafts.get(made.id))?.verification).toBe('running');
    drafts.setVerification(made.id, { state: 'done', result: 'partial' });
    expect(drafts.verifying()).toEqual([]);
    expect(draftBadge(drafts.get(made.id))?.verification).toBe('partial');
    drafts.setVerification(made.id, { state: 'error', error: 'No worktree.' });
    expect(draftBadge(drafts.get(made.id))?.verification).toBeNull();
  });

  it('reads a record it does not understand as no record', () => {
    const made = drafts.insert(draft());
    drafts.setVerification(made.id, { state: 'done' });
    db.db.prepare('UPDATE skill_drafts SET verification = ? WHERE id = ?').run('{"state":"sideways"}', made.id);
    expect(drafts.get(made.id)?.verification).toBeNull();
  });

  it('is deleted with its thread', () => {
    new ThreadsRepository(db).insertDraft({ id: 't1', sessionPath: join(dir, 't1.jsonl'), cwd: '/p', baseCommit: null });
    drafts.insert(draft());
    new ThreadsRepository(db).delete('t1');
    expect(drafts.forThread('t1')).toBeUndefined();
  });

  it('is a badge for the thread state', () => {
    const made = drafts.insert(draft());
    expect(draftBadge(made)).toEqual({ id: made.id, name: 'add-a-migration', state: 'pending', madeBy: 'attendant', verification: null });
    expect(draftBadge(undefined)).toBeNull();
  });
});

describe('the suggestion kind `learn` (the table rebuild)', () => {
  it('accepts a learn suggestion and a learn action', () => {
    const attendant = new AttendantRepository(db);
    const id = attendant.addSuggestion({ threadId: 't1', kind: 'learn', target: 'draft-1', text: 'add-a-migration', reason: 'r' });
    expect(attendant.openSuggestions('t1')).toEqual([{ id, kind: 'learn', target: 'draft-1', text: 'add-a-migration', reason: 'r' }]);
    attendant.closeLearn('draft-1', 'accepted');
    expect(attendant.openSuggestions('t1')).toEqual([]);
    attendant.addAction({ kind: 'learn', status: 'done', threadId: 't1', threadTitle: 'T', text: 'Drafted' });
    expect(attendant.actions(1)[0]).toMatchObject({ kind: 'learn', text: 'Drafted' });
  });

  it('still refuses a kind it does not know', () => {
    expect(() => db.db.prepare("INSERT INTO thread_suggestions (thread_id, kind, target, text, created_at) VALUES ('t', 'other', 'x', 'y', 1)").run()).toThrow(/CHECK/);
  });
});

describe('the record of a learned skill', () => {
  const approve = (threadId: string) => {
    const made = drafts.insert(draft(threadId));
    return drafts.setState(made.id, 'approved', { path: `/skills/${threadId}/SKILL.md`, now: 100 }) as { id: string };
  };

  it('keeps the retirement on the draft, and lists the approved drafts', () => {
    const a = approve('t1');
    drafts.insert(draft('t2'));
    expect(drafts.approved().map((d) => d.id)).toEqual([a.id]);
    expect(drafts.retiredAt(a.id)).toBeNull();
    drafts.setRetired(a.id, 5000);
    expect(drafts.retiredAt(a.id)).toBe(5000);
    expect(drafts.get(a.id)?.state).toBe('approved');
    drafts.setRetired(a.id, null);
    expect(drafts.retiredAt(a.id)).toBeNull();
    expect(drafts.retiredAt('nope')).toBeNull();
  });

  it('an approved draft outlives its thread, a pending one does not', () => {
    const threads = new ThreadsRepository(db);
    for (const id of ['t1', 't2']) threads.insertDraft({ id, sessionPath: `/s/${id}.jsonl`, cwd: '/p' });
    const a = approve('t1');
    drafts.insert(draft('t2'));
    threads.delete('t1');
    threads.delete('t2');
    expect(drafts.get(a.id)?.state).toBe('approved');
    expect(drafts.forThread('t2')).toBeUndefined();
  });
});
