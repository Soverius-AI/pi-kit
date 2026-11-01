import { app } from 'electron';
import { autoUpdater } from 'electron-updater';

/**
 * pi-kit's own updates: `electron-updater` against the GitHub repository in `app-update.yml` (the `publish` block of
 * `electron-builder.config.cjs`). The backend's `UpdateService` decides when to check and asks over the `DesktopBridge` IPC channel;
 * nothing is downloaded without that request, and a downloaded update installs on the next quit or on "Restart to update".
 */

export type AppUpdateAction = 'check' | 'download' | 'install';

export interface AppUpdateResult {
  /** A newer pi-kit than this one is published. */
  available?: boolean;
  version?: string;
  /** The update is downloaded and waits for a restart. */
  downloaded?: boolean;
  /** Why nothing can be done: a development or portable build, or no reachable release feed. */
  unavailable?: string;
}

export type AppUpdateEvent =
  | { kind: 'checking' }
  | { kind: 'available'; version: string }
  | { kind: 'none' }
  | { kind: 'progress'; percent: number; bytesPerSecond: number }
  | { kind: 'downloaded'; version: string }
  | { kind: 'error'; message: string };

function unavailableFeed(error: unknown): string | undefined {
  const failure = error as { code?: string; statusCode?: number; message?: string; path?: string } | undefined;
  if (failure?.code === 'ENOENT' && /(?:^|[/\\])app-update\.yml$/.test(failure.path ?? '')) {
    return 'App updates are unavailable in this build: no update feed is configured.';
  }
  if (failure?.statusCode === 404 || failure?.code === 'ERR_UPDATER_NO_PUBLISHED_VERSIONS' || failure?.code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' ||
    (failure?.code === 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND' && /\b404\b/.test(failure.message ?? ''))) {
    return 'App updates are unavailable: no accessible release feed was found. The GitHub repository must expose a published release with update files for this platform.';
  }
  return undefined;
}

/** Answers the backend's update requests and forwards every updater event through `emit`. */
export class AppUpdater {
  private latest: string | undefined;
  private downloaded = false;

  constructor(private readonly emit: (event: AppUpdateEvent) => void) {
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowPrerelease = false;
    autoUpdater.on('checking-for-update', () => emit({ kind: 'checking' }));
    autoUpdater.on('update-available', (info) => {
      this.latest = info.version;
      emit({ kind: 'available', version: info.version });
    });
    autoUpdater.on('update-not-available', () => emit({ kind: 'none' }));
    autoUpdater.on('download-progress', (progress) => emit({ kind: 'progress', percent: Math.round(progress.percent), bytesPerSecond: Math.round(progress.bytesPerSecond) }));
    autoUpdater.on('update-downloaded', (info) => {
      this.downloaded = true;
      this.latest = info.version;
      emit({ kind: 'downloaded', version: info.version });
    });
    autoUpdater.on('error', (error) => emit({ kind: 'error', message: unavailableFeed(error) ?? error?.message ?? String(error) }));
  }

  async run(action: AppUpdateAction): Promise<AppUpdateResult> {
    if (!app.isPackaged) return { unavailable: 'Updates apply to the installed app, not to a development build.' };
    // electron-updater would install the NSIS build next to it instead of replacing the portable .exe.
    if (process.env['PORTABLE_EXECUTABLE_FILE']) return { unavailable: 'The portable build does not update itself: download the new one from the GitHub releases page.' };
    // On Linux only a running AppImage can replace itself; any other copy's check resolves null, which would read as "up to date".
    if (!autoUpdater.isUpdaterActive()) return { unavailable: 'Only the AppImage updates itself: download the new one from the GitHub releases page.' };
    switch (action) {
      case 'check': {
        let result;
        try {
          result = await autoUpdater.checkForUpdates();
        } catch (error) {
          const unavailable = unavailableFeed(error);
          if (unavailable) return { unavailable };
          throw error;
        }
        const info = result?.updateInfo;
        const newer = !!info && !!result?.isUpdateAvailable;
        if (newer) this.latest = info.version;
        return { available: newer, ...(newer ? { version: info.version } : {}), downloaded: this.downloaded };
      }
      case 'download': {
        if (!this.downloaded) await autoUpdater.downloadUpdate();
        return { available: true, ...(this.latest ? { version: this.latest } : {}), downloaded: true };
      }
      case 'install': {
        if (!this.downloaded) return { available: !!this.latest, downloaded: false };
        // Quits the app, installs, restarts it. Called after the reply went out, so the backend hears "ok" first.
        setTimeout(() => autoUpdater.quitAndInstall(false, true), 300);
        return { available: true, downloaded: true, ...(this.latest ? { version: this.latest } : {}) };
      }
    }
  }
}
