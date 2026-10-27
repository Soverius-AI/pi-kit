import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type SkillVerification, stampProvenance, stampVerified } from '@pi-kit/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseService } from '../db/database.service';
import { MetaRepository } from '../db/meta.repository';
import { SkillDraftsRepository } from '../db/skill-drafts.repository';
import { SkillUsesRepository } from '../db/skill-uses.repository';
import { ThreadsRepository } from '../db/threads.repository';
import type { SkillUse } from '../pi/skill-use';
import { LearnedSkillsService, canonicalPath } from './learned-skills.service';
import { skillHash } from './verify-rules';

const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const SKILL = '---\nname: add-notes\ndescription: Use when adding notes\n---\n\n# Steps\n1. Write them\n';

let base: string;
let project: string;
let db: DatabaseService;
let drafts: SkillDraftsRepository;
let uses: SkillUsesRepository;
let rows: ThreadsRepository;
let meta: MetaRepository;
let service: LearnedSkillsService;
let useListener: ((threadId: string, used: SkillUse[]) => void) | undefined;
let outcomeListener: ((threadId: string, kind: 'merged' | 'committed' | 'pr', firstTime: boolean) => void) | undefined;
let running: Set<string>;
let learn: { retire: ReturnType<typeof vi.fn>; unretire: ReturnType<typeof vi.fn>; saveApproved: ReturnType<typeof vi.fn>; syncApprovedText: ReturnType<typeof vi.fn> };
let verify: { start: ReturnType<typeof vi.fn> };

function addThread(id: string, title?: string): void {
  const path = join(base, `${id}.jsonl`);
  writeFileSync(path, '{}\n');
  rows.insertDraft({ id, sessionPath: path, cwd: project, baseCommit: BASE, ...(title ? { title } : {}) });
}

/** An approved skill written the way Approve writes it, with its draft. */
function approvedSkill(threadId = 'origin', name = 'add-notes'): { id: string; file: string } {
  const folder = join(project, '.pi', 'skills', name);
  mkdirSync(folder, { recursive: true });
  const text = stampProvenance(SKILL.replace('add-notes', name), { learnedFrom: threadId, base: BASE, head: HEAD });
  const file = join(folder, 'SKILL.md');
  writeFileSync(file, text);
  const draft = drafts.insert({ threadId, name, text, scope: 'project', madeBy: 'attendant', model: null });
  drafts.setState(draft.id, 'approved', { path: file });
  return { id: draft.id, file };
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'pk-learned-')));
  project = join(base, 'project');
  mkdirSync(project);
  db = new DatabaseService({ dataDir: join(base, 'data') });
  drafts = new SkillDraftsRepository(db);
  uses = new SkillUsesRepository(db);
  rows = new ThreadsRepository(db);
  meta = new MetaRepository(db);
  running = new Set();
  useListener = undefined;
  outcomeListener = undefined;
  learn = { retire: vi.fn(), unretire: vi.fn(), saveApproved: vi.fn(), syncApprovedText: vi.fn() };
  verify = { start: vi.fn() };
  const sessions = {
    onSkillsUsed: (listener: typeof useListener) => {
      useListener = listener;
      return () => undefined;
    },
    has: (id: string) => running.has(id),
    isStreaming: (id: string) => running.has(id),
  };
  const outcomes = {
    onOutcome: (listener: typeof outcomeListener) => {
      outcomeListener = listener;
      return () => undefined;
    },
    get: () => ({ base: BASE, head: HEAD }),
  };
  service = new LearnedSkillsService(drafts, uses, rows, sessions as never, outcomes as never, meta, learn as never, verify as never);
  service.onModuleInit();
  addThread('origin', 'Add six notes');
  for (const id of ['u1', 'u2', 'u3', 'u4']) addThread(id);
});

afterEach(() => {
  db.onApplicationShutdown();
  rmSync(base, { recursive: true, force: true });
});

const used = (threadId: string, file: string, name = 'add-notes'): void => useListener?.(threadId, [{ name, path: file }]);

