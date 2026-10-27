import { TestBed } from '@angular/core/testing';
import { BackendService, BackendStatus } from '@pi-kit/api';
import { Subject } from 'rxjs';
import { HealthStore } from './health.store';
import { DEFAULT_RENDERER_POLICY, RENDERER_POLICY } from './renderer-policy';
import { BACKEND_STATUS } from './store';
import { ToastStore } from './toast.store';

describe('HealthStore', () => {
  let answer: () => Response;
  const channel = new Subject<BackendStatus>();
  const fakeBackend = { fetch: vi.fn(async () => answer()) };
  const ok = (bootId: string) => () => new Response(JSON.stringify({ status: 'ok', bootId }), { status: 200 });
  const make = async () => {
    const store = TestBed.inject(HealthStore);
    await store.check();
    return store;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    answer = ok('boot-1');
    fakeBackend.fetch.mockClear();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: BackendService, useValue: fakeBackend },
        { provide: BACKEND_STATUS, useValue: channel },
      ],
    });
  });
  afterEach(() => vi.useRealTimers());

  it('is ok after the first answer', async () => {
    const health = await make();
    expect(health.state()).toBe('ok');
    expect(health.epoch()).toBe(0);
  });

  it('two misses in a row are an outage; the return bumps the epoch and says so', async () => {
    const health = await make();
    const toasts = TestBed.inject(ToastStore);
    answer = () => new Response('{}', { status: 500 });
    await vi.advanceTimersByTimeAsync(4000);
    expect(health.state()).toBe('ok');
    await vi.advanceTimersByTimeAsync(4000);
    expect(health.state()).toBe('error');
    answer = ok('boot-1');
    await vi.advanceTimersByTimeAsync(4000);
    expect(health.state()).toBe('ok');
    expect(health.epoch()).toBe(1);
    expect(toasts.items().at(-1)?.text).toBe('Reconnected to the backend.');
  });

  it('a new bootId is a restart', async () => {
    const health = await make();
    answer = ok('boot-2');
    await vi.advanceTimersByTimeAsync(4000);
    expect(health.epoch()).toBe(1);
    expect(TestBed.inject(ToastStore).items().at(-1)?.level).toBe('success');
  });

  it('the watchdog saying "restarting" is an outage before the poll misses', async () => {
    const health = await make();
    channel.next({ state: 'restarting', restarts: 1 });
    expect(health.state()).toBe('error');
    expect(health.backendStatus()?.state).toBe('restarting');
    expect(TestBed.inject(ToastStore).items().at(-1)?.level).toBe('warning');
    channel.next({ state: 'running', restarts: 1 });
    await health.poll();
    expect(health.state()).toBe('ok');
    expect(health.epoch()).toBe(1);
  });
  it('uses injected polling and outage thresholds', async () => {
    TestBed.overrideProvider(RENDERER_POLICY, {
      useValue: { ...DEFAULT_RENDERER_POLICY, healthPollMs: 25, healthTimeoutMs: 10, healthMisses: 1 },
    });
    const health = await make();
    answer = () => new Response('{}', { status: 500 });
    await vi.advanceTimersByTimeAsync(24);
    expect(health.state()).toBe('ok');
    await vi.advanceTimersByTimeAsync(1);
    expect(health.state()).toBe('error');
  });
});
