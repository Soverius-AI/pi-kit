import { Injector } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  provideMockApi,
  settingsModels,
  settingsOverview,
  settingsPatch,
  settingsProviders,
  settingsValues,
} from '@pi-kit/api';
import type { PiSettings } from '@pi-kit/protocol';
import { fakeThreads, thread } from '@pi-kit/testing';
import { ThreadsStore } from '@pi-kit/threads/api';
import { PiSettingsStore } from './pi-settings.store';
import { SettingsStore } from './settings.store';

const values = (over: Partial<PiSettings> = {}): PiSettings =>
  ({ autoCompaction: true, retryEnabled: true, steeringMode: 'all', followUpMode: 'all', ...over }) as PiSettings;

describe('PiSettingsStore', () => {
  const api = {
    values: vi.fn(async (cwd?: string) => (void cwd, values())),
    patch: vi.fn(async (patch: Partial<PiSettings>, cwd?: string) => (void cwd, values(patch))),
    overview: vi.fn(),
    providers: vi.fn(),
    models: vi.fn(),
  };
  const save = vi.fn(<T>(work: () => Promise<T>) => work().catch(() => undefined));
  const markReload = vi.fn();
  let threads: ReturnType<typeof fakeThreads>;

  beforeEach(() => {
    vi.useFakeTimers();
    for (const fn of [...Object.values(api), save, markReload]) fn.mockClear();
    threads = fakeThreads({ selected: thread('t1', { cwd: '/a' }) });
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        PiSettingsStore,
        { provide: ThreadsStore, useValue: threads },
        { provide: SettingsStore, useValue: { save, markReload } },
        ...provideMockApi([
          [settingsValues, api.values, (o) => [o.query?.['cwd']]],
          [settingsPatch, api.patch, (o) => [o.body, o.query?.['cwd']]],
          [settingsOverview, api.overview, () => []],
          [settingsProviders, api.providers, () => []],
          [settingsModels, api.models, () => []],
        ]),
      ],
    });
  });
  afterEach(() => vi.useRealTimers());

  it('regression: reads only pi’s settings for the folder, never the providers and models', async () => {
    const store = TestBed.inject(PiSettingsStore);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.settings()?.autoCompaction).toBe(true);
    expect(api.values).toHaveBeenCalledExactlyOnceWith('/a');
    expect(api.overview).not.toHaveBeenCalled();
    expect(api.providers).not.toHaveBeenCalled();
    expect(api.models).not.toHaveBeenCalled();
  });

  it('saves in order through the dialog and keeps the newer optimistic edit', async () => {
    const store = TestBed.inject(PiSettingsStore);
    await vi.advanceTimersByTimeAsync(0);
    let finish!: (value: PiSettings) => void;
    api.patch.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    const first = store.patch({ steeringMode: 'one-at-a-time' });
    const second = store.patch({ steeringMode: 'all' });
    await vi.advanceTimersByTimeAsync(0);
    expect(api.patch).toHaveBeenCalledTimes(1);
    expect(store.settings()?.steeringMode).toBe('all');
    finish(values({ steeringMode: 'one-at-a-time' }));
    await first;
    expect(store.settings()?.steeringMode).toBe('all');
    await second;
    expect(api.patch).toHaveBeenLastCalledWith({ steeringMode: 'all' }, '/a');
    expect(save).toHaveBeenCalledTimes(2);
    expect(store.settings()?.steeringMode).toBe('all');
  });

  it('a read that began before a save cannot replace what the save confirmed', async () => {
    const store = TestBed.inject(PiSettingsStore);
    await vi.advanceTimersByTimeAsync(0);
    let finishRead!: (value: PiSettings) => void;
    api.values.mockImplementationOnce(() => new Promise((resolve) => (finishRead = resolve)));
    const reading = store.loadSettings();
    await store.patch({ retryEnabled: false });
    finishRead(values());
    await reading;
    expect(store.settings()?.retryEnabled).toBe(false);
  });

  it('a failed save reads pi’s settings again', async () => {
    const store = TestBed.inject(PiSettingsStore);
    await vi.advanceTimersByTimeAsync(0);
    api.patch.mockRejectedValueOnce(new Error('read-only'));
    await store.patch({ autoCompaction: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(api.values).toHaveBeenCalledTimes(2);
    expect(store.settings()?.autoCompaction).toBe(true);
  });

  it('a change shows at once and, once saved, notes the reload it needs', async () => {
    const store = TestBed.inject(PiSettingsStore);
    await vi.advanceTimersByTimeAsync(0);
    const pending = store.patch({ enabledModels: ['a/*'] }, 'the model scope');
    expect(store.settings()?.enabledModels).toEqual(['a/*']);
    await pending;
    expect(markReload).toHaveBeenCalledExactlyOnceWith('the model scope');
  });

  it('saves to the folder the section opened for, even after another thread opens', async () => {
    const store = TestBed.inject(PiSettingsStore);
    await vi.advanceTimersByTimeAsync(0);
    threads.open(thread('t2', { cwd: '/b' }));
    await store.patch({ enabledModels: ['b/*'] });
    expect(api.patch).toHaveBeenLastCalledWith({ enabledModels: ['b/*'] }, '/a');
  });

  it('regression: a section opened again shows the last pi settings at once and still reads them again', async () => {
    TestBed.inject(PiSettingsStore);
    await vi.advanceTimersByTimeAsync(0);
    let finish!: (value: PiSettings) => void;
    api.values.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    const reopened = Injector.create({ providers: [PiSettingsStore], parent: TestBed.inject(Injector) }).get(
      PiSettingsStore,
    );
    expect(reopened.settings()?.autoCompaction).toBe(true);
    expect(api.values).toHaveBeenCalledTimes(2);
    finish(values({ autoCompaction: false }));
    await vi.advanceTimersByTimeAsync(0);
    expect(reopened.settings()?.autoCompaction).toBe(false);
  });

  it('regression: a section opened again while a save is pending shows that edit and saves after it', async () => {
    const closing = Injector.create({ providers: [PiSettingsStore], parent: TestBed.inject(Injector) });
    const first = closing.get(PiSettingsStore);
    await vi.advanceTimersByTimeAsync(0);
    let finish!: (value: PiSettings) => void;
    api.patch.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    const saving = first.patch({ retryEnabled: false });
    closing.destroy();
    const reopened = Injector.create({ providers: [PiSettingsStore], parent: TestBed.inject(Injector) }).get(
      PiSettingsStore,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(reopened.settings()?.retryEnabled).toBe(false);
    const next = reopened.patch({ retryEnabled: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(api.patch).toHaveBeenCalledTimes(1);
    finish(values({ retryEnabled: false }));
    await saving;
    await next;
    expect(api.patch).toHaveBeenLastCalledWith({ retryEnabled: true }, '/a');
    expect(reopened.settings()?.retryEnabled).toBe(true);
  });

  it('loading again after the thread moved to another folder reads and saves that folder', async () => {
    const store = TestBed.inject(PiSettingsStore);
    await vi.advanceTimersByTimeAsync(0);
    threads.open(thread('t2', { cwd: '/b' }));
    await store.loadSettings();
    expect(api.values).toHaveBeenLastCalledWith('/b');
    await store.patch({ retryEnabled: false });
    expect(api.patch).toHaveBeenLastCalledWith({ retryEnabled: false }, '/b');
  });
});
