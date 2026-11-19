import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { autoUpdater } from 'electron-updater';
import { AppUpdater } from './app-updater';

vi.mock('node:timers/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:timers/promises')>();
  return { ...original, setTimeout: vi.fn(original.setTimeout) };
});

const electron = vi.hoisted(() => ({ isPackaged: true }));
vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return electron.isPackaged;
    },
  },
}));
vi.mock('electron-updater', () => ({
  autoUpdater: {
    on: vi.fn(),
    isUpdaterActive: vi.fn(() => true),
    checkForUpdates: vi.fn(),
    downloadUpdate: vi.fn(),
    quitAndInstall: vi.fn(),
  },
}));

beforeEach(() => vi.clearAllMocks());

describe('app release availability', () => {
  it.each([
    { statusCode: 404 },
    { code: 'ERR_UPDATER_NO_PUBLISHED_VERSIONS' },
    { code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' },
    { code: 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND', message: 'Request failed: 404 Not Found' },
    { code: 'ENOENT', path: '/app/Resources/app-update.yml' },
  ])('reports an unavailable feed without claiming the installed app is current', async (failure) => {
    vi.mocked(autoUpdater.checkForUpdates).mockRejectedValueOnce(Object.assign(new Error('missing release'), failure));
    expect(await new AppUpdater(vi.fn()).run('check')).toEqual({
      unavailable: expect.stringContaining('App updates are unavailable'),
    });
    expect(autoUpdater.downloadUpdate).not.toHaveBeenCalled();
  });

  it('keeps network failures actionable instead of treating them as an absent release', async () => {
    const error = Object.assign(new Error('Connection timed out'), { code: 'ETIMEDOUT' });
    vi.mocked(autoUpdater.checkForUpdates).mockRejectedValueOnce(error);
    await expect(new AppUpdater(vi.fn()).run('check')).rejects.toBe(error);
  });
});

describe('copies that cannot update themselves', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    electron.isPackaged = true;
  });

  it('answers a development build as unavailable without touching electron-updater', async () => {
    electron.isPackaged = false;
    expect(await new AppUpdater(vi.fn()).run('check')).toHaveProperty('unavailable');
    expect(autoUpdater.on).not.toHaveBeenCalled();
    expect(autoUpdater.isUpdaterActive).not.toHaveBeenCalled();
  });

  it.each(['check', 'download'] as const)(
    'answers %s as unavailable without electron-updater installing the NSIS build',
    async (action) => {
      vi.stubEnv('PORTABLE_EXECUTABLE_FILE', 'C:\\Tools\\pi-kit-portable.exe');
      expect(await new AppUpdater(vi.fn()).run(action)).toEqual({
        unavailable: expect.stringContaining('portable build'),
      });
      expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled();
      expect(autoUpdater.downloadUpdate).not.toHaveBeenCalled();
    },
  );

  it('answers unavailable for a Linux copy not running as the AppImage instead of up to date', async () => {
    vi.mocked(autoUpdater.isUpdaterActive).mockReturnValueOnce(false);
    expect(await new AppUpdater(vi.fn()).run('check')).toEqual({ unavailable: expect.stringContaining('AppImage') });
    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled();
  });
});

