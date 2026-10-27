import { TestBed } from '@angular/core/testing';
import {
  provideMockApi,
  updateCancel,
  updateCheck,
  updateInstallApp,
  updateInstallCommand,
  updatePin,
  updateReleases,
  updateRestart,
  updateStart,
} from '@pi-kit/api';
import { ToastStore } from '@pi-kit/data-access';
import type { UpdateEvent, UpdateStatus } from '@pi-kit/protocol';
import { Observable, Subject } from 'rxjs';

import { UpdateStore } from './update.store';

const status = (over: Partial<UpdateStatus> = {}): UpdateStatus =>
  ({
    rows: [{ target: 'pi', current: '1.3.0', latest: '1.4.0', outdated: true }],
    outdated: true,
    restart: [],
    checking: false,
    ...over,
  }) as unknown as UpdateStatus;

describe('UpdateStore', () => {
  let events: Subject<UpdateEvent>;
  let subscriptions: number;
  const api = {
    events: vi.fn(
      () =>
        new Observable<UpdateEvent>((subscriber) => {
          subscriptions += 1;
          const inner = events.subscribe(subscriber);
          return () => inner.unsubscribe();
        }),
    ),
    check: vi.fn(async () => status()),
    start: vi.fn(async (targets: string[]) => {
      void targets;
      return status();
    }),
    cancel: vi.fn(async () => status()),
    restart: vi.fn(async () => ({ restarting: true as const })),
    installApp: vi.fn(async () => ({ installing: true as const })),
    installCommand: vi.fn(async () => status()),
    releases: vi.fn(async () => ({ choices: [{ release: '1.2.0', label: 'pi 1.2.0' }] })),
    pin: vi.fn(async (release: string | null) => {
      void release;
      return status();
    }),
  };

  beforeEach(() => {
    vi.useFakeTimers();
    events = new Subject<UpdateEvent>();
    subscriptions = 0;
    for (const fn of Object.values(api)) fn.mockClear();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        ...provideMockApi(
          [
            [updateCheck, api.check, () => []],
            [updateStart, api.start, (o) => [o.body?.['targets']]],
            [updateCancel, api.cancel, () => []],
            [updateRestart, api.restart, () => []],
            [updateInstallApp, api.installApp, () => []],
            [updateInstallCommand, api.installCommand, () => []],
            [updateReleases, api.releases, () => []],
            [updatePin, api.pin, (o) => [o.body?.['release']]],
          ],
          [[/^\/api\/update\/events$/, api.events, () => []]],
        ),
      ],
    });
  });
  afterEach(() => vi.useRealTimers());

  const make = async () => {
    const store = TestBed.inject(UpdateStore);
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(0);
    return store;
  };

  it('follows the status stream and keeps the newest output lines', async () => {
    const update = await make();
    events.next({ type: 'status', status: status() } as UpdateEvent);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(update.connected()).toBe(true);
    expect(update.attention()).toBe(true);
    expect(update.pi()?.latest).toBe('1.4.0');
    for (let i = 0; i < 70; i++) events.next({ type: 'line', text: `line ${i}`, at: i } as UpdateEvent);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(update.lines()).toHaveLength(60);
    expect(update.lines().at(-1)?.text).toBe('line 69');
  });

  it('opens the stream again after a pause when it drops', async () => {
    const update = await make();
    events.next({ type: 'status', status: status() } as UpdateEvent);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    events.error(new Error('closed'));
    await vi.advanceTimersByTimeAsync(0);
    expect(update.connected()).toBe(false);
    events = new Subject<UpdateEvent>();
    await vi.advanceTimersByTimeAsync(3000);
    expect(subscriptions).toBe(2);
  });

  it('a request is loading while it runs and the status it returns is taken', async () => {
    const update = await make();
    const pending = update.check();
    expect(update.loading()).toBe(true);
    await pending;
    expect(update.loading()).toBe(false);
    expect(update.status()).toBeDefined();
  });

  it('update clears the old output and sends the targets', async () => {
    const update = await make();
    events.next({ type: 'line', text: 'old', at: 1 } as UpdateEvent);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    await update.update(['pi', 'packages']);
    expect(api.start).toHaveBeenCalledWith(['pi', 'packages']);
    expect(update.lines()).toEqual([]);
  });

  it('a failed request is a toast and the buttons come back', async () => {
    const update = await make();
    api.start.mockRejectedValueOnce(new Error('already running'));
    await update.update(['pi']);
    expect(TestBed.inject(ToastStore).items().at(-1)?.text).toBe('Could not start the update: already running');
    expect(update.loading()).toBe(false);
    expect(update.error()).toBe('already running');
  });

  it('the restart notice can be dismissed for one version', async () => {
    const update = await make();
    events.next({
      type: 'status',
      status: status({ restart: [{ kind: 'pi', version: '1.4.0' }] as never }),
    } as UpdateEvent);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(update.restartNotice()?.version).toBe('1.4.0');
    update.dismissRestart();
    expect(update.restartNotice()).toBeUndefined();
    events.next({
      type: 'status',
      status: status({ restart: [{ kind: 'pi', version: '1.5.0' }] as never }),
    } as UpdateEvent);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(update.restartNotice()?.version).toBe('1.5.0');
  });

  it('pinning a release reads the choices again', async () => {
    const update = await make();
    await update.loadReleases();
    expect(update.releases()).toHaveLength(1);
    await update.pin('1.2.0');
    expect(api.pin).toHaveBeenCalledWith('1.2.0');
    expect(api.releases).toHaveBeenCalledTimes(2);
  });
});
