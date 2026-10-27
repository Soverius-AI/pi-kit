import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  learnApprove,
  learnDiscard,
  learnForThread,
  learnPlan,
  learnReopen,
  learnRequest,
  learnStart,
  learnStop,
  learnWorkspace,
  learnedSkillsGet,
  learnedSkillsList,
  learnedSkillsSave,
  provideMockApi,
} from '@pi-kit/api';
import { ToastStore } from '@pi-kit/data-access';
import type {
  LearnedSkill,
  LearnedSkillDetail,
  SkillDraft,
  SkillVerification,
  StartVerify,
  ThreadSummary,
  VerifyPlan,
} from '@pi-kit/protocol';
import { idleState, thread } from '@pi-kit/testing';

import { LearnStore } from './learn.store';
import { LearnedStore } from './learned.store';
import { OutcomeMenuStore } from './outcome-menu.store';
import { ThreadShell } from './ports';
import { ThreadsStore } from './threads.store';

const TEXT = '---\nname: add-a-migration\ndescription: Use when adding a table\n---\n\n# Steps\n1. Do it\n';
const draft = (over: Partial<SkillDraft> = {}): SkillDraft => ({
  id: 'd1',
  threadId: 't1',
  name: 'add-a-migration',
  text: TEXT,
  scope: 'project',
  state: 'pending',
  verification: null,
  madeBy: 'attendant',
  model: 'p/m',
  createdAt: 1,
  decidedAt: null,
  path: null,
  ...over,
});
const HEAD = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const plan = (over: Partial<VerifyPlan> = {}): VerifyPlan => ({
  canVerify: true,
  prompt: 'Create the notes.',
  base: HEAD,
  head: HEAD,
  files: 6,
  checks: [],
  model: null,
  busy: false,
  ...over,
});
const done = (over: Partial<SkillVerification> = {}): SkillVerification => ({
  state: 'done',
  result: 'pass',
  files: { reproduced: 6, expected: 6, extra: 0 },
  hunks: { matched: 6, expected: 6, actual: 6 },
  ...over,
});