describe('recording the uses of a learned skill', () => {
  it('counts a prompt that used a skill whose file carries x-pi-kit.learnedFrom, per prompt and per thread', () => {
    const { id, file } = approvedSkill();
    used('u1', file);
    used('u1', file);
    used('u2', file);
    const [skill] = service.list();
    expect(skill).toMatchObject({ id, name: 'add-notes', uses: 3, threads: 2, mergedAfterUse: 0, retiredAt: null, missing: false });
    expect(skill.lastUsedAt).toBeGreaterThan(0);
    expect(skill.learnedFrom).toEqual({ threadId: 'origin', title: 'Add six notes', base: BASE, head: HEAD });
  });

  it('leaves a skill alone that is not learned (no provenance), and a file that cannot be read', () => {
    approvedSkill();
    const own = join(project, '.pi', 'skills', 'mine');
    mkdirSync(own, { recursive: true });
    writeFileSync(join(own, 'SKILL.md'), SKILL.replace('add-notes', 'mine'));
    used('u1', join(own, 'SKILL.md'), 'mine');
    used('u1', join(project, 'gone', 'SKILL.md'), 'gone');
    expect(service.list()[0].uses).toBe(0);
  });

  it('counts a copy of the skill in a worktree for the thread it was learned from, and not a replay', () => {
    const { file } = approvedSkill();
    const copy = join(base, 'worktree', '.pi', 'skills', 'add-notes');
    mkdirSync(copy, { recursive: true });
    writeFileSync(join(copy, 'SKILL.md'), stampProvenance(SKILL, { learnedFrom: 'origin', base: BASE, head: HEAD }));
    used('u1', join(copy, 'SKILL.md'));
    meta.markVerificationThread('u2', 'some-draft');
    used('u2', file);
    expect(service.list()[0].uses).toBe(1);
  });

  it('treats a path through a symlink as the same file', () => {
    const { file } = approvedSkill();
    const link = join(base, 'link');
    symlinkSync(project, link);
    expect(canonicalPath(join(link, '.pi', 'skills', 'add-notes', 'SKILL.md'))).toBe(file);
    expect(canonicalPath(join(link, '.pi', 'skills', '.retired', 'x', 'SKILL.md'))).toBe(join(project, '.pi', 'skills', '.retired', 'x', 'SKILL.md'));
  });
});

describe('merged after use: the outcome of the using thread marks its uses', () => {
  it('counts the uses whose thread merged, and follows a later outcome of the thread', () => {
    const { file } = approvedSkill();
    used('u1', file);
    used('u1', file);
    used('u2', file);
    used('u3', file);
    outcomeListener?.('u1', 'merged', true);
    outcomeListener?.('u2', 'committed', true);
    expect(service.list()[0]).toMatchObject({ uses: 4, mergedAfterUse: 2, threads: 3 });
    // A commit that is later merged: the thread's latest outcome counts.
    outcomeListener?.('u2', 'merged', false);
    expect(service.list()[0].mergedAfterUse).toBe(3);
  });

  it('a use after the outcome is not followed by it', () => {
    const { file } = approvedSkill();
    used('u1', file);
    outcomeListener?.('u1', 'merged', true);
    used('u1', file);
    expect(service.list()[0]).toMatchObject({ uses: 2, mergedAfterUse: 1 });
  });

  it('ignores an outcome of a thread that never used a learned skill', () => {
    approvedSkill();
    outcomeListener?.('u4', 'merged', true);
    expect(service.list()[0].mergedAfterUse).toBe(0);
  });
});

describe('the flag', () => {
  it('flags a skill whose last three threads all ended without an outcome; a thread still running is not counted', () => {
    const { file } = approvedSkill();
    for (const id of ['u1', 'u2', 'u3']) used(id, file);
    expect(service.list()[0].flag).toMatchObject({ reason: 'no-outcomes' });
    outcomeListener?.('u2', 'committed', true);
    expect(service.list()[0].flag).toBeNull();
    // u4 runs: it is not one of the three yet, so with u2 now done only two ended threads without an outcome are left.
    running.add('u4');
    used('u4', file);
    expect(service.list()[0].flag).toBeNull();
  });

  it('flags a failed verification when none of the last three merged', () => {
    const { id, file } = approvedSkill();
    drafts.setVerification(id, { state: 'done', result: 'failed', finishedAt: 5000, skillHash: skillHash(SKILL), score: 0.1 } as SkillVerification);
    for (const t of ['u1', 'u2', 'u3']) {
      used(t, file);
      outcomeListener?.(t, 'committed', true);
    }
    expect(service.list()[0].flag).toMatchObject({ reason: 'failed-verification' });
    outcomeListener?.('u3', 'merged', false);
    expect(service.list()[0].flag).toBeNull();
  });

  it('does not flag a retired skill', async () => {
    const { id, file } = approvedSkill();
    for (const t of ['u1', 'u2', 'u3']) used(t, file);
    drafts.setRetired(id, 1000);
    expect(service.list()[0].flag).toBeNull();
  });
});

