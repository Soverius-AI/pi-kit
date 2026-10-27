import { TestBed } from '@angular/core/testing';
import {
  learnStop,
  learnedSkillsList,
  learnedSkillsRetire,
  learnedSkillsReverify,
  learnedSkillsUnretire,
  provideMockApi,
} from '@pi-kit/api';
import { ToastStore } from '@pi-kit/data-access';
import type { LearnedSkill } from '@pi-kit/protocol';

import { LearnedStore } from './learned.store';
import { ThreadShell } from './ports';
import { ThreadsStore } from './threads.store';

const skill = (over: Partial<LearnedSkill> = {}): LearnedSkill => ({
  id: 'd1',
  name: 'add-notes',
  scope: 'project',
  path: '/p/.pi/skills/add-notes/SKILL.md',
  retiredAt: null,
  missing: false,
  learnedFrom: { threadId: 't1', title: 'Add six notes', base: null, head: null },
  verification: null,
  uses: 0,
  mergedAfterUse: 0,
  threads: 0,
  lastUsedAt: null,
  flag: null,
  ...over,
});

describe('LearnedStore', () => {
  const api = {
    list: vi.fn(async (): Promise<LearnedSkill[]> => [skill(), skill({ id: 'd2', name: 'old-skill', retiredAt: 5 })]),
    retire: vi.fn(async (): Promise<LearnedSkill> => skill({ retiredAt: 9 })),
    unretire: vi.fn(async (): Promise<LearnedSkill> => skill()),
    reverify: vi.fn(async (): Promise<LearnedSkill> =>
      skill({ verification: { state: 'running', phase: 'run', stale: false } }),
    ),
  };
  const drafts = { stopVerify: vi.fn(async () => undefined) };
  const threads = { refresh: vi.fn(async () => undefined), selectedId: vi.fn((): string | undefined => 't9') };
  const shell = { skillsChanged: vi.fn(), openOutcome: vi.fn() };
  const toasts = { show: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    api.list.mockImplementation(async () => [skill(), skill({ id: 'd2', name: 'old-skill', retiredAt: 5 })]);
    api.retire.mockImplementation(async () => skill({ retiredAt: 9 }));
    api.unretire.mockImplementation(async () => skill());
    api.reverify.mockImplementation(async () =>
      skill({ verification: { state: 'running', phase: 'run', stale: false } }),
    );
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: ThreadsStore, useValue: threads },
        { provide: ThreadShell, useValue: shell },
        { provide: ToastStore, useValue: toasts },
        ...provideMockApi([
          [learnedSkillsList, api.list, () => []],
          [learnedSkillsRetire, api.retire, (o) => [o.path?.['id']]],
          [learnedSkillsUnretire, api.unretire, (o) => [o.path?.['id']]],
          [learnedSkillsReverify, api.reverify, (o) => [o.path?.['id']]],
          [learnStop, drafts.stopVerify, (o) => [o.path?.['id']]],
        ]),
      ],
    });
  });

  it('reads the record and splits live skills from retired ones; overlapping reads share one request', async () => {
    const store = TestBed.inject(LearnedStore);
    expect(store.skills()).toBeUndefined();
    await Promise.all([store.load(), store.load(), store.load()]);
    expect(api.list).toHaveBeenCalledTimes(1);
    expect(store.live().map((s) => s.name)).toEqual(['add-notes']);
    expect(store.retired().map((s) => s.name)).toEqual(['old-skill']);
  });

  it('says so when the record cannot be read, and shows an empty list', async () => {
    api.list.mockRejectedValueOnce(new Error('offline'));
    const store = TestBed.inject(LearnedStore);
    await store.load();
    expect(store.skills()).toEqual([]);
    expect(toasts.show).toHaveBeenCalledWith('error', expect.stringContaining('Could not read the learned skills'));
  });

  it('retire takes the skill out of the live list, tells the open thread to read its commands again, and keeps the skill as retired', async () => {
    const store = TestBed.inject(LearnedStore);
    await store.load();
    expect(await store.retire(store.live()[0])).toBe(true);
    expect(api.retire).toHaveBeenCalledWith('d1');
    expect(store.live()).toEqual([]);
    expect(
      store
        .retired()
        .map((s) => s.name)
        .sort(),
    ).toEqual(['add-notes', 'old-skill']);
    expect(shell.skillsChanged).toHaveBeenCalledWith('t9');
    expect(toasts.show).toHaveBeenCalledWith('info', expect.stringContaining('Retired “add-notes”'));
    expect(store.busy()).toEqual({});
  });

  it('shows the refusal under the row and leaves the skill alone', async () => {
    const store = TestBed.inject(LearnedStore);
    await store.load();
    api.retire.mockRejectedValueOnce(new Error('This skill is being verified.'));
    expect(await store.retire(store.live()[0])).toBe(false);
    expect(store.errors()['d1']).toContain('being verified');
    expect(store.live()).toHaveLength(1);
    expect(shell.skillsChanged).not.toHaveBeenCalled();
    // The next attempt starts clean.
    expect(await store.retire(store.live()[0])).toBe(true);
    expect(store.errors()).toEqual({});
  });

  it('restore brings a retired skill back into the live list', async () => {
    const store = TestBed.inject(LearnedStore);
    await store.load();
    api.unretire.mockImplementationOnce(async () => skill({ id: 'd2', name: 'old-skill' }));
    expect(await store.restore(store.retired()[0])).toBe(true);
    expect(api.unretire).toHaveBeenCalledWith('d2');
    expect(
      store
        .live()
        .map((s) => s.name)
        .sort(),
    ).toEqual(['add-notes', 'old-skill']);
    expect(shell.skillsChanged).toHaveBeenCalledWith('t9');
    expect(toasts.show).toHaveBeenCalledWith('success', expect.stringContaining('Restored “old-skill”'));
  });

  it('does not tell a thread when none is open', async () => {
    threads.selectedId.mockReturnValueOnce(undefined);
    const store = TestBed.inject(LearnedStore);
    await store.load();
    await store.retire(store.live()[0]);
    expect(shell.skillsChanged).not.toHaveBeenCalled();
  });

  it('re-verify marks the row as running and reads the record until the replay is over', async () => {
    vi.useFakeTimers();
    const store = TestBed.inject(LearnedStore);
    await store.load();
    await store.reverify(store.live()[0]);
    expect(api.reverify).toHaveBeenCalledWith('d1');
    expect(store.live()[0].verification?.state).toBe('running');
    expect(store.verifying()).toBe(true);
    api.list.mockImplementation(async () => [
      skill({ verification: { state: 'running', phase: 'compare', stale: false } }),
    ]);
    await vi.advanceTimersByTimeAsync(1600);
    expect(store.live()[0].verification?.phase).toBe('compare');
    api.list.mockImplementation(async () => [
      skill({ verification: { state: 'done', result: 'pass', at: 1, stale: false } }),
    ]);
    await vi.advanceTimersByTimeAsync(1600);
    expect(store.live()[0].verification).toMatchObject({ state: 'done', result: 'pass' });
    expect(store.verifying()).toBe(false);
    expect(threads.refresh).toHaveBeenCalled();
    expect(shell.skillsChanged).toHaveBeenCalledWith('t9');
    const calls = api.list.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(api.list.mock.calls.length).toBe(calls);
  });

  it('stop asks the draft route to stop the replay and reads the record again', async () => {
    const store = TestBed.inject(LearnedStore);
    await store.load();
    await store.stopVerify(store.live()[0]);
    expect(drafts.stopVerify).toHaveBeenCalledWith('d1');
    expect(api.list).toHaveBeenCalledTimes(2);
  });

  it('take puts a skill the dialog saved into the record', async () => {
    const store = TestBed.inject(LearnedStore);
    await store.load();
    store.take(skill({ verification: { state: 'done', result: 'partial', at: 2, stale: true } }));
    expect(store.live()[0].verification?.stale).toBe(true);
    expect(shell.skillsChanged).toHaveBeenCalledWith('t9');
  });
});
