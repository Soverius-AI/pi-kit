import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  changesComments,
  changesFile,
  changesList,
  changesPutComments,
  changesRevert,
  changesStage,
  provideMockApi,
  sessionOpenInEditor,
  workspaceStatusInitGit,
} from '@pi-kit/api';
import { ChatStore } from '@pi-kit/chat/api';
import { ToastStore, UiStore } from '@pi-kit/data-access';
import type { ChangesList, ReviewComment } from '@pi-kit/protocol';
import { fakeThreads, idleState, thread } from '@pi-kit/testing';
import { ThreadsStore } from '@pi-kit/threads/api';
import { ChangesStore } from './changes.store';

const file = (path: string, added = 1, removed = 0, run?: number) => ({
  path,
  status: 'M',
  added,
  removed,
  binary: false,
  ...(run ? { run } : {}),
});
const list = (...files: ReturnType<typeof file>[]): ChangesList => ({ files, git: true }) as unknown as ChangesList;
const comment = (id: string, path: string, line = 1): ReviewComment =>
  ({ id, file: path, side: 'new', line, snippet: 's', text: `note ${id}` }) as ReviewComment;

describe('ChangesStore', () => {
  let saved: ReviewComment[];
  const api = {
    changes: vi.fn(async () => list(file('src/a.ts', 3, 1, 2), file('src/b.ts'), file('README.md'))),
    diff: vi.fn(async (_id: string, _source: string, path: string) => ({ path }) as never),
    revert: vi.fn(async () => undefined),
    stage: vi.fn(async () => ({ staged: 2 })),
    reviewComments: vi.fn(async () => saved),
    putReviewComments: vi.fn(async () => undefined),
    openInEditor: vi.fn(async () => ({ opened: true })),
    initGit: vi.fn(async () => ({ git: true })),
  };
  const chat = {
    threadId: signal<string | undefined>('t1'),
    running: signal(false),
    send: vi.fn(async () => undefined),
    setRunError: vi.fn(),
  };
  let threads: ReturnType<typeof fakeThreads>;

  const make = async () => {
    const store = TestBed.inject(ChangesStore);
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(0);
    return store;
  };
  const open = async (store: ChangesStore) => {
    TestBed.inject(UiStore).setPanel('changes');
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(0);
    TestBed.tick();
    return store;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    saved = [];
    chat.threadId.set('t1');
    chat.running.set(false);
    for (const fn of [...Object.values(api), chat.send, chat.setRunError]) fn.mockClear();
    threads = fakeThreads({ selected: thread('t1') });
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: ChatStore, useValue: chat },
        { provide: ThreadsStore, useValue: threads },
        ...provideMockApi([
          [changesList, api.changes, (o) => [o.path?.['id'], o.query?.['source'], o.signal]],
          [changesFile, api.diff, (o) => [o.path?.['id'], o.query?.['source'], o.path?.['file'], o.signal]],
          [changesRevert, api.revert, (o) => [o.path?.['id'], o.body?.['source'], o.body?.['file']]],
          [changesStage, api.stage, (o) => [o.path?.['id'], o.body?.['source'], o.body?.['files']]],
          [changesComments, api.reviewComments, (o) => [o.path?.['id']]],
          [changesPutComments, api.putReviewComments, (o) => [o.path?.['id'], o.body?.['comments']]],
          [sessionOpenInEditor, api.openInEditor, (o) => [o.path?.['id'], o.body?.['path']]],
          [workspaceStatusInitGit, api.initGit, (o) => [o.path?.['id']]],
        ]),
      ],
    });
  });
  afterEach(() => vi.useRealTimers());

  it('does not fetch until the panel (or review mode) is shown, then loads the list and groups it by folder', async () => {
    const changes = await make();
    expect(api.changes).not.toHaveBeenCalled();
    await open(changes);
    expect(api.changes).toHaveBeenCalledWith('t1', 'thread', expect.anything());
    expect(changes.files()).toHaveLength(3);
    expect(changes.groups().map((g) => g.dir)).toEqual(['', 'src']);
    expect(changes.totals()).toEqual({ added: 5, removed: 1 });
    expect(threads.want).toHaveBeenCalledWith('changes', true);
  });

  it('review mode opens on the first file and fetches its diff', async () => {
    const changes = await open(await make());
    changes.open();
    expect(changes.mode()).toBe('review');
    expect(changes.selectedId()).toBe('src/a.ts');
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(0);
    expect(api.diff).toHaveBeenCalledWith('t1', 'thread', 'src/a.ts', expect.anything());
    expect(changes.model()).toMatchObject({ path: 'src/a.ts' });
    expect(changes.subtitle()).toBe('changed in run 2');
    expect(changes.viewedCount()).toBe(1);
    changes.next();
    expect(changes.selectedId()).toBe('src/b.ts');
    expect(changes.nextName()).toBe('README.md');
  });

  it('shows cached files immediately, clears the previous file while loading, and keeps unchanged models stable', async () => {
    const changes = await open(await make());
    changes.open('src/a.ts');
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(0);
    const first = changes.model();
    changes.select('src/b.ts');
    expect(changes.model()).toBeUndefined();
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(0);
    changes.select('src/a.ts');
    expect(changes.model()).toBe(first);
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(0);
    expect(changes.model()).toBe(first);
    await changes.refresh();
    expect(changes.model()).toBe(first);
  });

  it('does not reload the open diff for unrelated watcher paths, but checks same-size edits to that file', async () => {
    const changes = await open(await make());
    changes.open('src/a.ts');
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(0);
    const before = api.diff.mock.calls.length;
    threads.folderChanges.next({ paths: ['README.md'], overflow: false, headMoved: false });
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(0);
    expect(api.diff).toHaveBeenCalledTimes(before);
    threads.folderChanges.next({ paths: ['src/a.ts'], overflow: false, headMoved: false });
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(0);
    expect(api.diff).toHaveBeenCalledTimes(before + 1);
    threads.folderChanges.next({ paths: [], overflow: true, headMoved: false });
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(0);
    expect(api.diff).toHaveBeenCalledTimes(before + 2);
  });

  it('keeps a file invalidation when an unrelated watcher batch arrives while its list request is pending', async () => {
    const changes = await open(await make());
    changes.open('src/a.ts');
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(0);
    const before = api.diff.mock.calls.length;
    const listsBefore = api.changes.mock.calls.length;
    let finish!: (value: ChangesList) => void;
    api.changes.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    threads.folderChanges.next({ paths: ['src/a.ts'], overflow: false, headMoved: false });
    TestBed.tick();
    threads.folderChanges.next({ paths: ['README.md'], overflow: false, headMoved: false });
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(0);
    // The second batch does not start a second list request; it is folded into one trailing refresh.
    expect(api.changes).toHaveBeenCalledTimes(listsBefore + 1);
    finish(list(file('src/a.ts')));
    await vi.advanceTimersByTimeAsync(0);
    expect(api.changes).toHaveBeenCalledTimes(listsBefore + 2);
    expect(api.diff).toHaveBeenCalledTimes(before + 1);
    expect(changes.files()).toHaveLength(3);
  });

  it('reloads the open file when it is in the first of two changes that arrive back to back', async () => {
    const changes = await open(await make());
    changes.open('src/a.ts');
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(0);
    const before = api.diff.mock.calls.length;
    threads.folderChanges.next({ paths: ['src/a.ts'], overflow: false, headMoved: false });
    threads.folderChanges.next({ paths: ['README.md'], overflow: false, headMoved: false });
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(0);
    expect(api.diff).toHaveBeenCalledTimes(before + 1);
  });

  it('loads the new thread’s list when the thread changes while a list request is still running', async () => {
    const changes = await open(await make());
    let finish!: (value: ChangesList) => void;
    api.changes.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    threads.folderChanges.next({ paths: ['README.md'], overflow: false, headMoved: false });
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(0);
    chat.threadId.set('t2');
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(0);
    finish(list(file('stale-from-t1.ts')));
    await vi.advanceTimersByTimeAsync(0);
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(0);
    expect(api.changes).toHaveBeenLastCalledWith('t2', 'thread', expect.anything());
    expect(changes.files().map((f) => f.path)).not.toContain('stale-from-t1.ts');
    expect(changes.files()).toHaveLength(3);
  });

  it('initialises git in a folder without a repository, then lists its changes', async () => {
    api.changes.mockResolvedValueOnce({
      source: 'thread',
      cwd: '/work',
      git: false,
      files: [],
    } as unknown as ChangesList);
    const changes = await open(await make());
    expect(changes.list()?.git).toBe(false);
    const calls = api.changes.mock.calls.length;
    await changes.initGit();
    // The folder the thread works in, as everything else that acts on the folder.
    expect(api.initGit).toHaveBeenCalledWith(threads.folder());
    expect(api.changes).toHaveBeenCalledTimes(calls + 1);
    expect(changes.list()?.git).toBe(true);
    expect(changes.busy()).toBeUndefined();
  });

  it.each(['success', 'failure'])(
    'ignores late diff %s and completion while the next file is still loading',
    async (result) => {
      const changes = await open(await make());
      let finish!: (model: never) => void;
      let fail!: (error: Error) => void;
      let next!: (model: never) => void;
      const first = new Promise<never>((resolve, reject) => {
        finish = resolve;
        fail = reject;
      });
      const second = new Promise<never>((resolve) => {
        next = resolve;
      });
      const original = api.diff.getMockImplementation()!;
      api.diff.mockImplementation((_id, _source, path) => (path === 'src/a.ts' ? first : second));
      try {
        changes.open('src/a.ts');
        TestBed.tick();
        await vi.advanceTimersByTimeAsync(0);
        changes.select('src/b.ts');
        TestBed.tick();
        await vi.advanceTimersByTimeAsync(0);
        if (result === 'success') finish({ path: 'src/a.ts' } as never);
        else fail(new Error('The previous diff failed.'));
        await vi.advanceTimersByTimeAsync(0);
        expect(changes.model()).toBeUndefined();
        expect(changes.modelError()).toBeUndefined();
        expect(changes.modelLoading()).toBe(true);
        next({ path: 'src/b.ts' } as never);
        await vi.advanceTimersByTimeAsync(0);
        expect(changes.model()).toMatchObject({ path: 'src/b.ts' });
        expect(changes.modelLoading()).toBe(false);
      } finally {
        finish({ path: 'src/a.ts' } as never);
        next({ path: 'src/b.ts' } as never);
        api.diff.mockImplementation(original);
      }
    },
  );

  it('switching the source clears the selection and asks again', async () => {
    const changes = await open(await make());
    changes.select('src/b.ts');
    changes.setSource('worktree');
    expect(changes.selectedId()).toBeUndefined();
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(0);
    expect(api.changes).toHaveBeenLastCalledWith('t1', 'worktree', expect.anything());
  });

  it('a failed list is the error', async () => {
    api.changes.mockRejectedValueOnce(new Error('not a repository'));
    const changes = await open(await make());
    expect(changes.error()).toBe('not a repository');
  });

  it("loads the thread's saved batch, mirrors changes a moment later, and drops them with a reverted file", async () => {
    saved = [comment('c1', 'src/a.ts')];
    const changes = await make();
    expect(changes.comments()).toHaveLength(1);
    changes.select('src/b.ts');
    changes.save({ side: 'new', line: 4, snippet: 'x', text: 'why?' });
    expect(changes.counts().get('src/b.ts')).toBe(1);
    expect(api.putReviewComments).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(400);
    expect(api.putReviewComments).toHaveBeenCalledTimes(1);

    await changes.revert('src/a.ts');
    expect(api.revert).toHaveBeenCalledWith('t1', 'thread', 'src/a.ts');
    expect(changes.comments().map((c) => c.file)).toEqual(['src/b.ts']);
    expect(TestBed.inject(ToastStore).items().at(-1)?.text).toMatch(/dropped 1 comment/);
  });

  it('edits and removes a comment', async () => {
    const changes = await make();
    changes.select('src/a.ts');
    changes.save({ side: 'old', line: 2, snippet: 's', text: 'one' });
    const id = changes.comments()[0].id;
    changes.save({ id, side: 'old', line: 2, snippet: 's', text: 'two' });
    expect(changes.comments()[0].text).toBe('two');
    changes.remove(id);
    expect(changes.comments()).toHaveLength(0);
    changes.save({ side: 'old', line: 1, snippet: 's', text: 'x' });
    changes.discardAll();
    expect(changes.commentCount()).toBe(0);
  });

  it('send hands one message to the chat and returns to it; a failure brings the batch back', async () => {
    saved = [comment('c1', 'src/a.ts', 2), comment('c2', 'src/a.ts', 1)];
    const changes = await make();
    changes.open();
    await changes.send();
    expect(chat.send).toHaveBeenCalledTimes(1);
    expect(changes.mode()).toBe('chat');
    expect(changes.comments()).toHaveLength(0);

    saved = [comment('c3', 'src/a.ts')];
    chat.threadId.set('t2');
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(0);
    chat.send.mockRejectedValueOnce(new Error('offline'));
    await changes.send();
    expect(changes.comments()).toHaveLength(1);
    expect(chat.setRunError).toHaveBeenCalledWith({ message: 'offline' });
  });

  it('does not send while pi is running', async () => {
    saved = [comment('c1', 'src/a.ts')];
    const changes = await make();
    chat.running.set(true);
    await changes.send();
    expect(chat.send).not.toHaveBeenCalled();
  });

  it('stages every thread file, and the working tree as a whole', async () => {
    const changes = await open(await make());
    await changes.stageAll();
    expect(api.stage).toHaveBeenCalledWith('t1', 'thread', ['src/a.ts', 'src/b.ts', 'README.md']);
    expect(TestBed.inject(ToastStore).items().at(-1)?.text).toBe('Staged 2 files with git add.');
  });

  it('refreshes when the watcher ticks while shown', async () => {
    await open(await make());
    const before = api.changes.mock.calls.length;
    threads.folderChanges.next({ paths: [], overflow: true, headMoved: false });
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(0);
    expect(api.changes.mock.calls.length).toBe(before + 1);
  });
  describe('the Outcome source', () => {
    const HEAD = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
    const merged = () => thread('t1', { state: idleState({ outcome: { kind: 'merged', head: HEAD, at: 1000 } }) });

    it('exists only for a thread that has an outcome', async () => {
      const changes = await make();
      expect(changes.hasOutcome()).toBe(false);
      threads.open(merged());
      expect(changes.hasOutcome()).toBe(true);
      expect(changes.outcome()).toMatchObject({ kind: 'merged' });
    });

    it('asks for the outcome list and diffs, and says where it comes from in the header and under the file', async () => {
      threads.open(merged());
      const changes = await open(await make());
      changes.setSource('outcome');
      TestBed.tick();
      await vi.advanceTimersByTimeAsync(0);
      expect(api.changes).toHaveBeenLastCalledWith('t1', 'outcome', expect.anything());
      expect(changes.summary()).toBe('3 files, +5 −1, in the outcome, merged as a1b2c3d');
      changes.select('src/a.ts');
      TestBed.tick();
      await vi.advanceTimersByTimeAsync(0);
      expect(api.diff).toHaveBeenLastCalledWith('t1', 'outcome', 'src/a.ts', expect.anything());
      expect(changes.subtitle()).toBe('in the outcome, merged as a1b2c3d');
      expect(changes.editable()).toBe(false);
    });

    it('lets comments be written on it like on any source', async () => {
      threads.open(merged());
      const changes = await open(await make());
      changes.setSource('outcome');
      changes.select('src/b.ts');
      changes.save({ side: 'new', line: 2, snippet: 'x', text: 'is this still needed?' });
      expect(changes.counts().get('src/b.ts')).toBe(1);
    });

    it('does not revert or stage: it is committed history', async () => {
      threads.open(merged());
      const changes = await open(await make());
      changes.setSource('outcome');
      expect(await changes.revert('src/a.ts')).toBe(false);
      await changes.stageAll();
      expect(api.revert).not.toHaveBeenCalled();
      expect(api.stage).not.toHaveBeenCalled();
    });

    it('falls back to "This thread" when the open thread has no outcome, and follows a commit that moves the head', async () => {
      threads.open(merged());
      const changes = await open(await make());
      changes.setSource('outcome');
      TestBed.tick();
      await vi.advanceTimersByTimeAsync(0);
      const before = api.changes.mock.calls.length;
      // A later commit extends the outcome: the list is asked for again.
      threads.open(
        thread('t1', { state: idleState({ outcome: { kind: 'committed', head: 'f'.repeat(40), at: 2000 } }) }),
      );
      TestBed.tick();
      await vi.advanceTimersByTimeAsync(0);
      expect(api.changes.mock.calls.length).toBeGreaterThan(before);
      // Another thread, without one.
      threads.open(thread('t2'));
      TestBed.tick();
      expect(changes.source()).toBe('thread');
    });
  });
  it('regression: reverting in a previous thread preserves the current thread comments', async () => {
    saved = [comment('a', 'src/a.ts')];
    const changes = await make();
    let finish!: () => void;
    api.revert.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve(undefined);
        }),
    );
    const reverting = changes.revert('src/a.ts');
    saved = [comment('b', 'src/a.ts')];
    chat.threadId.set('t2');
    threads.open(thread('t2'));
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(0);
    expect(changes.comments().map((c) => c.id)).toEqual(['b']);
    finish();
    await reverting;
    expect(changes.comments().map((c) => c.id)).toEqual(['b']);
  });

  it('regression: late review-send failure cannot restore comments into another thread', async () => {
    saved = [comment('a', 'src/a.ts')];
    const changes = await make();
    let fail!: (error: Error) => void;
    chat.send.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          fail = reject;
        }),
    );
    const sending = changes.send();
    saved = [comment('b', 'src/b.ts')];
    chat.threadId.set('t2');
    threads.open(thread('t2'));
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(0);
    fail(new Error('old send failed'));
    await sending;
    expect(changes.comments().map((c) => c.id)).toEqual(['b']);
    await vi.advanceTimersByTimeAsync(400);
    expect(api.putReviewComments).toHaveBeenCalledWith('t1', [comment('a', 'src/a.ts')]);
    expect(chat.setRunError).not.toHaveBeenCalled();
  });

  it('restores a failed send without removing comments written while it was pending', async () => {
    saved = [comment('original', 'src/a.ts')];
    const changes = await make();
    let fail!: (error: Error) => void;
    chat.send.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          fail = reject;
        }),
    );
    const sending = changes.send();
    changes.select('src/b.ts');
    changes.save({ side: 'new', line: 1, snippet: 'new', text: 'a newer comment' });
    const newer = changes.comments()[0];
    fail(new Error('offline'));
    await sending;
    expect(changes.comments()).toEqual([comment('original', 'src/a.ts'), newer]);
  });

  it('loads saved comments again when returning to a thread with no pending edits', async () => {
    saved = [comment('old', 'src/a.ts')];
    const changes = await make();
    chat.threadId.set('t2');
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(0);
    saved = [comment('updated elsewhere', 'src/a.ts')];
    chat.threadId.set('t1');
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(0);
    expect(changes.comments()).toEqual(saved);
  });

  it('does not clear the next thread’s busy state when an older revert finishes', async () => {
    const changes = await make();
    let firstDone!: () => void;
    let secondDone!: () => void;
    api.revert.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          firstDone = () => resolve(undefined);
        }),
    );
    const first = changes.revert('src/a.ts');
    chat.threadId.set('t2');
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(0);
    api.revert.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          secondDone = () => resolve(undefined);
        }),
    );
    const second = changes.revert('src/b.ts');
    firstDone();
    await first;
    expect(changes.busy()).toBe('Reverting src/b.ts');
    secondDone();
    await second;
    expect(changes.busy()).toBeUndefined();
  });
});