describe('the last verification', () => {
  it('comes from the draft’s record, and says when the skill was edited after it', () => {
    const { id } = approvedSkill();
    expect(service.list()[0].verification).toBeNull();
    drafts.setVerification(id, { state: 'done', result: 'pass', finishedAt: 7000, skillHash: skillHash(SKILL), summary: 'Reproduced 6 of 6 files.' } as SkillVerification);
    expect(service.list()[0].verification).toEqual({ state: 'done', result: 'pass', at: 7000, summary: 'Reproduced 6 of 6 files.', stale: false });
    drafts.setVerification(id, { state: 'done', result: 'pass', finishedAt: 7000, skillHash: 'another-text', summary: 's' } as SkillVerification);
    expect(service.list()[0].verification?.stale).toBe(true);
    drafts.setVerification(id, { state: 'running', phase: 'run' });
    expect(service.list()[0].verification).toEqual({ state: 'running', phase: 'run', stale: false });
  });

  it('falls back to the x-pi-kit.verified block of the file when the record says only that a later try did not finish', () => {
    const { id, file } = approvedSkill();
    const done = { state: 'done', result: 'partial', finishedAt: Date.UTC(2026, 9, 17, 9), files: { reproduced: 1, expected: 2, extra: 0 }, hunks: { matched: 1, expected: 2, actual: 1 } } as SkillVerification;
    writeFileSync(file, stampVerified(stampProvenance(SKILL, { learnedFrom: 'origin', base: BASE, head: HEAD }), done));
    drafts.setVerification(id, { state: 'error', error: 'The app was closed.', finishedAt: 9000 } as SkillVerification);
    expect(service.list()[0].verification).toEqual({ state: 'done', result: 'partial', at: Date.UTC(2026, 9, 17, 9), stale: false });
    drafts.setVerification(id, null);
    expect(service.list()[0].verification?.result).toBe('partial');
  });

  it('says why a try ended without a result when the file states none', () => {
    const { id } = approvedSkill();
    drafts.setVerification(id, { state: 'stopped', finishedAt: 9000 } as SkillVerification);
    expect(service.list()[0].verification).toMatchObject({ state: 'stopped', at: 9000, summary: expect.stringContaining('Stopped') });
  });
});

describe('the list and the actions', () => {
  it('lists approved skills only, retired ones with their time, by name; a deleted thread leaves the title null', () => {
    approvedSkill('origin', 'b-skill');
    const a = approvedSkill('u1', 'a-skill');
    const pending = drafts.insert({ threadId: 'u2', name: 'pending-skill', text: SKILL, scope: 'project', madeBy: 'person' });
    drafts.setRetired(a.id, 4242);
    rows.delete('u1');
    expect(service.list().map((s) => s.name)).toEqual(['a-skill', 'b-skill']);
    expect(service.list()[0]).toMatchObject({ retiredAt: 4242, learnedFrom: { threadId: 'u1', title: null } });
    expect(() => service.detail(pending.id)).toThrow(/no such learned skill/);
    expect(() => service.detail('nope')).toThrow(/no such learned skill/);
  });

  it('keeps an approved draft when its thread is deleted, and drops a pending one', () => {
    const { id } = approvedSkill('u1');
    drafts.insert({ threadId: 'u2', name: 'pending-skill', text: SKILL, scope: 'project', madeBy: 'person' });
    rows.delete('u1');
    rows.delete('u2');
    expect(drafts.get(id)?.state).toBe('approved');
    expect(drafts.forThread('u2')).toBeUndefined();
  });

  it('reports a missing file, and the detail has the text as it is on disk', () => {
    const { id, file } = approvedSkill();
    writeFileSync(file, `${SKILL}2. Hand edit\n`);
    expect(service.detail(id).text).toContain('2. Hand edit');
    rmSync(join(project, '.pi', 'skills', 'add-notes'), { recursive: true });
    expect(service.list()[0].missing).toBe(true);
  });

  it('retire, restore and save go through the learn service; re-verify syncs the file into the draft and starts the replay, and refuses a retired skill', async () => {
    const { id } = approvedSkill();
    const draft = drafts.get(id)!;
    learn.retire.mockResolvedValue(draft);
    learn.unretire.mockResolvedValue(draft);
    learn.saveApproved.mockResolvedValue(draft);
    verify.start.mockResolvedValue(draft);
    await service.retire(id);
    await service.unretire(id);
    await service.save(id, { text: SKILL });
    expect(learn.retire).toHaveBeenCalledWith(id);
    expect(learn.unretire).toHaveBeenCalledWith(id);
    expect(learn.saveApproved).toHaveBeenCalledWith(id, { text: SKILL });
    await service.reverify(id);
    expect(learn.syncApprovedText).toHaveBeenCalledWith(id);
    expect(verify.start).toHaveBeenCalledWith(id, {});
    drafts.setRetired(id, 1);
    await expect(service.reverify(id)).rejects.toThrow(/retired/);
  });
});
