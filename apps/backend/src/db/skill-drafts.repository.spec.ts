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
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'pk-drafts-'));
  db = await DatabaseService.create({ dataDir: dir });
  drafts = new SkillDraftsRepository(db);
});
afterEach(async () => {
  await db.onApplicationShutdown();
  rmSync(dir, { recursive: true, force: true });
});

const draft = (threadId = 't1') => ({
  threadId,
  name: 'add-a-migration',
  text: '---\nname: add-a-migration\ndescription: d\n---\nB\n',
  scope: 'project' as const,
  madeBy: 'attendant' as const,
  model: 'p/m',
});

describe('skill_drafts', () => {
  it('keeps a draft as pending with the model and no decision', async () => {
    const made = await drafts.insert(draft(), 1000);
    expect(made).toMatchObject({
      threadId: 't1',
      name: 'add-a-migration',
      state: 'pending',
      scope: 'project',
      madeBy: 'attendant',
      model: 'p/m',
      createdAt: 1000,
      decidedAt: null,
      path: null,
      verification: null,
    });
    expect(await drafts.forThread('t1')).toEqual(made);
    expect((await drafts.pending()).map((d) => d.id)).toEqual([made.id]);
    expect((await (await drafts.all()).get('t1'))?.id).toBe(made.id);
  });

  it('has one draft per thread', async () => {
    await drafts.insert(draft());
    await expect(drafts.insert(draft())).rejects.toThrow(/UNIQUE/);
  });

  it('moves through the states and remembers when and where', async () => {
    const made = await drafts.insert(draft());
    const approved = await drafts.setState(made.id, 'approved', { path: '/p/.pi/skills/x/SKILL.md', now: 5000 });
    expect(approved).toMatchObject({ state: 'approved', decidedAt: 5000, path: '/p/.pi/skills/x/SKILL.md' });
    expect(await drafts.pending()).toEqual([]);
    const discarded = await drafts.setState(made.id, 'discarded', { now: 6000 });
    expect(discarded).toMatchObject({ state: 'discarded', decidedAt: 6000, path: null });
    expect(await drafts.setState(made.id, 'pending')).toMatchObject({ state: 'pending', decidedAt: null });
  });

  it('keeps the person’s edits and a verification record', async () => {
    const made = await drafts.insert(draft());
    await drafts.edit(made.id, { name: 'renamed', scope: 'user' });
    await drafts.setVerification(made.id, { requested: true, state: 'not-run' });
    expect(await drafts.get(made.id)).toMatchObject({
      name: 'renamed',
      scope: 'user',
      text: made.text,
      verification: { requested: true, state: 'not-run' },
    });
    await drafts.setVerification(made.id, null);
    expect((await drafts.get(made.id))?.verification).toBeNull();
  });

  it('knows which drafts are being verified, and puts the result on the thread’s badge', async () => {
    const made = await drafts.insert(draft());
    expect(await drafts.verifying()).toEqual([]);
    await drafts.setVerification(made.id, { state: 'running', phase: 'run' });
    expect((await drafts.verifying()).map((d) => d.id)).toEqual([made.id]);
    expect(draftBadge(await drafts.get(made.id))?.verification).toBe('running');
    await drafts.setVerification(made.id, { state: 'done', result: 'partial' });
    expect(await drafts.verifying()).toEqual([]);
    expect(draftBadge(await drafts.get(made.id))?.verification).toBe('partial');
    await drafts.setVerification(made.id, { state: 'error', error: 'No worktree.' });
    expect(draftBadge(await drafts.get(made.id))?.verification).toBeNull();
  });

  it('reads a record it does not understand as no record', async () => {
    const made = await drafts.insert(draft());
    await drafts.setVerification(made.id, { state: 'done' });
    await db.db.prepare('UPDATE skill_drafts SET verification = ? WHERE id = ?').run('{"state":"sideways"}', made.id);
    expect((await drafts.get(made.id))?.verification).toBeNull();
  });

  it('is deleted with its thread', async () => {
    new ThreadsRepository(db).insertDraft({
      id: 't1',
      sessionPath: join(dir, 't1.jsonl'),
      cwd: '/p',
      baseCommit: null,
    });
    await drafts.insert(draft());
    new ThreadsRepository(db).delete('t1');
    expect(await drafts.forThread('t1')).toBeUndefined();
  });

  it('is a badge for the thread state', async () => {
    const made = await drafts.insert(draft());
    expect(draftBadge(made)).toEqual({
      id: made.id,
      name: 'add-a-migration',
      state: 'pending',
      madeBy: 'attendant',
      verification: null,
    });
    expect(draftBadge(undefined)).toBeNull();
  });
});

describe('the suggestion kind `learn` (the table rebuild)', () => {
  it('accepts a learn suggestion and a learn action', async () => {
    const attendant = new AttendantRepository(db);
    const id = await attendant.addSuggestion({
      threadId: 't1',
      kind: 'learn',
      target: 'draft-1',
      text: 'add-a-migration',
      reason: 'r',
    });
    expect(await attendant.openSuggestions('t1')).toEqual([
      { id, kind: 'learn', target: 'draft-1', text: 'add-a-migration', reason: 'r' },
    ]);
    await attendant.closeLearn('draft-1', 'accepted');
    expect(await attendant.openSuggestions('t1')).toEqual([]);
    await attendant.addAction({ kind: 'learn', status: 'done', threadId: 't1', threadTitle: 'T', text: 'Drafted' });
    expect((await attendant.actions(1))[0]).toMatchObject({ kind: 'learn', text: 'Drafted' });
  });

  it('still refuses a kind it does not know', async () => {
    await expect(
      db.db
        .prepare(
          "INSERT INTO thread_suggestions (thread_id, kind, target, text, created_at) VALUES ('t', 'other', 'x', 'y', 1)",
        )
        .run(),
    ).rejects.toThrow(/CHECK/);
  });
});

describe('the record of a learned skill', () => {
  const approve = async (threadId: string) => {
    const made = await drafts.insert(draft(threadId));
    return (await drafts.setState(made.id, 'approved', { path: `/skills/${threadId}/SKILL.md`, now: 100 })) as {
      id: string;
    };
  };

  it('keeps the retirement on the draft, and lists the approved drafts', async () => {
    const a = await approve('t1');
    await drafts.insert(draft('t2'));
    expect((await drafts.approved()).map((d) => d.id)).toEqual([a.id]);
    expect(await drafts.retiredAt(a.id)).toBeNull();
    await drafts.setRetired(a.id, 5000);
    expect(await drafts.retiredAt(a.id)).toBe(5000);
    expect((await drafts.get(a.id))?.state).toBe('approved');
    await drafts.setRetired(a.id, null);
    expect(await drafts.retiredAt(a.id)).toBeNull();
    expect(await drafts.retiredAt('nope')).toBeNull();
  });

  it('an approved draft outlives its thread, a pending one does not', async () => {
    const threads = new ThreadsRepository(db);
    for (const id of ['t1', 't2']) await threads.insertDraft({ id, sessionPath: `/s/${id}.jsonl`, cwd: '/p' });
    const a = await approve('t1');
    await drafts.insert(draft('t2'));
    await threads.delete('t1');
    await threads.delete('t2');
    expect((await drafts.get(a.id))?.state).toBe('approved');
    expect(await drafts.forThread('t2')).toBeUndefined();
  });
});
