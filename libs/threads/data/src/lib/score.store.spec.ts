import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideMockApi, scoreGet, scoreOverview, scoreRelabel, scoreRequest } from '@pi-kit/api';
import { ToastStore } from '@pi-kit/data-access';
import type { OutcomeScoreView, ScoreOverview, ThreadSummary } from '@pi-kit/protocol';
import { idleState, thread } from '@pi-kit/testing';
import { OutcomeMenuStore } from './outcome-menu.store';
import { ThreadShell } from './ports';
import { SCORE_LINE, SCORE_RUN, ScoreStore } from './score.store';

import { ThreadsStore } from './threads.store';

const HEAD = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const LINE = '62 % steered: 14 of 23 hunks, 9 by the first prompt, 3 by review comments, 2 by hand';
const scored = { meat: 62, vibe: 38, line: LINE, stale: false };
const unscored = { meat: null, vibe: null, line: null, stale: false };

const view = (over: Partial<OutcomeScoreView> = {}): OutcomeScoreView => ({
  scores: {
    meat: 62,
    vibe: 38,
    hunks: 23,
    steered: 14,
    lines: 100,
    steeredLines: 62,
    byLabel: {
      specified: { hunks: 1, lines: 1 },
      corrected: { hunks: 1, lines: 1 },
      autonomous: { hunks: 1, lines: 1 },
      manual: { hunks: 1, lines: 1 },
    },
    byInput: {},
    line: LINE,
  },
  hunks: [],
  model: 'p/m',
  at: 1,
  stale: false,
  base: 'a'.repeat(40),
  head: HEAD,
  corrected: 0,
  ...over,
});

