import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { autoUpdater } from 'electron-updater';
import { AppUpdater } from './app-updater';

const electron = vi.hoisted(() => ({ isPackaged: true }));
vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return electron.isPackaged;
    },
  },
}));
vi.mock('electron-updater', () => ({
  autoUpdater: { on: vi.fn(), isUpdaterActive: vi.fn(() => true), checkForUpdates: vi.fn(), downloadUpdate: vi.fn() },
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
