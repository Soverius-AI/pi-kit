import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { appSettingsSetSetting, appSettingsSettings, provideMockApi } from '@pi-kit/api';
import { ChatStore, CommandRegistry } from '@pi-kit/chat/api';
import { DialogStore, HealthStore, ToastStore, UiStore, ViewPrefs } from '@pi-kit/data-access';
import { ChangesStore } from '@pi-kit/review/api';
import { GraphStore } from '@pi-kit/session-tree/api';
import { fakeThreads, thread } from '@pi-kit/testing';
import { AttendantStore, ThreadsStore } from '@pi-kit/threads/api';
import { ShellStore } from './shell.store';

describe('ShellStore', () => {
  const chat = {
    running: signal(false),
    waitingForAnswer: signal(false),
    compacting: signal(false),
    stats: signal<{ sessionId: string } | undefined>(undefined),
    statuses: signal<Record<string, string>>({}),
    totalCost: signal(0),
    totalTokens: signal(0),
    totalTurns: signal(0),
    cycleModel: vi.fn(async () => undefined),
    cycleEffort: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    interrupt: { interrupts: signal<{ id: string }[]>([]), resolve: vi.fn(async () => undefined) },
  };
  const threadsApi = { answerDialog: vi.fn(async () => undefined) };
  const attendant = { accept: vi.fn(async () => undefined), dismiss: vi.fn(async () => undefined) };
  const toasts = { show: vi.fn() };
  const registry = { newThread: vi.fn(async () => undefined) };
  const graph = { branch: signal<unknown>(undefined), cancelBranch: vi.fn() };
  const review = { threadId: signal<string | undefined>('t1'), setSource: vi.fn(), open: vi.fn() };
  const health = { state: signal<'checking' | 'ok' | 'error'>('ok'), epoch: signal(0) };
  let threads: ReturnType<typeof fakeThreads> & { init: ReturnType<typeof vi.fn> };

  const press = (key: string, init: KeyboardEventInit = {}): KeyboardEvent => {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
    document.body.dispatchEvent(event);
    return event;
  };
  const make = () => {
    const shell = TestBed.inject(ShellStore);
    shell.start();
    return shell;
  };

  beforeEach(() => {
    localStorage.clear();
    chat.running.set(false);
    chat.waitingForAnswer.set(false);
    chat.compacting.set(false);
    chat.stats.set(undefined);
    graph.branch.set(undefined);
    health.state.set('ok');
    review.threadId.set('t1');
    chat.interrupt.interrupts.set([]);
    for (const fn of [threadsApi.answerDialog, attendant.accept, toasts.show, chat.interrupt.resolve]) fn.mockReset();
    threadsApi.answerDialog.mockResolvedValue(undefined);
    attendant.accept.mockResolvedValue(undefined);
    chat.interrupt.resolve.mockResolvedValue(undefined);
    for (const fn of [
      review.setSource,
      review.open,
      chat.cycleModel,
      chat.cycleEffort,
      chat.stop,
      registry.newThread,
      graph.cancelBranch,
    ])
      fn.mockClear();
    threads = Object.assign(fakeThreads({ selected: thread('t1') }), { init: vi.fn(async () => undefined) });
    vi.stubGlobal('innerWidth', 1600);
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: ChatStore, useValue: chat },
        { provide: CommandRegistry, useValue: registry },
        { provide: GraphStore, useValue: graph },
        { provide: ChangesStore, useValue: review },
        { provide: HealthStore, useValue: health },
        { provide: ThreadsStore, useValue: threads },
        { provide: AttendantStore, useValue: attendant },
        { provide: ToastStore, useValue: toasts },
        ...provideMockApi(
          [
            [appSettingsSettings, { all: async () => ({}), set: async () => undefined }.all, () => []],
            [
              appSettingsSetSetting,
              { all: async () => ({}), set: async () => undefined }.set,
              (o) => [o.path?.['key'], o.body?.['value']],
            ],
          ],
          [],
          [
            [
              /^\/api\/copilotkit\/agent\/pi\/run$/,
              threadsApi.answerDialog,
              (_path, body) => {
                const resume = (body['resume'] as { interruptId: string; payload: unknown }[])[0];
                return [body['threadId'], resume.interruptId, resume.payload];
              },
            ],
          ],
        ),
      ],
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('⌘[ and ⌘] step through the threads of the project, ⌘1 to ⌘9 jump to a project (and not ⌘0)', () => {
    make();
    expect(press('[', { ctrlKey: true, code: 'BracketLeft' }).defaultPrevented).toBe(true);
    expect(threads.stepThread).toHaveBeenLastCalledWith(-1);
    press(']', { ctrlKey: true, code: 'BracketRight' });
    expect(threads.stepThread).toHaveBeenLastCalledWith(1);
    expect(press('1', { metaKey: true, code: 'Digit1' }).defaultPrevented).toBe(true);
    expect(threads.jumpToProject).toHaveBeenLastCalledWith(0);
    press('9', { ctrlKey: true, code: 'Digit9' });
    expect(threads.jumpToProject).toHaveBeenLastCalledWith(8);
    threads.jumpToProject.mockClear();
    expect(press('0', { ctrlKey: true, code: 'Digit0' }).defaultPrevented).toBe(false);
    expect(press('1', { code: 'Digit1' }).defaultPrevented).toBe(false);
    expect(threads.jumpToProject).not.toHaveBeenCalled();
  });

  it('start loads the threads and binds the keyboard once', () => {
    const shell = make();
    shell.start();
    expect(threads.init).toHaveBeenCalledTimes(1);
    press('k', { ctrlKey: true });
    expect(TestBed.inject(UiStore).palette()).toBe(true);
  });

  it('the shortcuts follow ViewPrefs: new thread, palette, model and effort cycling, the Files filter', async () => {
    make();
    const ui = TestBed.inject(UiStore);
    expect(press('n', { ctrlKey: true }).defaultPrevented).toBe(true);
    expect(registry.newThread).toHaveBeenCalled();
    press('M', { ctrlKey: true, shiftKey: true });
    expect(chat.cycleModel).toHaveBeenCalled();
    press('E', { ctrlKey: true, shiftKey: true });
    expect(chat.cycleEffort).toHaveBeenCalled();
    press('F', { ctrlKey: true, shiftKey: true });
    expect(ui.panel()).toBe('files');
    expect(ui.filesFilter()).toBe(1);
  });

  it('the Files filter shortcut does nothing on a phone', () => {
    make();
    vi.stubGlobal('innerWidth', 600);
    press('F', { ctrlKey: true, shiftKey: true });
    expect(TestBed.inject(UiStore).panel()).toBeNull();
  });

  it('⌘B collapses the sidebar on a wide window and opens or closes the drawer on a narrow one', () => {
    make();
    const prefs = TestBed.inject(ViewPrefs);
    expect(press('b', { ctrlKey: true }).defaultPrevented).toBe(true);
    expect(prefs.sidebarCollapsed()).toBe(true);
    press('b', { ctrlKey: true });
    expect(prefs.sidebarCollapsed()).toBe(false);

    const drawer = document.createElement('input');
    drawer.type = 'checkbox';
    drawer.id = 't-threads';
    document.body.append(drawer);
    vi.stubGlobal('innerWidth', 900);
    press('b', { ctrlKey: true });
    expect(drawer.checked).toBe(true);
    expect(prefs.sidebarCollapsed()).toBe(false);
    press('b', { ctrlKey: true });
    expect(drawer.checked).toBe(false);
    drawer.remove();
  });

  it('keys typed in the terminal are not shortcuts', () => {
    make();
    const term = document.createElement('div');
    term.className = 'xterm';
    const inner = document.createElement('textarea');
    term.append(inner);
    document.body.append(term);
    inner.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
    term.remove();
    expect(TestBed.inject(UiStore).palette()).toBe(false);
  });

  it('Esc closes the topmost thing first: dialog, settings, palette, branch, an overlay panel, and only then stops the run', () => {
    make();
    const ui = TestBed.inject(UiStore);
    const dialogs = TestBed.inject(DialogStore);
    dialogs.show({ kind: 'hotkeys' });
    ui.openSettings();
    ui.togglePalette();
    graph.branch.set({ entryId: 'e' });
    ui.setPanel('tree');
    vi.stubGlobal('innerWidth', 1200);
    chat.running.set(true);

    press('Escape');
    expect(dialogs.current()).toBeUndefined();
    press('Escape');
    expect(ui.settings()).toBeNull();
    press('Escape');
    expect(ui.palette()).toBe(false);
    press('Escape');
    expect(graph.cancelBranch).toHaveBeenCalledTimes(1);
    graph.branch.set(undefined);
    // A run is going: the panel stays, Esc stops the run.
    expect(press('Escape').defaultPrevented).toBe(true);
    expect(chat.stop).toHaveBeenCalledTimes(1);
    expect(ui.panel()).toBe('tree');
    chat.running.set(false);
    press('Escape');
    expect(ui.panel()).toBeNull();
    expect(chat.stop).toHaveBeenCalledTimes(1);
  });

  it('Esc does not stop a run when nothing is running', () => {
    make();
    press('Escape');
    expect(chat.stop).not.toHaveBeenCalled();
  });

  it('the header and status texts', () => {
    const shell = make();
    expect(shell.backendLabel()).toBe('Backend connected');
    health.state.set('error');
    expect(shell.backendLabel()).toBe('Backend unreachable');
    expect(shell.title()).toBe('t1');
    expect(shell.runState()).toBe('Idle');
    chat.running.set(true);
    expect(shell.runState()).toBe('Running');
    chat.waitingForAnswer.set(true);
    expect(shell.runState()).toBe('Waiting for your answer');
    chat.stats.set({ sessionId: 'abcdefgh12345678' });
    expect(shell.sessionLabel()).toBe('Session abcd…5678');
    expect(shell.treeDisabled()).toBe(false);
  });

  it('opening a thread selects it and refreshes the list', () => {
    const shell = make();
    shell.openThread('t9');
    expect(threads.select).toHaveBeenCalledWith('t9');
    expect(threads.refresh).toHaveBeenCalled();
  });

  it('opening an outcome selects the thread, waits for review mode to follow it, then shows the Outcome source', async () => {
    vi.useFakeTimers();
    try {
      const shell = make();
      const done = shell.openOutcome('t2');
      expect(threads.select).toHaveBeenCalledWith('t2');
      // The threads store and review mode follow the selection a moment later.
      threads.open(thread('t2'));
      review.threadId.set('t2');
      await vi.advanceTimersByTimeAsync(500);
      await done;
      expect(review.setSource).toHaveBeenCalledWith('outcome');
      expect(review.open).toHaveBeenCalledTimes(1);
      expect(review.setSource.mock.invocationCallOrder[0]).toBeLessThan(review.open.mock.invocationCallOrder[0]);
    } finally {
      vi.useRealTimers();
    }
  });

  describe('answering a waiting thread from the sidebar', () => {
    const suggestion = { id: 7, kind: 'answer' as const, target: 'd1', text: 'Allow' };

    it('a thread that is not open is answered through the AG-UI resume, without opening it; the suggestion is accepted after', async () => {
      const shell = make();
      await shell.answerWaiting(thread('t9'), 'd1', { confirmed: true }, suggestion);
      expect(threadsApi.answerDialog).toHaveBeenCalledWith('t9', 'd1', { confirmed: true });
      expect(chat.interrupt.resolve).not.toHaveBeenCalled();
      expect(threads.select).not.toHaveBeenCalled();
      expect(attendant.accept).toHaveBeenCalledWith(suggestion);
    });

    it('the open thread resolves its own approval block, so the block goes away as when its button is pressed', async () => {
      chat.interrupt.interrupts.set([{ id: 'd1' }]);
      const shell = make();
      await shell.answerWaiting(thread('t1'), 'd1', { value: 'canary' });
      expect(chat.interrupt.resolve).toHaveBeenCalledWith({ value: 'canary' }, 'd1');
      expect(threadsApi.answerDialog).not.toHaveBeenCalled();
      expect(attendant.accept).not.toHaveBeenCalled();
    });

    it('a failed answer is a toast, not an unhandled error, and the suggestion is not accepted', async () => {
      threadsApi.answerDialog.mockRejectedValueOnce(new Error('The question can no longer be answered.'));
      const shell = make();
      await shell.answerWaiting(thread('t9'), 'd1', { confirmed: false }, suggestion);
      expect(toasts.show).toHaveBeenCalledWith('error', 'Could not answer: The question can no longer be answered.');
      expect(attendant.accept).not.toHaveBeenCalled();
    });
  });

  it('the thread search shortcut focuses the sidebar search (⌘K stays the palette)', () => {
    make();
    const ui = TestBed.inject(UiStore);
    expect(ui.threadSearch()).toBe(0);
    expect(press('K', { ctrlKey: true, shiftKey: true }).defaultPrevented).toBe(true);
    expect(ui.threadSearch()).toBe(1);
    expect(ui.palette()).toBe(false);
    press('k', { ctrlKey: true });
    expect(ui.palette()).toBe(true);
  });

  it('shows the outcome of the thread that is already open without selecting it again', async () => {
    vi.useFakeTimers();
    try {
      const shell = make();
      const done = shell.openOutcome('t1');
      await vi.advanceTimersByTimeAsync(300);
      await done;
      expect(threads.select).not.toHaveBeenCalled();
      expect(review.setSource).toHaveBeenCalledWith('outcome');
    } finally {
      vi.useRealTimers();
    }
  });
});
