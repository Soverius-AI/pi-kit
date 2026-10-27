import { TestBed } from '@angular/core/testing';
import {
  provideMockApi,
  workspacesGit,
  worktreeAbort,
  worktreeHandoff,
  worktreeMerge,
  worktreeMessage,
  worktreeState,
  worktreeSync,
} from '@pi-kit/api';
import { ToastStore } from '@pi-kit/data-access';
import type {
  ProjectGit,
  WorktreeHandoffResult,
  WorktreeMergeResult,
  WorktreeStatus,
  WorktreeSyncResult,
} from '@pi-kit/protocol';
import { WorktreeReview } from './ports';

import { ThreadsStore } from './threads.store';
import { WorktreeStore } from './worktree.store';

const status = (over: Partial<WorktreeStatus> = {}): WorktreeStatus => ({
  path: '/wt/a',
  exists: true,
  branch: 'pi-kit/a',
  base: 'main',
  dirty: 0,
  ahead: 0,
  behind: 0,
  conflicts: [],
  operation: null,
  baseCheckedOut: true,
  projectDirty: 0,
  remote: false,
  gh: false,
  sharedWith: 0,
  removeFolder: 'ask',
  ...over,
});

let folderState: ProjectGit;

describe('WorktreeStore', () => {
  let current: WorktreeStatus;
  const api = {
    worktree: vi.fn(async () => current),
    worktreeMessage: vi.fn(async () => ({ message: 'Fix the adapter\n\n- modified a.ts', files: 1 })),
    syncWorktree: vi.fn(async (): Promise<WorktreeSyncResult> => ({
      status: 'synced',
      fetched: false,
      conflicts: [],
      message: 'main is in the branch now (merge).',
    })),
    abortWorktreeOperation: vi.fn(async () => undefined),
    projectGit: vi.fn(async () => folderState),
    handoff: vi.fn(
      async () =>
        ({
          to: 'local',
          path: '/p',
          branch: 'pi-kit/a',
          moved: 2,
          removed: true,
          message: 'The thread works in the project folder now.',
        }) as WorktreeHandoffResult,
    ),
    mergeWorktree: vi.fn(async (): Promise<WorktreeMergeResult> => ({
      status: 'merged',
      commit: 'abc123',
      conflicts: [],
      removed: true,
      message: 'merged',
    })),
  };
  const threads = {
    refresh: vi.fn(async () => undefined),
    selectedId: vi.fn(() => 't1'),
    select: vi.fn(),
    threads: vi.fn(() => [{ id: 't1', cwd: '/p' }]),
  };
  const changes = { setSource: vi.fn(), open: vi.fn(), refresh: vi.fn(async () => undefined) };
  const toasts = { show: vi.fn() };

  const make = () => TestBed.inject(WorktreeStore);

  beforeEach(() => {
    current = status();
    folderState = {
      git: true,
      branch: 'main',
      head: null,
      dirty: 0,
      branches: [],
      remoteBranches: [],
      hasRemote: false,
    };
    for (const fn of [...Object.values(api), ...Object.values(threads), ...Object.values(changes), toasts.show])
      fn.mockClear();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: ThreadsStore, useValue: threads },
        { provide: WorktreeReview, useValue: changes },
        { provide: ToastStore, useValue: toasts },
        ...provideMockApi([
          [worktreeState, api.worktree, (o) => [o.path?.['id']]],
          [worktreeMessage, api.worktreeMessage, (o) => [o.path?.['id']]],
          [worktreeSync, api.syncWorktree, (o) => [o.path?.['id'], o.body?.['strategy']]],
          [worktreeAbort, api.abortWorktreeOperation, (o) => [o.path?.['id']]],
          [workspacesGit, api.projectGit, (o) => [o.path?.['id']]],
          [worktreeHandoff, api.handoff, (o) => [o.path?.['id'], o.body]],
          [worktreeMerge, api.mergeWorktree, (o) => [o.path?.['id'], o.body]],
        ]),
      ],
    });
  });

  it('opens the sync dialog with the worktree’s state', async () => {
    current = status({ behind: 2, dirty: 1 });
    const store = make();
    await store.openDialog('t1', 'sync');
    expect(store.dialog()).toEqual({ threadId: 't1', mode: 'sync' });
    expect(store.status()?.behind).toBe(2);
    expect(api.worktreeMessage).not.toHaveBeenCalled();
    expect(store.busy()).toBeUndefined();
  });

  it('proposes a commit message for the merge back only when there is something to commit', async () => {
    const store = make();
    await store.openDialog('t1', 'merge');
    expect(store.message()).toBe('');
    current = status({ dirty: 2 });
    await store.openDialog('t1', 'merge');
    expect(store.message()).toContain('Fix the adapter');
  });

  it('turns to a pull request when the main checkout is not on the base and gh can do it', async () => {
    current = status({ baseCheckedOut: false, gh: true, remote: true });
    const store = make();
    await store.openDialog('t1', 'merge');
    expect(store.mergeMode()).toBe('pr');
    expect(store.canMerge()).toBe(true);
  });

  it('cannot merge while conflicts wait, without the base checked out, or without gh for a pull request', async () => {
    const store = make();
    current = status({ conflicts: ['a.ts'], operation: 'merge' });
    await store.openDialog('t1', 'merge');
    expect(store.canMerge()).toBe(false);
    current = status({ baseCheckedOut: false });
    await store.openDialog('t1', 'merge');
    expect(store.canMerge()).toBe(false);
    store.setMergeMode('pr');
    expect(store.canMerge()).toBe(false);
    current = status();
    await store.openDialog('t1', 'merge');
    expect(store.canMerge()).toBe(true);
  });

  it('syncs with the chosen strategy and reads the state again; a conflict is listed', async () => {
    const store = make();
    await store.openDialog('t1', 'sync');
    store.setStrategy('rebase');
    api.syncWorktree.mockResolvedValueOnce({
      status: 'conflict',
      fetched: false,
      conflicts: ['a.ts'],
      message: 'conflicts',
    });
    current = status({ conflicts: ['a.ts'], operation: 'merge' });
    await store.sync();
    expect(api.syncWorktree).toHaveBeenCalledWith('t1', 'rebase');
    expect(store.conflicts()).toEqual(['a.ts']);
    expect(threads.refresh).toHaveBeenCalled();
    expect(store.busy()).toBeUndefined();
  });

  it('merges back with the edited message, shows the result and refreshes the thread list when the worktree went', async () => {
    current = status({ dirty: 1 });
    const store = make();
    await store.openDialog('t1', 'merge');
    store.setMessage('My message');
    await store.merge();
    expect(api.mergeWorktree).toHaveBeenCalledWith('t1', { mode: 'merge', remove: true, message: 'My message' });
    expect(store.mergeResult()?.status).toBe('merged');
    expect(toasts.show).toHaveBeenCalledWith('success', 'merged');
    expect(threads.refresh).toHaveBeenCalled();
  });

  it('sends no message when there is nothing to commit, and keeps a failure as the dialog’s error', async () => {
    const store = make();
    await store.openDialog('t1', 'merge');
    store.setRemove(false);
    await store.merge();
    expect(api.mergeWorktree).toHaveBeenCalledWith('t1', { mode: 'merge', remove: false });
    api.mergeWorktree.mockRejectedValueOnce(new Error('The main checkout has uncommitted changes.'));
    await store.merge();
    expect(store.error()).toBe('The main checkout has uncommitted changes.');
    expect(store.busy()).toBeUndefined();
  });

  it('routes conflicts to review mode on the working tree, and closes the dialog', async () => {
    const store = make();
    await store.openDialog('t1', 'sync');
    store.reviewConflicts();
    expect(changes.setSource).toHaveBeenCalledWith('worktree');
    expect(changes.open).toHaveBeenCalled();
    expect(store.dialog()).toBeUndefined();
  });

  it('opens the thread first when the conflicts belong to another one', async () => {
    threads.selectedId.mockReturnValue('other');
    const store = make();
    await store.openDialog('t1', 'sync');
    store.reviewConflicts();
    expect(threads.select).toHaveBeenCalledWith('t1');
  });

  it('aborts a merge or rebase that waits and reads the state again', async () => {
    current = status({ conflicts: ['a.ts'], operation: 'merge' });
    const store = make();
    await store.openDialog('t1', 'sync');
    current = status();
    await store.abort();
    expect(api.abortWorktreeOperation).toHaveBeenCalledWith('t1');
    expect(store.status()?.operation).toBeNull();
  });

  describe('hand off', () => {
    it('reads the worktree and the folder; the folder must be clean before the button works', async () => {
      folderState = { ...folderState, dirty: 2 };
      const store = make();
      await store.openDialog('t1', 'handoff');
      expect(api.projectGit).toHaveBeenCalledWith('/p');
      expect(store.folder()?.dirty).toBe(2);
      expect(store.canHandoff()).toBe(false);
      folderState = { ...folderState, dirty: 0 };
      await store.openDialog('t1', 'handoff');
      expect(store.canHandoff()).toBe(true);
    });

    it("starts the removal switch from the project's rule: now and ask remove, never and after 7 days keep", async () => {
      const store = make();
      for (const [rule, remove] of [
        ['now', true],
        ['ask', true],
        ['never', false],
        ['after-7-days', false],
      ] as const) {
        current = status({ removeFolder: rule });
        await store.openDialog('t1', 'handoff');
        expect(store.handoffRemove()).toBe(remove);
      }
    });

    it('will not hand off a worktree that conflicts, waits on a merge, or is shared', async () => {
      const store = make();
      current = status({ operation: 'merge', conflicts: ['a.ts'] });
      await store.openDialog('t1', 'handoff');
      expect(store.canHandoff()).toBe(false);
      current = status({ sharedWith: 1 });
      await store.openDialog('t1', 'handoff');
      expect(store.canHandoff()).toBe(false);
    });

    it('hands off with the removal choice, says what happened and reads the list again', async () => {
      const store = make();
      await store.openDialog('t1', 'handoff');
      store.setHandoffRemove(false);
      await store.handoff();
      expect(api.handoff).toHaveBeenCalledWith('t1', { to: 'local', remove: false });
      expect(store.handoffResult()?.moved).toBe(2);
      expect(toasts.show).toHaveBeenCalledWith('success', 'The thread works in the project folder now.');
      expect(threads.refresh).toHaveBeenCalled();
      expect(store.canHandoff()).toBe(false);
    });

    it('moving a Local thread reads only the folder, offers the changes, and sends the choice', async () => {
      folderState = { ...folderState, dirty: 3 };
      const store = make();
      await store.openDialog('t1', 'move');
      expect(api.worktree).not.toHaveBeenCalled();
      expect(store.folder()?.dirty).toBe(3);
      expect(store.handoffCarry()).toBe(true);
      expect(store.canHandoff()).toBe(true);
      store.setHandoffCarry(false);
      await store.handoff();
      expect(api.handoff).toHaveBeenCalledWith('t1', { to: 'worktree', carryChanges: false });
    });

    it('says why a refusal happened and stays open', async () => {
      api.handoff.mockRejectedValueOnce(
        new Error('The folder has 2 uncommitted files. Commit or stash them, then hand off.'),
      );
      const store = make();
      await store.openDialog('t1', 'handoff');
      await store.handoff();
      expect(store.error()).toMatch(/Commit or stash them/);
      expect(store.dialog()).toBeDefined();
      expect(store.busy()).toBeUndefined();
    });

    it('merge back starts its removal switch from the same rule', async () => {
      current = status({ removeFolder: 'never' });
      const store = make();
      await store.openDialog('t1', 'merge');
      expect(store.remove()).toBe(false);
    });
  });
});
