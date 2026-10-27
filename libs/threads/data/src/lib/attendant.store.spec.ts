import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  attendantAccept,
  attendantDismiss,
  attendantPatch,
  attendantRun,
  attendantStatus,
  provideMockApi,
} from '@pi-kit/api';
import type { AttendantSettings, AttendantStatus } from '@pi-kit/protocol';
import { thread } from '@pi-kit/testing';
import { ThreadsStore } from './threads.store';

import { AttendantStore } from './attendant.store';

const settings: AttendantSettings = {
  enabled: false,
  followUpSuggestions: false,
  model: null,
  when: { onEnd: true, onInterrupt: true, everyMinutes: 0 },
  dailyCostCap: 0.5,
};
const statusOf = (over: Partial<AttendantStatus> = {}): AttendantStatus => ({
  settings,
  calls: 0,
  today: { cost: 0, calls: 0, inputTokens: 0, outputTokens: 0 },
  capReached: false,
  queued: 0,
  activeModel: 'llama-swap/gemma',
  actions: [],
  ...over,
});

describe('AttendantStore', () => {
  let remote: AttendantStatus;
  const api = {
    status: vi.fn(async () => remote),
    patch: vi.fn(async (patch: Partial<AttendantSettings>) => {
      remote = {
        ...remote,
        settings: { ...remote.settings, ...patch, when: { ...remote.settings.when, ...patch.when } },
      };
      return remote.settings;
    }),
    run: vi.fn(async () => ({ queued: 2 })),
    accept: vi.fn(async () => undefined),
    dismiss: vi.fn(async () => undefined),
  };
  const threads = {
    refresh: vi.fn(async () => undefined),
    cwd: signal<string | undefined>('/a'),
    workspaces: signal([{ cwd: '/a', name: 'a', attendant: true }]),
    setAttendant: vi.fn(async () => undefined),
  };
  const make = () => TestBed.inject(AttendantStore);

  beforeEach(() => {
    vi.useFakeTimers();
    remote = statusOf();
    for (const fn of [...Object.values(api), threads.refresh, threads.setAttendant]) fn.mockClear();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: ThreadsStore, useValue: threads },
        ...provideMockApi([
          [attendantStatus, api.status, (o) => [o.signal]],
          [attendantPatch, api.patch, (o) => [o.body]],
          [attendantRun, api.run, (o) => [o.body?.['threadId']]],
          [attendantAccept, api.accept, (o) => [o.path?.['id']]],
          [attendantDismiss, api.dismiss, (o) => [o.path?.['id']]],
        ]),
      ],
    });
  });
  afterEach(() => vi.useRealTimers());

  it('loads the status; off by default', async () => {
    const store = make();
    expect(store.enabled()).toBe(false);
    await store.load();
    expect(store.settings()).toEqual(settings);
    expect(store.enabled()).toBe(false);
    expect(store.actions()).toEqual([]);
  });

  it('a patch shows at once, goes to the backend, and the backend’s answer replaces it', async () => {
    const store = make();
    await store.load();
    const done = store.patch({ enabled: true, when: { everyMinutes: 15 } });
    expect(store.enabled()).toBe(true);
    expect(store.settings()?.when).toEqual({ onEnd: true, onInterrupt: true, everyMinutes: 15 });
    await done;
    expect(api.patch).toHaveBeenCalledWith({ enabled: true, when: { everyMinutes: 15 } });
    expect(remote.settings.enabled).toBe(true);
  });

  it('a patch the backend refuses is taken back', async () => {
    const store = make();
    await store.load();
    api.patch.mockRejectedValueOnce(new Error('nope'));
    await expect(store.patch({ enabled: true })).rejects.toThrow('nope');
    expect(store.enabled()).toBe(false);
  });

  it('reads the activity every few seconds while its page is open, and only then', async () => {
    const store = make();
    TestBed.tick();
    expect(api.status).not.toHaveBeenCalled();
    store.watch(true);
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(0);
    expect(api.status).toHaveBeenCalledTimes(1);
    remote = statusOf({
      actions: [
        {
          id: 1,
          at: 1,
          kind: 'title',
          status: 'done',
          threadId: 't',
          threadTitle: 'T',
          text: 'A title',
          model: 'm',
          inputTokens: 1,
          outputTokens: 2,
          cost: 0,
        },
      ],
    });
    await vi.advanceTimersByTimeAsync(4000);
    expect(store.actions()).toHaveLength(1);
    store.watch(false);
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(api.status).toHaveBeenCalledTimes(2);
  });

  it('accepting and dismissing a suggestion goes to the backend and refreshes the sidebar', async () => {
    const store = make();
    const suggestion = { id: 7, kind: 'label' as const, target: 'e1', text: 'Retry or give up' };
    await store.accept(suggestion);
    expect(api.accept).toHaveBeenCalledWith(7);
    await store.dismiss(suggestion);
    expect(api.dismiss).toHaveBeenCalledWith(7);
    expect(threads.refresh).toHaveBeenCalledTimes(2);
    void thread;
  });

  it('look now returns how many threads were queued', async () => {
    const store = make();
    expect(await store.run()).toBe(2);
    expect(api.run).toHaveBeenCalledWith(undefined);
  });

  it('the per-project opt-out toggles the current project', async () => {
    const store = make();
    expect(await store.toggleForProject()).toBe(false);
    expect(threads.setAttendant).toHaveBeenCalledWith('/a', false);
    threads.cwd.set(undefined);
    expect(await store.toggleForProject()).toBeUndefined();
  });
  it('keeps pending edits visible during polling and rolls back only the failed edit', async () => {
    const store = make();
    await store.load();
    let fail!: (error: Error) => void;
    api.patch.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          fail = reject;
        }),
    );
    const first = store.patch({ enabled: true }).catch(() => undefined);
    const second = store.patch({ dailyCostCap: 2 });
    await store.load();
    expect(store.enabled()).toBe(true);
    expect(store.settings()?.dailyCostCap).toBe(2);
    fail(new Error('first failed'));
    await Promise.all([first, second]);
    expect(store.enabled()).toBe(false);
    expect(store.settings()?.dailyCostCap).toBe(2);
  });
});
