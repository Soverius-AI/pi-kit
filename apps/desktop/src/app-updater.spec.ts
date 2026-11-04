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