describe('ScoreStore', () => {
  const api = {
    get: vi.fn(async (): Promise<OutcomeScoreView> => view()),
    request: vi.fn(
      async (): Promise<{
        status: 'scored' | 'consent';
        score?: OutcomeScoreView;
        model?: string;
        message?: string;
      }> => ({ status: 'scored', score: view() }),
    ),
    relabel: vi.fn(async () => view()),
    overview: vi.fn(async (): Promise<ScoreOverview> => ({ installed: true, projects: [] })),
  };
  const toasts = { show: vi.fn() };
  const threads = {
    refresh: vi.fn(async () => undefined),
    threads: signal<ThreadSummary[]>([]),
    selected: signal<ThreadSummary | undefined>(undefined),
  };
  const shell = { openOutcome: vi.fn() };
  const outcome = (score: typeof scored | typeof unscored | undefined) =>
    idleState({ outcome: { kind: 'committed', head: HEAD, at: 1, ...(score ? { score } : {}) } });

  const make = () => TestBed.inject(ScoreStore);

  beforeEach(() => {
    vi.clearAllMocks();
    api.get.mockImplementation(async () => view());
    api.request.mockImplementation(async () => ({ status: 'scored', score: view() }));
    threads.selected.set(undefined);
    threads.threads.set([
      thread('scored', { state: outcome(scored) }),
      thread('fresh', { state: outcome(unscored) }),
      thread('plain'),
      thread('plugin-less', { state: outcome(undefined) }),
    ]);
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: ThreadsStore, useValue: threads },
        { provide: ToastStore, useValue: toasts },
        { provide: ThreadShell, useValue: shell },
        ...provideMockApi([
          [scoreGet, api.get, (o) => [o.path?.['id']]],
          [scoreRequest, api.request, (o) => [o.path?.['id'], o.body?.['consent']]],
          [scoreRelabel, api.relabel, (o) => [o.path?.['id'], o.body?.['hunk'], o.body?.['label']]],
          [scoreOverview, api.overview, () => []],
        ]),
      ],
    });
  });

  describe('the outcome badge’s menu', () => {
    it('shows the score and offers to score again for a thread that was scored', () => {
      make();
      const menu = TestBed.inject(OutcomeMenuStore);
      menu.openFor('scored', 1, 1);
      expect(menu.items().map((i) => [i.id, i.label, i.disabled ?? false])).toEqual([
        ['outcome:show', 'Show the outcome', false],
        [SCORE_LINE, LINE, true],
        [SCORE_RUN, 'Score this thread again', false],
      ]);
    });

    it('offers "Score this thread" for a thread nobody scored yet', () => {
      make();
      const menu = TestBed.inject(OutcomeMenuStore);
      menu.openFor('fresh', 1, 1);
      expect(menu.items().map((i) => i.label)).toEqual(['Show the outcome', 'Score this thread']);
    });

    it('adds nothing without the package: the state has no score, so the menu is the outcome’s alone', () => {
      make();
      const menu = TestBed.inject(OutcomeMenuStore);
      menu.openFor('plugin-less', 1, 1);
      expect(menu.items().map((i) => i.label)).toEqual(['Show the outcome']);
    });

    it('choosing it scores the thread', async () => {
      const store = make();
      const menu = TestBed.inject(OutcomeMenuStore);
      menu.openFor('fresh', 1, 1);
      await menu.choose(SCORE_RUN);
      expect(api.request).toHaveBeenCalledWith('fresh', undefined);
      expect(store.views()['fresh']?.scores.meat).toBe(62);
    });
  });

  describe('scoring', () => {
    it('says the sentence and reads the threads again', async () => {
      const store = make();
      await store.score(thread('fresh'));
      expect(toasts.show).toHaveBeenCalledWith('success', LINE);
      expect(threads.refresh).toHaveBeenCalled();
      expect(store.scoring()).toBeUndefined();
    });

    it('with the attendant off the answer is consent: a toast carries the sentence and the button that agrees, and nothing is sent before', async () => {
      api.request.mockImplementationOnce(async () => ({
        status: 'consent',
        model: 'p/m',
        message: 'This sends the thread’s transcript to p/m.',
      }));
      const store = make();
      await store.score(thread('fresh'));
      expect(api.request).toHaveBeenCalledTimes(1);
      const call = toasts.show.mock.calls[0];
      expect(call[0]).toBe('info');
      expect(call[1]).toBe('This sends the thread’s transcript to p/m.');
      expect(call[3].label).toBe('Send and score');
      call[3].run();
      await vi.waitFor(() => expect(api.request).toHaveBeenCalledTimes(2));
      expect(api.request).toHaveBeenLastCalledWith('fresh', true);
    });

    it('says why when it could not score, and one thread at a time', async () => {
      api.request.mockRejectedValueOnce(new Error('No model is available.'));
      const store = make();
      await store.score(thread('fresh'));
      expect(toasts.show).toHaveBeenCalledWith('error', 'Could not score the thread: No model is available.');
      expect(store.scoring()).toBeUndefined();
    });
  });

  describe('the labels of the selected thread', () => {
    it('are read when the thread’s state carries a sentence, and again when it changes', async () => {
      const store = make();
      threads.selected.set(thread('scored', { state: outcome(scored) }));
      TestBed.tick();
      await vi.waitFor(() => expect(store.current()?.scores.meat).toBe(62));
      expect(api.get).toHaveBeenCalledTimes(1);
      threads.selected.set(thread('scored', { state: outcome({ ...scored, line: '70 % steered: 7 of 10 hunks' }) }));
      TestBed.tick();
      await vi.waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
    });

    it('are forgotten when the score goes away (the package was removed)', async () => {
      const store = make();
      threads.selected.set(thread('scored', { state: outcome(scored) }));
      TestBed.tick();
      await vi.waitFor(() => expect(store.current()).toBeDefined());
      threads.selected.set(thread('scored', { state: outcome(undefined) }));
      TestBed.tick();
      await vi.waitFor(() => expect(store.current()).toBeUndefined());
    });

    it('a thread that has none is remembered as such', async () => {
      api.get.mockRejectedValueOnce(new Error('not scored'));
      const store = make();
      await store.load('fresh');
      expect(store.views()['fresh']).toBeNull();
    });
  });

  describe('relabelling', () => {
    it('sends the hunk and the label, keeps the new score and reads the threads again', async () => {
      api.relabel.mockResolvedValueOnce(view({ corrected: 1 }));
      const store = make();
      await store.relabel('scored', 'notes/a.md@0:1', 'manual');
      expect(api.relabel).toHaveBeenCalledWith('scored', 'notes/a.md@0:1', 'manual');
      expect(store.views()['scored']?.corrected).toBe(1);
      expect(threads.refresh).toHaveBeenCalled();
    });

    it('says why when it failed', async () => {
      api.relabel.mockRejectedValueOnce(new Error('The thread’s outcome has no such hunk.'));
      const store = make();
      await store.relabel('scored', 'x@1:1', 'manual');
      expect(toasts.show).toHaveBeenCalledWith(
        'error',
        'Could not relabel the hunk: The thread’s outcome has no such hunk.',
      );
    });
  });

  it('reads the distribution for Settings, and has none when it cannot', async () => {
    const store = make();
    await store.loadOverview();
    expect(store.overview()).toEqual({ installed: true, projects: [] });
    api.overview.mockRejectedValueOnce(new Error('offline'));
    await store.loadOverview();
    expect(store.overview()).toBeUndefined();
  });
});
