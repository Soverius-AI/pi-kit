import { TestBed } from '@angular/core/testing';
import {
  localRuntimeCancel,
  localRuntimeRetry,
  localRuntimeStorage,
  localRuntimeDismiss,
  localRuntimeDownload,
  localRuntimeStatus,
  provideMockApi,
} from '@pi-kit/api';
import { ToastStore } from '@pi-kit/data-access';
import type { LocalRuntimeJob } from '@pi-kit/protocol';
import { LocalModelCatalogStore } from './local-model-catalog.store';
import { LOCAL_RUNTIME_POLL_MS, LocalRuntimeStore } from './local-runtime.store';
import { SettingsStore } from './settings.store';

const job = (state: LocalRuntimeJob['state']): LocalRuntimeJob => ({
  id: 'job-1',
  kind: 'download',
  state,
  detail: 'Selected download',
  startedAt: 1,
  logs: [],
  ...(state === 'complete'
    ? { model: { id: 'downloaded', file: 'model.gguf', path: '/models/model.gguf', bytes: 64 } }
    : {}),
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe('local setup observation through the generated API', () => {
  const status = vi.fn(),
    download = vi.fn(),
    cancel = vi.fn(),
    retry = vi.fn(),
    dismiss = vi.fn();
  const catalog = { detect: vi.fn(async () => undefined), rememberDownload: vi.fn() };
  const settings = { load: vi.fn(async () => undefined) };
  const toasts = { show: vi.fn() };
  beforeEach(() => {
    vi.useFakeTimers();
    for (const mock of [
      status,
      download,
      cancel,
      retry,
      dismiss,
      catalog.detect,
      catalog.rememberDownload,
      settings.load,
      toasts.show,
    ])
      mock.mockClear();
    status.mockReset().mockResolvedValue({ autostart: false });
    download.mockReset().mockResolvedValue(job('running'));
    cancel.mockReset();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: LOCAL_RUNTIME_POLL_MS, useValue: 100 },
        { provide: LocalModelCatalogStore, useValue: catalog },
        { provide: SettingsStore, useValue: settings },
        { provide: ToastStore, useValue: toasts },
        ...provideMockApi([
          [localRuntimeStatus, status, () => []],
          [localRuntimeStorage, vi.fn(async () => ({ directory: '/models', freeBytes: 1000, files: [] })), () => []],
          [localRuntimeRetry, retry, () => []],
          [localRuntimeDismiss, dismiss, () => []],
          [localRuntimeDownload, download, (options) => [options.body]],
          [localRuntimeCancel, cancel, () => []],
        ]),
      ],
    });
  });
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.useRealTimers();
  });

  it('keeps accepted work observed after the last view closes, refreshes once on completion, then stops polling', async () => {
    const store = TestBed.inject(LocalRuntimeStore);
    const leave = store.observe();
    await vi.advanceTimersByTimeAsync(0);
    await store.download('pinned-choice');
    expect(download).toHaveBeenCalledWith({ selection: 'pinned-choice', accept: true });
    leave();
    leave();
    status
      .mockResolvedValueOnce({ autostart: false, job: job('running') })
      .mockResolvedValue({ autostart: false, job: job('complete') });
    await vi.advanceTimersByTimeAsync(200);
    expect(store.status()?.job?.state).toBe('complete');
    expect(catalog.rememberDownload).toHaveBeenCalledExactlyOnceWith('downloaded');
    expect(catalog.detect).toHaveBeenCalledOnce();
    expect(settings.load).toHaveBeenCalledOnce();
    expect(toasts.show).toHaveBeenCalledExactlyOnceWith('success', expect.stringContaining('complete'));
    const calls = status.mock.calls.length;
    await vi.advanceTimersByTimeAsync(500);
    expect(status).toHaveBeenCalledTimes(calls);
  });

  it('ignores a stale status response accepted before a newer mutation, even if the transport ignores abort', async () => {
    const old = deferred<{ autostart: boolean }>();
    status.mockReturnValueOnce(old.promise);
    const store = TestBed.inject(LocalRuntimeStore),
      leave = store.observe();
    await store.download('choice');
    old.resolve({ autostart: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(store.status()?.job?.state).toBe('running');
    leave();
  });

  it('does not offer retries for legacy private engine startup jobs', async () => {
    status.mockResolvedValue({
      autostart: false,
      job: { ...job('failed'), kind: 'start', action: { kind: 'start', modelId: 'legacy', autostart: true } },
    });
    const store = TestBed.inject(LocalRuntimeStore),
      leave = store.observe();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.canRetry()).toBe(false);
    await store.retry();
    expect(retry).not.toHaveBeenCalled();
    leave();
  });
  it('can retry a persisted job without a local callback and clears it when dismissed', async () => {
    const action = { kind: 'install' as const, tools: ['llama-swap' as const] };
    status.mockResolvedValue({ autostart: false, job: { ...job('failed'), kind: 'install', action } });
    retry.mockResolvedValue({ ...job('running'), kind: 'install', action });
    dismiss.mockResolvedValue({ autostart: false });
    const store = TestBed.inject(LocalRuntimeStore),
      leave = store.observe();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.canRetry()).toBe(true);
    await store.retry();
    expect(retry).toHaveBeenCalledOnce();
    status.mockResolvedValue({ autostart: false, job: { ...job('complete'), kind: 'install', action } });
    await vi.advanceTimersByTimeAsync(100);
    await store.dismiss();
    expect(store.status()?.job).toBeUndefined();
    expect(store.canRetry()).toBe(false);
    leave();
  });
});