describe('a packaged build', () => {
  const events = [
    'checking-for-update',
    'update-available',
    'update-not-available',
    'download-progress',
    'update-downloaded',
    'error',
  ];

  it('wires electron-updater on the first request and forwards its events', async () => {
    const emit = vi.fn();
    await new AppUpdater(emit).run('check');
    expect(autoUpdater.autoDownload).toBe(false);
    expect(autoUpdater.autoInstallOnAppQuit).toBe(true);
    expect(autoUpdater.allowPrerelease).toBe(false);
    expect(autoUpdater.fullChangelog).toBe(true);
    expect(vi.mocked(autoUpdater.on).mock.calls.map(([event]) => event)).toEqual(events);
    const [, onAvailable] = vi.mocked(autoUpdater.on).mock.calls.find(([event]) => event === 'update-available') ?? [];
    (onAvailable as (info: { version: string }) => void)({ version: '0.11.0' });
    expect(emit).toHaveBeenCalledWith({ kind: 'available', version: '0.11.0' });
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it('registers the listeners once, not on every request', async () => {
    const updater = new AppUpdater(vi.fn());
    await updater.run('check');
    await updater.run('check');
    expect(autoUpdater.on).toHaveBeenCalledTimes(events.length);
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(2);
  });
});

describe('release notes', () => {
  it("passes on GitHub's notes of every newer release, without the empty ones", async () => {
    const releaseNotes = [
      { version: '0.9.1', note: '<p>Fixes</p>' },
      { version: '0.9.0', note: null },
      { version: '0.8.10', note: '<p>Features</p>' },
    ];
    vi.mocked(autoUpdater.checkForUpdates).mockResolvedValueOnce({
      isUpdateAvailable: true,
      updateInfo: { version: '0.9.1', releaseNotes },
    } as never);
    expect(await new AppUpdater(vi.fn()).run('check')).toMatchObject({
      available: true,
      version: '0.9.1',
      notes: [
        { version: '0.9.1', html: '<p>Fixes</p>' },
        { version: '0.8.10', html: '<p>Features</p>' },
      ],
    });
  });
});

describe('native installation readiness and acknowledgement', () => {
  afterEach(() => vi.useRealTimers());

  const ready = () => {
    const listener = vi.mocked(autoUpdater.on).mock.calls.find(([event]) => event === 'update-downloaded')?.[1];
    (listener as (info: { version: string }) => void)({ version: '0.12.0' });
  };

  it('waits for native readiness after the download promise resolves', async () => {
    vi.mocked(autoUpdater.downloadUpdate).mockResolvedValueOnce([]);
    const updater = new AppUpdater(vi.fn());
    let answered = false;
    const download = updater.run('download').then((result) => {
      answered = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(answered).toBe(false);
    expect(updater.pending).toBe(false);
    ready();
    expect(await download).toMatchObject({ downloaded: true });
    expect(updater.pending).toBe(true);
  });

  it('does not claim download readiness when the native-ready deadline expires', async () => {
    vi.mocked(autoUpdater.downloadUpdate).mockResolvedValueOnce([]);
    vi.mocked(delay).mockResolvedValueOnce(false);
    const updater = new AppUpdater(vi.fn());
    expect(await updater.run('download')).toMatchObject({ downloaded: false });
    expect(delay).toHaveBeenCalledWith(120_000, false, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(await updater.run('install')).toMatchObject({ downloaded: false });
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();
  });

  it('acknowledges installation before stopping the host, and waits for stop before quitting', async () => {
    vi.useFakeTimers();
    let stopped!: () => void;
    const beforeInstall = vi.fn(() => new Promise<void>((resolve) => (stopped = resolve)));
    const updater = new AppUpdater(vi.fn(), beforeInstall);
    await updater.run('check');
    ready();
    expect(await updater.run('install')).toMatchObject({ downloaded: true });
    expect(beforeInstall).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(300);
    expect(beforeInstall).toHaveBeenCalledOnce();
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();
    stopped();
    await vi.advanceTimersByTimeAsync(0);
    expect(autoUpdater.quitAndInstall).toHaveBeenCalledExactlyOnceWith(true, true);
  });

  it('reports shutdown failure without running the installer', async () => {
    vi.useFakeTimers();
    const emit = vi.fn();
    const updater = new AppUpdater(emit, async () => {
      throw new Error('host could not stop');
    });
    await updater.run('check');
    ready();
    await updater.run('install');
    await vi.advanceTimersByTimeAsync(300);
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith({ kind: 'error', message: expect.stringContaining('host could not stop') });
  });
});

describe('matching a service that a newer install runs', () => {
  const published = (version: string) => ({ isUpdateAvailable: true, updateInfo: { version, releaseNotes: '' } });

  it.each(['0.12.0', '0.13.0'])(
    'installs the published %s for a 0.12.0 service and quits to do it',
    async (version) => {
      vi.mocked(autoUpdater.checkForUpdates).mockResolvedValueOnce(published(version) as never);
      // As electron-updater does: a finished download is reported, and only then is it installable.
      vi.mocked(autoUpdater.downloadUpdate).mockImplementationOnce(async () => {
        const downloaded = vi.mocked(autoUpdater.on).mock.calls.find(([event]) => event === 'update-downloaded')?.[1];
        (downloaded as ((info: { version: string }) => void) | undefined)?.({ version });
        return [];
      });
      expect(await new AppUpdater(vi.fn()).updateTo('0.12.0')).toBe(true);
      expect(autoUpdater.downloadUpdate).toHaveBeenCalledOnce();
      await vi.waitFor(() => expect(autoUpdater.quitAndInstall).toHaveBeenCalledExactlyOnceWith(true, true));
    },
  );

  it.each([
    [
      'only an older release',
      () => vi.mocked(autoUpdater.checkForUpdates).mockResolvedValueOnce(published('0.11.5') as never),
    ],
    [
      'no newer release',
      () => vi.mocked(autoUpdater.checkForUpdates).mockResolvedValueOnce({ isUpdateAvailable: false } as never),
    ],
    ['a failing feed', () => vi.mocked(autoUpdater.checkForUpdates).mockRejectedValueOnce(new Error('offline'))],
    [
      'a feed that does not answer',
      () => vi.mocked(autoUpdater.checkForUpdates).mockReturnValueOnce(new Promise(() => undefined)),
    ],
  ])('leaves the app as it is with %s', async (_, feed) => {
    feed();
    expect(await new AppUpdater(vi.fn()).updateTo('0.12.0', 20)).toBe(false);
    expect(autoUpdater.downloadUpdate).not.toHaveBeenCalled();
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();
  });
});
