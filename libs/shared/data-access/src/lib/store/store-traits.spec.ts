import { TestBed } from '@angular/core/testing';
import { signalStore, withHooks, withMethods, withState } from '@ngrx/signals';
import { appSettingsSetSetting, appSettingsSettings, BackendStatus, provideMockApi } from '@pi-kit/api';
import { Subject } from 'rxjs';

import { BACKEND_STATUS, withBackendEvents, withPersistence, withRequestStatus, withSelection } from './index';

describe('withRequestStatus', () => {
  const Store = signalStore(withRequestStatus());

  it('walks idle, loading, error and back', () => {
    const store = TestBed.configureTestingModule({}).runInInjectionContext(() => new Store());
    expect(store.requestStatus()).toBe('idle');
    store.requestStarted();
    expect(store.loading()).toBe(true);
    store.requestFailed(new Error('boom'));
    expect(store.failed()).toBe(true);
    expect(store.error()).toBe('boom');
    store.requestDone();
    expect(store.requestStatus()).toBe('idle');
    expect(store.error()).toBeUndefined();
  });
});

describe('withSelection', () => {
  const Store = signalStore(withSelection());
  const make = () => TestBed.configureTestingModule({}).runInInjectionContext(() => new Store());

  it('selects, tests and clears', () => {
    const store = make();
    store.setSelected('a');
    expect(store.hasSelection()).toBe(true);
    expect(store.isSelected('a')).toBe(true);
    store.clearSelection();
    expect(store.selectedId()).toBeUndefined();
  });

  it('moves within a list and stops at the ends', () => {
    const store = make();
    const ids = ['a', 'b', 'c'];
    expect(store.moveSelection(ids, 1)).toBe('a');
    expect(store.moveSelection(ids, 1)).toBe('b');
    expect(store.moveSelection(ids, 5)).toBe('c');
    expect(store.moveSelection(ids, -1)).toBe('b');
    expect(store.moveSelection(ids, -9)).toBe('a');
  });
});

describe('withPersistence', () => {
  interface Prefs {
    size: number;
    dense: boolean;
  }
  const saved: Record<string, unknown> = {};
  const api = {
    all: vi.fn(async () => ({ ...saved })),
    set: vi.fn(async (key: string, value: unknown) => {
      saved[key] = value;
    }),
  };
  const Store = signalStore(
    withState<Prefs>({ size: 14, dense: false }),
    withPersistence<Prefs>({
      readLocal: () => JSON.parse(localStorage.getItem('spec.prefs') ?? '{}') as Partial<Prefs>,
      writeLocal: (state) =>
        localStorage.setItem('spec.prefs', JSON.stringify({ size: state.size, dense: state.dense })),
      remote: {
        keys: { size: 'size', dense: 'density' },
        parse: (s) => ({
          ...(typeof s['size'] === 'number' ? { size: s['size'] } : {}),
          ...(typeof s['density'] === 'boolean' ? { dense: s['density'] } : {}),
        }),
      },
    }),
  );
  const make = () =>
    TestBed.configureTestingModule({
      providers: [
        ...provideMockApi([
          [appSettingsSettings, api.all, () => []],
          [appSettingsSetSetting, api.set, (o) => [o.path?.['key'], o.body?.['value']]],
        ]),
      ],
    }).runInInjectionContext(() => new Store());

  beforeEach(() => {
    localStorage.clear();
    for (const key of Object.keys(saved)) delete saved[key];
    api.all.mockClear();
    api.set.mockClear();
    TestBed.resetTestingModule();
  });

  it('starts from the local copy', () => {
    localStorage.setItem('spec.prefs', JSON.stringify({ size: 17 }));
    expect(make().size()).toBe(17);
  });

  it('persist changes state, copy and backend', async () => {
    const store = make();
    expect(await store.persist({ dense: true })).toBe(true);
    expect(store.dense()).toBe(true);
    expect(JSON.parse(localStorage.getItem('spec.prefs') ?? '{}')).toMatchObject({ dense: true });
    expect(api.set).toHaveBeenCalledWith('density', true);
  });

  it('persist reports a backend that did not take the value, and keeps the change on the page', async () => {
    const store = make();
    api.set.mockRejectedValueOnce(new Error('down'));
    expect(await store.persist({ size: 16 })).toBe(false);
    expect(store.size()).toBe(16);
  });

  it('preserves edits made during hydration while applying untouched settings', async () => {
    const store = make();
    let finish!: (saved: Record<string, unknown>) => void;
    api.all.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const loading = store.loadPersisted();
    await store.persist({ size: 19 });
    finish({ size: 12, density: true });
    await loading;
    expect(store.size()).toBe(19);
    expect(store.dense()).toBe(true);
    expect(JSON.parse(localStorage.getItem('spec.prefs') ?? '{}')).toEqual({ size: 19, dense: true });
  });

  it('does not hydrate over an edit whose save was already pending', async () => {
    const store = make();
    let finish!: () => void;
    api.set.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const saving = store.persist({ size: 21 });
    saved['size'] = 12;
    await store.loadPersisted();
    expect(store.size()).toBe(21);
    finish();
    await saving;
  });

  it('orders writes to the same preference and continues after a failed save', async () => {
    const store = make();
    let fail!: (error: Error) => void;
    api.set.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          fail = reject;
        }),
    );
    const first = store.persist({ size: 15 });
    const second = store.persist({ size: 20 });
    expect(store.size()).toBe(20);
    expect(api.set).toHaveBeenCalledTimes(1);
    fail(new Error('offline'));
    expect(await first).toBe(false);
    expect(await second).toBe(true);
    expect(saved['size']).toBe(20);
    expect(api.set).toHaveBeenLastCalledWith('size', 20);
  });

  it('loadPersisted takes the backend values and ignores what does not validate', async () => {
    saved['size'] = 'huge';
    saved['density'] = true;
    const store = make();
    await store.loadPersisted();
    expect(store.size()).toBe(14);
    expect(store.dense()).toBe(true);
  });
});

describe('withBackendEvents', () => {
  it('hands every status to the store and keeps the newest', () => {
    const channel = new Subject<BackendStatus>();
    const seen: string[] = [];
    const Store = signalStore(
      withBackendEvents(),
      withMethods(() => ({})),
      withHooks({
        onInit(store) {
          store.watchBackend((status) => seen.push(status.state));
        },
      }),
    );
    const store = TestBed.configureTestingModule({
      providers: [{ provide: BACKEND_STATUS, useValue: channel }],
    }).runInInjectionContext(() => new Store());
    channel.next({ state: 'restarting', restarts: 1 });
    channel.next({ state: 'running', restarts: 1 });
    expect(seen).toEqual(['restarting', 'running']);
    expect(store.backendStatus()?.state).toBe('running');
  });
});