describe('LearnStore', () => {
  const api = {
    workspace: vi.fn(async () => ({ id: 'learning-t1' })),
    draft: vi.fn(async () => draft()),
    request: vi.fn(
      async (): Promise<{ status: 'drafted' | 'consent'; draft?: SkillDraft; model?: string; message?: string }> => ({
        status: 'drafted',
        draft: draft(),
      }),
    ),
    approve: vi.fn(
      async (_id: string, body: { name: string; scope: 'project' | 'user'; text: string; verify?: boolean }) => ({
        draft: draft({ state: 'approved', name: body.name, path: '/p/.pi/skills/x/SKILL.md' }),
        path: '/p/.pi/skills/x/SKILL.md',
      }),
    ),
    discard: vi.fn(async () => draft({ state: 'discarded' })),
    reopen: vi.fn(async () => draft()),
    verifyPlan: vi.fn(async (): Promise<VerifyPlan> => plan()),
    verify: vi.fn<(id: string, body: StartVerify) => Promise<SkillDraft>>(async () =>
      draft({ verification: { state: 'running', phase: 'worktree' } }),
    ),
    stopVerify: vi.fn(async (): Promise<SkillDraft> => draft({ verification: { state: 'stopped' } })),
  };
  const threads = {
    refresh: vi.fn(async () => undefined),
    threads: signal<ThreadSummary[]>([]),
    selectedId: vi.fn(() => 't1'),
    select: vi.fn(),
  };
  const shell = { skillsChanged: vi.fn(), openOutcome: vi.fn() };
  const toasts = { show: vi.fn() };
  const learned: LearnedSkill = {
    id: 'd1',
    name: 'add-a-migration',
    scope: 'project',
    path: '/p/.pi/skills/add-a-migration/SKILL.md',
    retiredAt: null,
    missing: false,
    learnedFrom: { threadId: 't1', title: 'Add the invoices table', base: null, head: null },
    verification: null,
    uses: 2,
    mergedAfterUse: 1,
    threads: 2,
    lastUsedAt: 1,
    flag: null,
  };
  const approvedDraft = (over: Partial<SkillDraft> = {}): SkillDraft =>
    draft({ state: 'approved', path: learned.path, ...over });
  const learnedApi = {
    get: vi.fn(async (): Promise<LearnedSkillDetail> => ({ ...learned, text: TEXT, draft: approvedDraft() })),
    list: vi.fn(async (): Promise<LearnedSkill[]> => [learned]),
    save: vi.fn(async (_id: string, _text: string): Promise<LearnedSkill> => ({
      ...learned,
      verification: { state: 'done', result: 'pass', stale: true },
    })),
  };
  const make = () => TestBed.inject(LearnStore);

  beforeEach(() => {
    for (const fn of [
      ...Object.values(api),
      ...Object.values(threads).filter((v) => typeof v === 'function'),
      shell.skillsChanged,
      toasts.show,
    ] as ReturnType<typeof vi.fn>[])
      fn.mockClear?.();
    threads.selectedId.mockReturnValue('t1');
    threads.threads.set([]);
    api.workspace.mockImplementation(async () => ({ id: 'learning-t1' }));
    api.draft.mockImplementation(async () => draft());
    api.request.mockImplementation(async () => ({ status: 'drafted', draft: draft() }));
    api.approve.mockImplementation(async (_id, body) => ({
      draft: draft({ state: 'approved', name: body.name, path: '/p/.pi/skills/x/SKILL.md' }),
      path: '/p/.pi/skills/x/SKILL.md',
    }));
    api.verifyPlan.mockImplementation(async () => plan());
    api.verify.mockImplementation(async () => draft({ verification: { state: 'running', phase: 'worktree' } }));
    api.stopVerify.mockImplementation(async () => draft({ verification: { state: 'stopped' } }));
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: ThreadsStore, useValue: threads },
        { provide: ThreadShell, useValue: shell },
        { provide: ToastStore, useValue: toasts },
        ...provideMockApi([
          [learnWorkspace, api.workspace, () => []],
          [learnForThread, api.draft, (o) => [o.path?.['id']]],
          [learnRequest, api.request, (o) => [o.path?.['id'], o.body?.['consent']]],
          [learnApprove, api.approve, (o) => [o.path?.['id'], o.body]],
          [learnDiscard, api.discard, (o) => [o.path?.['id']]],
          [learnReopen, api.reopen, (o) => [o.path?.['id']]],
          [learnPlan, api.verifyPlan, (o) => [o.path?.['id']]],
          [learnStart, api.verify, (o) => [o.path?.['id'], o.body]],
          [learnStop, api.stopVerify, (o) => [o.path?.['id']]],
          [learnedSkillsGet, learnedApi.get, (o) => [o.path?.['id']]],
          [learnedSkillsList, learnedApi.list, () => []],
          [learnedSkillsSave, learnedApi.save, (o) => [o.path?.['id'], o.body?.['text']]],
        ]),
      ],
    });
  });

  describe('reading', () => {
    it('opens the review on the thread’s draft: the text as pi loads it, the scope, Verify first on', async () => {
      const store = make();
      await store.read('t1');
      expect(store.dialog()).toEqual({ threadId: 't1', view: 'review' });
      expect(store.text()).toBe(TEXT);
      expect(store.name()).toBe('add-a-migration');
      expect(store.scope()).toBe('project');
      expect(store.verify()).toBe(true);
      expect(store.canApprove()).toBe(true);
    });

    it('shows why a draft could not be read', async () => {
      api.draft.mockRejectedValueOnce(new Error('This thread has no skill draft.'));
      const store = make();
      await store.read('t1');
      expect(store.error()).toBe('This thread has no skill draft.');
      expect(store.draft()).toBeUndefined();
    });
  });

  describe('editing', () => {
    it('the name field writes the text’s name line, and the text’s name is the name', async () => {
      const store = make();
      await store.read('t1');
      store.setName('migrations-with-tests');
      expect(store.text()).toContain('name: migrations-with-tests\n');
      expect(store.text()).toContain('# Steps');
      store.setText(store.text().replace('migrations-with-tests', 'by-hand'));
      expect(store.name()).toBe('by-hand');
    });

    it('cannot be approved while the name or the text is wrong', async () => {
      const store = make();
      await store.read('t1');
      store.setName('Not A Name');
      expect(store.canApprove()).toBe(false);
      expect(store.problems()[0]).toContain('lowercase');
      store.setName('ok-name');
      store.setText('---\nname: ok-name\n---\nbody');
      expect(store.problems()).toEqual([expect.stringContaining('description')]);
      expect(store.canApprove()).toBe(false);
    });
  });

  describe('Approve', () => {
    it('sends the final name, scope, text and the Verify wish, then closes and tells the shell', async () => {
      const store = make();
      await store.read('t1');
      store.setName('final-name');
      store.setScope('user');
      store.setVerify(false);
      const sent = store.text();
      expect(sent).toContain('name: final-name');
      await store.approve();
      expect(api.approve).toHaveBeenCalledWith('d1', { name: 'final-name', scope: 'user', text: sent, verify: false });
      expect(store.dialog()).toBeUndefined();
      expect(toasts.show).toHaveBeenCalledWith('success', 'Learned “final-name”. It is in the / menu now.');
      expect(shell.skillsChanged).toHaveBeenCalledWith('t1');
      expect(threads.refresh).toHaveBeenCalled();
    });

    it('keeps the dialog open with the reason when the name is taken, so the person can choose another', async () => {
      api.approve.mockRejectedValueOnce(
        new Error('A folder named add-a-migration already exists. Choose another name.'),
      );
      const store = make();
      await store.read('t1');
      await store.approve();
      expect(store.dialog()).toBeDefined();
      expect(store.error()).toContain('Choose another name');
      expect(store.busy()).toBeUndefined();
      expect(shell.skillsChanged).not.toHaveBeenCalled();
      store.setName('another');
      expect(store.error()).toBeUndefined();
      await store.approve();
      expect(store.dialog()).toBeUndefined();
    });

    it('does nothing for a draft that is not pending', async () => {
      api.draft.mockResolvedValueOnce(draft({ state: 'discarded' }));
      const store = make();
      await store.read('t1');
      await store.approve();
      expect(api.approve).not.toHaveBeenCalled();
    });
  });

  describe('verification', () => {
    afterEach(() => vi.useRealTimers());

    it('loads what a replay would do when the draft is read, and the prompt is the thread’s', async () => {
      const store = make();
      await store.read('t1');
      await vi.waitFor(() => expect(store.plan()).toBeDefined());
      expect(api.verifyPlan).toHaveBeenCalledWith('d1');
      expect(store.prompt()).toBe('Create the notes.');
      expect(store.step()).toEqual({ action: 'verify', label: 'Verify first' });
    });

    it('works without a plan: the dialog still opens, and the button then tries to replay', async () => {
      api.verifyPlan.mockRejectedValueOnce(new Error('nope'));
      const store = make();
      await store.read('t1');
      await new Promise((resolve) => setTimeout(resolve));
      expect(store.plan()).toBeUndefined();
      expect(store.error()).toBeUndefined();
      expect(store.step().action).toBe('verify');
    });

    it('does not replace a prompt the person edited when the plan arrives late', async () => {
      const store = make();
      const reading = store.read('t1');
      await reading;
      store.setPrompt('My own prompt');
      await vi.waitFor(() => expect(store.plan()).toBeDefined());
      expect(store.prompt()).toBe('My own prompt');
      expect(store.promptEdited()).toBe(true);
    });

    it('the primary button replays with the text and, if edited, the prompt, instead of approving', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const store = make();
      await store.read('t1');
      await vi.advanceTimersByTimeAsync(0);
      store.setName('final-name');
      store.setPrompt('Do it again.');
      const sent = store.text();
      expect(sent).toContain('name: final-name');
      await store.primary();
      expect(api.approve).not.toHaveBeenCalled();
      expect(api.verify).toHaveBeenCalledWith('d1', { name: 'final-name', text: sent, prompt: 'Do it again.' });
      expect(store.running()).toBe(true);
      expect(store.step()).toEqual({ action: 'wait', label: 'Verifying…' });
      expect(store.canPrimary()).toBe(false);
      expect(store.busy()).toBeUndefined();
    });

    it('does not send the prompt when it was not edited, and does not replay twice at once', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const store = make();
      await store.read('t1');
      await store.runVerify();
      expect(api.verify).toHaveBeenCalledWith('d1', { name: 'add-a-migration', text: TEXT });
      await store.runVerify();
      expect(api.verify).toHaveBeenCalledTimes(1);
    });

    it('asks for the report until the replay ends, then takes the text it ended with and refreshes the list', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const store = make();
      await store.read('t1');
      threads.refresh.mockClear();
      await store.runVerify();
      api.draft.mockResolvedValueOnce(draft({ verification: { state: 'running', phase: 'run' } }));
      await vi.advanceTimersByTimeAsync(1500);
      expect(store.verification()?.phase).toBe('run');
      expect(threads.refresh).not.toHaveBeenCalled();
      const verifiedText = TEXT.replace('1. Do it', '1. Do it\n2. Verified');
      api.draft.mockResolvedValueOnce(draft({ text: verifiedText, verification: done() }));
      await vi.advanceTimersByTimeAsync(1500);
      expect(store.running()).toBe(false);
      expect(store.verification()?.result).toBe('pass');
      expect(store.text()).toBe(verifiedText);
      expect(store.stale()).toBe(false);
      expect(store.step()).toEqual({ action: 'approve', label: 'Approve' });
      expect(threads.refresh).toHaveBeenCalled();
      // It stopped asking.
      const calls = api.draft.mock.calls.length;
      await vi.advanceTimersByTimeAsync(5000);
      expect(api.draft.mock.calls.length).toBe(calls);
    });

    it('an edit after the report makes it stale, and the primary button replays again', async () => {
      api.draft.mockResolvedValue(draft({ verification: done() }));
      const store = make();
      await store.read('t1');
      expect(store.stale()).toBe(false);
      expect(store.step().action).toBe('approve');
      store.setText(`${TEXT}Also this.\n`);
      expect(store.stale()).toBe(true);
      expect(store.step()).toEqual({ action: 'verify', label: 'Verify again' });
    });

    it('a draft that cannot be replayed is approved as it is', async () => {
      api.verifyPlan.mockResolvedValue(plan({ canVerify: false, reason: 'The thread has no outcome yet.' }));
      const store = make();
      await store.read('t1');
      await vi.waitFor(() => expect(store.plan()).toBeDefined());
      expect(store.step()).toEqual({
        action: 'approve',
        label: 'Approve',
        note: 'Cannot verify first, so Approve goes ahead without a report.',
      });
      await store.primary();
      expect(api.approve).toHaveBeenCalledTimes(1);
      expect(api.verify).not.toHaveBeenCalled();
    });

    it('with Verify first off the primary button approves at once', async () => {
      const store = make();
      await store.read('t1');
      store.setVerify(false);
      await store.primary();
      expect(api.verify).not.toHaveBeenCalled();
      expect(api.approve).toHaveBeenCalledTimes(1);
    });

    it('stopping asks the server and shows the draft as it comes back', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const store = make();
      await store.read('t1');
      await store.runVerify();
      await store.stopVerify();
      expect(api.stopVerify).toHaveBeenCalledWith('d1');
      expect(store.verification()?.state).toBe('stopped');
      await store.stopVerify();
      expect(api.stopVerify).toHaveBeenCalledTimes(1);
    });

    it('shows a refusal to start (another replay runs, no outcome) and stays usable', async () => {
      api.verify.mockRejectedValueOnce(new Error('Another skill is being verified. One replay runs at a time.'));
      const store = make();
      await store.read('t1');
      await store.runVerify();
      expect(store.error()).toContain('One replay runs at a time');
      expect(store.busy()).toBeUndefined();
      expect(store.running()).toBe(false);
    });

    it('opening a draft that is being replayed picks the polling up, and closing the dialog stops it', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      api.draft.mockResolvedValue(draft({ verification: { state: 'running', phase: 'run' } }));
      const store = make();
      await store.read('t1');
      expect(store.running()).toBe(true);
      await vi.advanceTimersByTimeAsync(1500);
      const calls = api.draft.mock.calls.length;
      expect(calls).toBeGreaterThan(1);
      store.close();
      await vi.advanceTimersByTimeAsync(6000);
      expect(api.draft.mock.calls.length).toBe(calls);
    });

    it('a replay of an approved skill sends no text: the written file is what is replayed', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      api.draft.mockResolvedValue(draft({ state: 'approved', path: '/p/.pi/skills/x/SKILL.md', verification: done() }));
      const store = make();
      await store.read('t1');
      await store.runVerify();
      expect(api.verify).toHaveBeenCalledWith('d1', {});
    });
  });

  describe('Discard and reopen', () => {
    it('discards, writes nothing, closes and says so', async () => {
      const store = make();
      await store.read('t1');
      await store.discard();
      expect(api.discard).toHaveBeenCalledWith('d1');
      expect(api.approve).not.toHaveBeenCalled();
      expect(store.dialog()).toBeUndefined();
      expect(toasts.show).toHaveBeenCalledWith('info', expect.stringContaining('Nothing was written'));
    });

    it('reopens a discarded draft inside the dialog', async () => {
      api.draft.mockResolvedValueOnce(draft({ state: 'discarded' }));
      const store = make();
      await store.read('t1');
      expect(store.pending()).toBe(false);
      await store.reopen();
      expect(api.reopen).toHaveBeenCalledWith('d1');
      expect(store.pending()).toBe(true);
    });
  });

  describe('non-modal learning workspaces', () => {
    it('does not steal selection when workspace creation completes after switching chats', async () => {
      let finish!: (workspace: { id: string }) => void;
      api.workspace.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const store = make();
      const opening = store.request('t1');
      threads.selectedId.mockReturnValue('another-chat');
      finish({ id: 'learning-t1' });
      await opening;
      expect(threads.select).not.toHaveBeenCalled();
      expect(store.draft()?.threadId).toBe('t1');
      expect(store.dialog()?.view).toBe('review');
    });

    it('attaches a late verification start to its own cached workspace', async () => {
      const store = make();
      await store.read('t1');
      let finish!: (draft: SkillDraft) => void;
      api.verify.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const starting = store.runVerify();
      api.draft.mockResolvedValueOnce(draft({ id: 'd2', threadId: 't2' }));
      await store.read('t2');
      finish(draft({ verification: { state: 'running', phase: 'run' } }));
      await starting;
      expect(store.draft()?.id).toBe('d2');
      expect(store.running()).toBe(false);
      store.resume('t1');
      expect(store.running()).toBe(true);
      expect(store.busy()).toBeUndefined();
      store.close();
    });

    it('restores unsaved review text when returning from another learning workspace', async () => {
      const store = make();
      await store.read('t1');
      const edited = TEXT + '\nKeep this local edit.\n';
      store.setText(edited);
      api.draft.mockResolvedValueOnce(draft({ id: 'd2', threadId: 't2' }));
      await store.read('t2');
      expect(store.dialog()?.threadId).toBe('t2');
      store.resume('t1');
      expect(store.dialog()?.threadId).toBe('t1');
      expect(store.text()).toBe(edited);
    });
  });

  describe('asking for a draft', () => {
    it('opens the review when the draft is made', async () => {
      const store = make();
      await store.request('t1');
      expect(api.request).toHaveBeenCalledWith('t1', undefined);
      expect(store.dialog()).toEqual({ threadId: 't1', view: 'review' });
    });

    it('asks for consent while the attendant is off, and sends the thread only after the person agrees', async () => {
      api.request.mockResolvedValueOnce({
        status: 'consent',
        model: 'p/m',
        message: 'This sends the thread’s transcript to p/m…',
      });
      const store = make();
      await store.request('t1');
      expect(store.dialog()).toEqual({ threadId: 't1', view: 'consent' });
      expect(store.consent()).toEqual({ model: 'p/m', message: 'This sends the thread’s transcript to p/m…' });
      expect(api.request).toHaveBeenCalledTimes(1);
      await store.agree();
      expect(api.request).toHaveBeenLastCalledWith('t1', true);
      expect(store.dialog()?.view).toBe('review');
    });

    it('declining sends nothing', async () => {
      api.request.mockResolvedValueOnce({ status: 'consent', model: 'p/m', message: 'm' });
      const store = make();
      await store.request('t1');
      store.close();
      expect(store.dialog()).toBeUndefined();
      expect(api.request).toHaveBeenCalledTimes(1);
    });

    it('shows a refusal (no model, the cap, a model that did not write a skill)', async () => {
      api.request.mockRejectedValueOnce(new Error('The attendant’s daily cost cap is reached.'));
      const store = make();
      await store.request('t1');
      expect(store.error()).toContain('cost cap');
      expect(store.dialog()?.view).toBe('working');
    });

    it('leaves a dialog that was closed while the model worked closed, and points at the card', async () => {
      const store = make();
      api.request.mockImplementationOnce(async () => {
        store.close();
        return { status: 'drafted', draft: draft() };
      });
      await store.request('t1');
      expect(store.dialog()).toBeUndefined();
      expect(toasts.show).toHaveBeenCalledWith('info', expect.stringContaining('card at the end of the thread'));
    });
  });

  describe('the thread menus', () => {
    const withState = (state: Partial<ThreadSummary['state']>, messageCount = 4): ThreadSummary =>
      thread('t1', { messageCount, state: idleState(state) });

    it('ask for a draft, read a pending one, reopen a discarded one', async () => {
      const store = make();
      await store.learnFrom(withState({}));
      expect(api.request).toHaveBeenCalledTimes(1);
      await store.learnFrom(withState({ draft: { id: 'd1', name: 'n', state: 'pending', madeBy: 'attendant' } }));
      expect(api.draft).toHaveBeenCalledTimes(1);
      await store.learnFrom(withState({ draft: { id: 'd1', name: 'n', state: 'discarded', madeBy: 'attendant' } }));
      expect(api.reopen).toHaveBeenCalledWith('d1');
      expect(api.draft).toHaveBeenCalledTimes(2);
    });

    it('do nothing for a thread without messages or one that was learned', async () => {
      const store = make();
      await store.learnFrom(withState({}, 0));
      await store.learnFrom(withState({ draft: { id: 'd1', name: 'n', state: 'approved', madeBy: 'person' } }));
      expect(api.request).not.toHaveBeenCalled();
      expect(api.draft).not.toHaveBeenCalled();
    });
  });

  describe('the outcome badge’s menu (extension point)', () => {
    it('gains "Learn a skill from this thread", "Read the skill draft" or "Reopen the skill draft" after the built-in items', () => {
      const rows = signal<ThreadSummary[]>([
        thread('plain', { messageCount: 3, state: idleState({ outcome: { kind: 'merged', head: HEAD, at: 1 } }) }),
        thread('pending', {
          messageCount: 3,
          state: idleState({
            outcome: { kind: 'merged', head: HEAD, at: 1 },
            draft: { id: 'd', name: 'n', state: 'pending', madeBy: 'attendant' },
          }),
        }),
        thread('discarded', {
          messageCount: 3,
          state: idleState({
            outcome: { kind: 'merged', head: HEAD, at: 1 },
            draft: { id: 'd', name: 'n', state: 'discarded', madeBy: 'attendant' },
          }),
        }),
        thread('learned', {
          messageCount: 3,
          state: idleState({
            outcome: { kind: 'merged', head: HEAD, at: 1 },
            draft: { id: 'd', name: 'n', state: 'approved', madeBy: 'attendant' },
          }),
        }),
      ]);
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({
        providers: [
          { provide: ThreadsStore, useValue: { ...threads, threads: rows } },
          { provide: ThreadShell, useValue: shell },
          { provide: ToastStore, useValue: toasts },
          ...provideMockApi([
            [learnWorkspace, api.workspace, () => []],
            [learnForThread, api.draft, (o) => [o.path?.['id']]],
            [learnRequest, api.request, (o) => [o.path?.['id'], o.body?.['consent']]],
            [learnApprove, api.approve, (o) => [o.path?.['id'], o.body]],
            [learnDiscard, api.discard, (o) => [o.path?.['id']]],
            [learnReopen, api.reopen, (o) => [o.path?.['id']]],
            [learnPlan, api.verifyPlan, (o) => [o.path?.['id']]],
            [learnStart, api.verify, (o) => [o.path?.['id'], o.body]],
            [learnStop, api.stopVerify, (o) => [o.path?.['id']]],
          ]),
        ],
      });
      make();
      const menu = TestBed.inject(OutcomeMenuStore);
      const labels = (id: string) => {
        menu.openFor(id, 0, 0);
        return menu.items().map((i) => i.label);
      };
      expect(labels('plain')).toEqual(['Show the outcome', 'Learn a skill from this thread']);
      expect(labels('pending')).toEqual(['Show the outcome', 'Read the skill draft']);
      expect(labels('discarded')).toEqual(['Show the outcome', 'Reopen the skill draft']);
      expect(labels('learned')).toEqual(['Show the outcome']);
    });

    it('runs the chosen item', async () => {
      const rows = signal<ThreadSummary[]>([
        thread('plain', { messageCount: 3, state: idleState({ outcome: { kind: 'merged', head: HEAD, at: 1 } }) }),
      ]);
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({
        providers: [
          { provide: ThreadsStore, useValue: { ...threads, threads: rows } },
          { provide: ThreadShell, useValue: shell },
          { provide: ToastStore, useValue: toasts },
          ...provideMockApi([
            [learnWorkspace, api.workspace, () => []],
            [learnForThread, api.draft, (o) => [o.path?.['id']]],
            [learnRequest, api.request, (o) => [o.path?.['id'], o.body?.['consent']]],
            [learnApprove, api.approve, (o) => [o.path?.['id'], o.body]],
            [learnDiscard, api.discard, (o) => [o.path?.['id']]],
            [learnReopen, api.reopen, (o) => [o.path?.['id']]],
            [learnPlan, api.verifyPlan, (o) => [o.path?.['id']]],
            [learnStart, api.verify, (o) => [o.path?.['id'], o.body]],
            [learnStop, api.stopVerify, (o) => [o.path?.['id']]],
          ]),
        ],
      });
      make();
      const menu = TestBed.inject(OutcomeMenuStore);
      menu.openFor('plain', 0, 0);
      await menu.choose('learn:draft');
      await vi.waitFor(() => expect(api.request).toHaveBeenCalledWith('plain', undefined));
    });
  });
  describe('editing an approved skill', () => {
    const EDITED = TEXT.replace('1. Do it', '1. Do it twice');

    beforeEach(() => {
      learnedApi.get.mockImplementation(async () => ({ ...learned, text: TEXT, draft: approvedDraft() }));
      learnedApi.save.mockImplementation(async () => ({
        ...learned,
        verification: { state: 'done', result: 'pass', stale: true },
      }));
    });

    it('opens the dialog on the file as it is on disk, with nothing to save yet; the name and the place stay', async () => {
      const store = make();
      await store.edit(learned);
      expect(learnedApi.get).toHaveBeenCalledWith('d1');
      expect(store.dialog()).toEqual({ threadId: 't1', view: 'review' });
      expect(store.editing()).toBe(true);
      expect(store.editable()).toBe(true);
      expect(store.pending()).toBe(false);
      expect(store.text()).toBe(TEXT);
      expect(store.dirty()).toBe(false);
      expect(store.canSave()).toBe(false);
      expect(store.canApprove()).toBe(false);
      expect(api.draft).not.toHaveBeenCalled();
      expect(api.verifyPlan).toHaveBeenCalledWith('d1');
    });

    it('an edit can be saved once the text is a skill pi loads, and not before', async () => {
      const store = make();
      await store.edit(learned);
      store.setText(EDITED);
      expect(store.dirty()).toBe(true);
      expect(store.canSave()).toBe(true);
      store.setText('just words');
      expect(store.canSave()).toBe(false);
      store.setText(TEXT);
      expect(store.canSave()).toBe(false);
    });

    it('Save writes the text through the learned route, closes the dialog, updates the record and the open thread', async () => {
      const learnedStore = TestBed.inject(LearnedStore);
      const store = make();
      await store.edit(learned);
      store.setText(EDITED);
      await store.save();
      expect(learnedApi.save).toHaveBeenCalledWith('d1', EDITED);
      expect(store.dialog()).toBeUndefined();
      expect(store.editing()).toBe(false);
      expect(toasts.show).toHaveBeenCalledWith('success', expect.stringContaining('Saved “add-a-migration”'));
      expect(shell.skillsChanged).toHaveBeenCalledWith('t1');
      expect(threads.refresh).toHaveBeenCalled();
      void learnedStore;
    });

    it('keeps the dialog open with the reason when the server refuses the text', async () => {
      learnedApi.save.mockRejectedValueOnce(new Error('pi would not load this text: no description'));
      const store = make();
      await store.edit(learned);
      store.setText(EDITED);
      await store.save();
      expect(store.dialog()).toBeDefined();
      expect(store.error()).toContain('pi would not load');
      expect(store.text()).toBe(EDITED);
    });

    it('a replay needs the saved text: with an edit that is not saved it says so and starts nothing', async () => {
      const store = make();
      await store.edit(learned);
      store.setText(EDITED);
      await store.runVerify();
      expect(api.verify).not.toHaveBeenCalled();
      expect(store.error()).toContain('Save your edit first');
      store.setText(TEXT);
      await store.runVerify();
      expect(api.verify).toHaveBeenCalledWith('d1', {});
    });

    it('works for a skill whose thread is gone: everything comes from the learned skill', async () => {
      const gone = { ...learned, learnedFrom: { threadId: 't-gone', title: null, base: null, head: null } };
      const store = make();
      await store.edit(gone);
      expect(store.dialog()).toEqual({ threadId: 't-gone', view: 'review' });
      expect(store.editOf()).toEqual({ id: 'd1', title: null });
      expect(api.draft).not.toHaveBeenCalled();
    });

    it('shows why the skill could not be read', async () => {
      learnedApi.get.mockRejectedValueOnce(new Error('There is no such learned skill.'));
      const store = make();
      await store.edit(learned);
      expect(store.error()).toContain('no such learned skill');
      expect(store.open()).toBe(true);
      expect(store.editing()).toBe(true);
    });

    it('a review that follows an edit starts clean', async () => {
      const store = make();
      await store.edit(learned);
      await store.read('t1');
      expect(store.editing()).toBe(false);
      expect(store.pending()).toBe(true);
    });
  });
});
