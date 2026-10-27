import { beforeEach, describe, expect, it, vi } from 'vitest';
import { autoUpdater } from 'electron-updater';
import { AppUpdater } from './app-updater';

vi.mock('electron', () => ({ app: { isPackaged: true } }));
vi.mock('electron-updater', () => ({ autoUpdater: { on: vi.fn(), checkForUpdates: vi.fn(), downloadUpdate: vi.fn() } }));

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
    expect(await new AppUpdater(vi.fn()).run('check')).toEqual({ unavailable: expect.stringContaining('App updates are unavailable') });
    expect(autoUpdater.downloadUpdate).not.toHaveBeenCalled();
  });

  it('keeps network failures actionable instead of treating them as an absent release', async () => {
    const error = Object.assign(new Error('Connection timed out'), { code: 'ETIMEDOUT' });
    vi.mocked(autoUpdater.checkForUpdates).mockRejectedValueOnce(error);
    await expect(new AppUpdater(vi.fn()).run('check')).rejects.toBe(error);
  });
});
