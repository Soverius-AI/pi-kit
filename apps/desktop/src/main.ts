import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent, Menu, type MenuItemConstructorOptions, nativeImage, nativeTheme, shell, systemPreferences, Tray } from 'electron';
import { join } from 'node:path';
import { APP_ORIGIN, registerAppScheme, serveRenderer } from './app-protocol';
import { AppUpdater, type AppUpdateAction } from './app-updater';
import { allocateEndpoint, type BackendEndpoint, launchForWatchdog, pingHealth, type RunningBackend, spawnBackend } from './backend';
import { FileLog } from './log';
import { BrowserArtifacts } from './browser';
import { BrowserActionSchema, BrowserOperationError, BrowserViewportSchema } from '@pi-kit/protocol';
import { MICROPHONE_SETTINGS_URL, requestMicrophone } from './microphone';
import { loginShellPath } from './shell-env';
import { SMOKE, smokeDataDir, writeSmokeReport } from './smoke';
import { BackendWatchdog, DEFAULT_WATCHDOG_OPTIONS, type WatchdogStatus } from './watchdog';
import { UiStorage } from './ui-storage';

/** Set by `pnpm run dev` to the Angular dev server. Unset in production: the static build is served. */
const DEV_URL = process.env['PI_KIT_DEV_URL'];
const RENDERER_ORIGIN = DEV_URL ? new URL(DEV_URL).origin : APP_ORIGIN;
// Development: dist/apps/desktop/main.cjs -> dist/apps/{backend,renderer/browser}.
// Packaged: Resources/app.asar/desktop/main.cjs holds the shell and renderer; the backend is a real folder, Resources/backend.
const BACKEND_ENTRY = app.isPackaged ? join(process.resourcesPath, 'backend', 'main.js') : join(__dirname, '..', 'backend', 'main.js');
// The app waits for the backend as long as it runs: a migration, a Keychain prompt or a busy machine takes what it takes; only a backend
// that exits ends the wait. (Until 0.8 the wait gave up after 30 s, or 5 minutes with Touch ID, and killed a backend that was still starting.)
const HEALTH_TIMEOUT_MS = Infinity;
const RENDERER_ROOT = join(__dirname, '..', 'renderer', 'browser');

/** The backend that is running now (it changes when the watchdog restarts it). */
let backend: RunningBackend | undefined;
let endpoint: BackendEndpoint | undefined;
let watchdog: BackendWatchdog | undefined;
let latestStatus: WatchdogStatus = { state: 'starting', restarts: 0 };
let mainLog: FileLog | undefined;
let backendLog: FileLog | undefined;
let appUpdater: AppUpdater | undefined;
let tray: Tray | undefined;
let uiStorage: UiStorage | undefined;
interface TrayThread { id: string; title: string; project: string; state: 'running' | 'waiting' }
let trayThreads: TrayThread[] = [];
let trayLabels: ReturnType<typeof trayLabelsInput> | undefined;
const browserArtifacts = new BrowserArtifacts(() => [RENDERER_ORIGIN, ...(endpoint ? [endpoint.url] : [])]);
const browserRequests = new Map<string, AbortController>();
const splashState = { loaded: false, shown: false };

// Fixes the userData folder (and with it the database) to .../pi-kit however Electron is launched.
app.setName('pi-kit');

// Smoke mode (scripts/release-smoke.mjs): data and logs in the scratch folder the script names, a SIGTERM quits like Cmd+Q.
const SMOKE_DIR = smokeDataDir();
if (SMOKE_DIR) {
  app.setPath('userData', SMOKE_DIR);
  app.setPath('logs', join(SMOKE_DIR, 'logs'));
}
// A development launch (`pnpm dev`, `nx start desktop`) is not the signed app: Touch ID and its keychain group are out of reach, and the
// installed app's database is keyed to them. So a development build keeps a profile of its own (`PI_KIT_DATA_DIR`, else `.pi-kit-data-desktop`
// in the working directory), and never opens the installed app's data. Like production, a fresh profile does not enable Keychain.
const DEV_DIR = !app.isPackaged && !SMOKE_DIR ? process.env['PI_KIT_DATA_DIR'] || join(process.cwd(), '.pi-kit-data-desktop') : undefined;
if (DEV_DIR) app.setPath('userData', DEV_DIR);
if (SMOKE) process.on('SIGTERM', () => app.quit());

registerAppScheme();

/** Only our own renderer may ask for the backend address and token. */
function isRendererUrl(url: string | undefined): boolean {
  // URL.origin is "null" for the custom app:// scheme, so compare the prefix.
  return !!url && url !== `${APP_ORIGIN}/__ui-storage` && (url === RENDERER_ORIGIN || url.startsWith(`${RENDERER_ORIGIN}/`));
}

function fromRenderer(event: IpcMainInvokeEvent): boolean {
  return isRendererUrl(event.senderFrame?.url);
}

/** Where pi-kit comes from, for the About panel and the splash. */
const PUBLISHER = 'Soverius.AI GmbH';
/**
 * The app icon next to the bundle (apps/desktop/build/icon.png, copied by the desktop build). A packaged app carries the
 * .icns/.ico electron-builder made from it; in development Electron would show its own icon, so the Dock (macOS) and the
 * windows (Windows, Linux) get this one explicitly.
 */
const APP_ICON = join(__dirname, 'icon.png');

function trayInput(value: unknown): TrayThread[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 100).flatMap((item): TrayThread[] => {
    if (!item || typeof item !== 'object') return [];
    const row = item as Record<string, unknown>;
    if (typeof row['id'] !== 'string' || typeof row['title'] !== 'string' || typeof row['project'] !== 'string' || (row['state'] !== 'running' && row['state'] !== 'waiting')) return [];
    return [{ id: row['id'].slice(0, 200), title: row['title'].slice(0, 200), project: row['project'].slice(0, 200), state: row['state'] }];
  });
}

/** Only translated text crosses this boundary; native menu actions stay owned by the main process. */
function trayLabelsInput(copy: unknown) {
  const keys = ['needsYou', 'runningThreads', 'noActiveThreads', 'showApp', 'quit', 'tooltip', 'waitingMore', 'runningMore'] as const;
  if (!copy || typeof copy !== 'object' || !keys.every((key) => typeof (copy as Record<string, unknown>)[key] === 'string')) throw new Error('Invalid tray labels.');
  return Object.fromEntries(keys.map((key) => [key, (copy as Record<string, string>)[key].slice(0, 500)])) as Record<(typeof keys)[number], string>;
}

function rendererWindow(): BrowserWindow | undefined {
  return BrowserWindow.getAllWindows().find((win) => !win.isDestroyed() && isRendererUrl(win.webContents.getURL()));
}

function showRenderer(threadId?: string): void {
  const win = rendererWindow();
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  if (threadId) win.webContents.send('pi-kit:tray-open-thread', threadId);
}

function updateTray(): void {
  if (!tray) return;
  const labels = trayLabels;
  if (!labels) {
    tray.setToolTip('pi-kit');
    tray.setContextMenu(Menu.buildFromTemplate([{ role: 'quit' }]));
    return;
  }
  const waiting = trayThreads.filter((thread) => thread.state === 'waiting');
  const running = trayThreads.filter((thread) => thread.state === 'running');
  const entries = (title: string, threads: TrayThread[], more: string): MenuItemConstructorOptions[] => {
    if (threads.length === 0) return [];
    return [
      { label: title, enabled: false },
      ...threads.slice(0, 12).map((thread) => ({
        label: `${thread.title} · ${thread.project}`,
        click: () => showRenderer(thread.id),
      })),
      ...(threads.length > 12 ? [{ label: more, enabled: false }] : []),
      { type: 'separator' as const },
    ];
  };
  const active = waiting.length + running.length;
  tray.setToolTip(labels.tooltip);
  tray.setContextMenu(Menu.buildFromTemplate([
    ...entries(labels.needsYou, waiting, labels.waitingMore),
    ...entries(labels.runningThreads, running, labels.runningMore),
    ...(active === 0 ? [{ label: labels.noActiveThreads, enabled: false }, { type: 'separator' as const }] : []),
    { label: labels.showApp, click: () => showRenderer() },
    { label: labels.quit, click: () => app.quit() },
  ]));
}

function createTray(): void {
  if (tray) return;
  const size = process.platform === 'darwin' ? 18 : 20;
  // Keep the real app artwork on every platform; a macOS template image would replace its colours with a silhouette.
  const appIcon = nativeImage.createFromPath(APP_ICON).resize({ width: size, height: size });
  tray = new Tray(appIcon);
  // macOS opens an assigned context menu itself; Windows and Linux get the same useful list on a normal click.
  if (process.platform !== 'darwin') tray.on('click', () => tray?.popUpContextMenu());
  updateTray();
}

/**
 * The splash: a small frameless window with the mark, shown the moment the app starts and closed once the main window has
 * painted, so the seconds the backend and pi need to come up are not a blank desktop. `setStatus` names the step.
 */
function createSplash(): BrowserWindow {
  const splash = new BrowserWindow({
    width: 380,
    height: 240,
    frame: false,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    backgroundColor: '#141414',
    title: 'pi-kit',
    icon: APP_ICON,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  splash.setMenuBarVisibility(false);
  splash.once('ready-to-show', () => {
    splash.show();
    splashState.shown = true;
  });
  void splash.loadFile(join(__dirname, 'splash.html')).then(() => {
    splashState.loaded = true;
  }).catch((error: Error) => mainLog?.line(`splash could not load: ${error.message}`));
  return splash;
}

function setSplashStatus(splash: BrowserWindow | undefined, text: string): void {
  if (!splash || splash.isDestroyed()) return;
  void splash.webContents.executeJavaScript(`window.setStatus(${JSON.stringify(text)})`).catch(() => undefined);
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 375,
    minHeight: 480,
    title: 'pi-kit',
    show: false,
    backgroundColor: '#141414',
    icon: APP_ICON,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // A link that wants a new window (an OAuth sign-in page, an MCP server's login) opens in the user's browser, never in the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!isRendererUrl(url)) event.preventDefault();
  });
  return win;
}

/** The folder pi works in until the user opens another: where the app was launched from, unless that is nowhere useful (Finder starts apps in `/`). */
function defaultCwd(): string {
  const fromEnv = process.env['PI_KIT_CWD'];
  if (fromEnv) return fromEnv;
  const cwd = process.cwd();
  return cwd === '/' || cwd.includes('.app/Contents') ? app.getPath('home') : cwd;
}

function broadcast(status: WatchdogStatus): void {
  latestStatus = status;
  mainLog?.line(`backend ${status.state}${status.reason ? `: ${status.reason}` : ''}${status.delayMs ? `, next attempt in ${status.delayMs} ms` : ''} (restarts: ${status.restarts})`);
  for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.send('pi-kit:backend-status', status);
  if (status.state === 'failed') void offerRetry(status);
}

/** The backend crashed too often in a row: the renderer says so in a toast, and the user decides here. */
async function offerRetry(status: WatchdogStatus): Promise<void> {
  const { response } = await dialog.showMessageBox({
    type: 'error',
    title: 'pi-kit',
    message: 'The pi-kit backend keeps stopping.',
    detail: `${status.reason ?? ''}\n\nThe log is in ${app.getPath('logs')}.`,
    buttons: ['Try again', 'Quit'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response === 0) watchdog?.retry();
  else app.quit();
}

/** Spawns the backend on the fixed endpoint, wires its IPC and output, and waits for the health check. */
function launch(path: string | undefined) {
  return launchForWatchdog(() => {
    const running = spawnBackend(endpoint as BackendEndpoint, {
      entry: BACKEND_ENTRY,
      origin: RENDERER_ORIGIN,
      dataDir: app.getPath('userData'),
      cwd: defaultCwd(),
      version: app.getVersion(),
      // PI_KIT_LOG_DIR: where the backend writes the update job's log, next to main.log and backend.log.
      env: { ...(path ? { PATH: path } : {}), PI_KIT_LOG_DIR: app.getPath('logs') },
      onOutput: (chunk, stream) => {
        backendLog?.write(chunk.toString());
        (stream === 'stderr' ? process.stderr : process.stdout).write(chunk);
      },
    });
    backend = running;
    mainLog?.line(`backend started, pid ${running.child.pid}, ${running.url}`);
    // "Open in editor": the backend validated the path, the OS opens it with the default application (shell.openPath).
    running.child.on('message', (message: { type?: string; id?: string; path?: string; action?: AppUpdateAction; threadId?: string; request?: unknown }) => {
      if (message?.type === 'browser-cancel' && typeof message.id === 'string') {
        browserRequests.get(message.id)?.abort();
        return;
      }
      if (message?.type === 'browser' && typeof message.id === 'string' && typeof message.threadId === 'string') {
        const id = message.id;
        const threadId = message.threadId;
        const controller = new AbortController();
        browserRequests.set(id, controller);
        const reply = (body: Record<string, unknown>): void => {
          if (running.child.connected) running.child.send({ type: 'desktop-answer', id, ...body });
        };
        const action = message.request === undefined ? undefined : BrowserActionSchema.safeParse(message.request);
        const result = !action ? Promise.resolve({ state: browserArtifacts.state(threadId) }) : action.success
          ? browserArtifacts.run(threadId, action.data, controller.signal)
          : Promise.reject(new BrowserOperationError('invalid', 'Invalid browser action.'));
        void result.then((value) => reply({ result: value }), (error: unknown) => reply({ error: error instanceof Error ? error.message : 'The browser action failed.', errorCode: error instanceof BrowserOperationError ? error.code : 'failed' })).finally(() => browserRequests.delete(id));
        return;
      }
      // pi-kit's own update: the backend decides when, this process does it with electron-updater.
      if (message?.type === 'app-update' && typeof message.id === 'string') {
        const id = message.id;
        const reply = (body: Record<string, unknown>): void => {
          if (running.child.connected) running.child.send({ type: 'desktop-answer', id, ...body });
        };
        appUpdater ??= new AppUpdater((event) => {
          mainLog?.line(`app update: ${JSON.stringify(event)}`);
          if (backend?.child.connected) backend.child.send({ type: 'app-update-event', event });
        });
        void appUpdater.run(message.action ?? 'check').then(
          (result) => reply({ result }),
          (error: Error) => reply({ error: error.message }),
        );
        return;
      }
      if (typeof message?.id !== 'string' || typeof message.path !== 'string') return;
      const id = message.id;
      const answer = (error?: string): void => {
        if (running.child.connected) running.child.send({ type: 'desktop-answer', id, ...(error ? { error } : {}) });
      };
      if (message.type === 'open-path') void shell.openPath(message.path).then((error) => answer(error || undefined));
      // "Reveal in Finder / Explorer" (the Files panel's context menu): the backend validated the path as for open-path.
      else if (message.type === 'reveal-path') {
        shell.showItemInFolder(message.path);
        answer();
      }
    });
    return running;
  }, HEALTH_TIMEOUT_MS);
}

async function boot(): Promise<void> {
  const logs = app.getPath('logs');
  mainLog = new FileLog(logs, 'main.log');
  backendLog = new FileLog(logs, 'backend.log');
  mainLog.line(`pi-kit ${app.getVersion()} starting (${app.isPackaged ? 'packaged' : 'development'}, electron ${process.versions.electron}, ${process.platform}-${process.arch})`);
  app.setAboutPanelOptions({
    applicationName: 'pi-kit',
    applicationVersion: app.getVersion(),
    version: `Electron ${process.versions.electron}`,
    credits: `Built by ${PUBLISHER}.\nA desktop UI for the pi coding agent.`,
    copyright: `© ${new Date().getFullYear()} ${PUBLISHER}`,
    iconPath: APP_ICON,
  });
  if (process.platform === 'darwin' && !app.isPackaged) app.dock?.setIcon(APP_ICON);
  const splash = createSplash();
  setSplashStatus(splash, 'Starting the backend…');

  // A Dock-launched macOS app has launchd's PATH; pi's tools want the user's.
  const path = app.isPackaged ? loginShellPath() : undefined;
  endpoint = await allocateEndpoint();
  if (!DEV_URL) serveRenderer(RENDERER_ROOT, endpoint.url);
  const storageReady = !DEV_URL ? (async () => {
    uiStorage = new UiStorage(join(app.getPath('userData'), 'ui-storage.json'));
    await uiStorage.load(async () => {
      const worker = new BrowserWindow({ show: false, width: 1, height: 1, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
      try {
        await worker.loadURL(`${APP_ORIGIN}/__ui-storage`);
        return await worker.webContents.executeJavaScript('Object.fromEntries(Object.entries(localStorage))');
      } finally { worker.destroy(); }
    });
  })().catch((error: Error) => mainLog?.line(`UI preference cache could not load: ${error.message}`)) : Promise.resolve();
  // The first start fails fast with a dialog; only a backend that was up is restarted by the watchdog.
  let adopted: Awaited<ReturnType<typeof launch>> | undefined = await launch(path);
  mainLog.line(`backend healthy at ${endpoint.url} (bootId ${adopted.health.bootId})`);
  setSplashStatus(splash, 'pi is ready. Opening…');
  const { url, token } = endpoint;
  watchdog = new BackendWatchdog(
    {
      launch: async () => {
        if (adopted) {
          const handle = adopted;
          adopted = undefined;
          return handle;
        }
        return launch(path);
      },
      ping: async () => !!(await pingHealth(endpoint as BackendEndpoint)),
      schedule: (fn, ms) => {
        const timer = setTimeout(fn, ms);
        return () => clearTimeout(timer);
      },
      now: () => Date.now(),
      report: broadcast,
    },
    DEFAULT_WATCHDOG_OPTIONS,
  );
  watchdog.start();

  createTray();
  ipcMain.handle('pi-kit:backend-url', (event) => (fromRenderer(event) ? url : Promise.reject(new Error('forbidden'))));
  ipcMain.handle('pi-kit:token', (event) => (fromRenderer(event) ? token : Promise.reject(new Error('forbidden'))));
  // The watchdog's state, for a window that opened after the last change.
  ipcMain.handle('pi-kit:backend-status-get', (event) => (fromRenderer(event) ? latestStatus : Promise.reject(new Error('forbidden'))));
  ipcMain.handle('pi-kit:tray-threads', (event, input: unknown, copy: unknown) => {
    if (!fromRenderer(event)) throw new Error('forbidden');
    const labels = trayLabelsInput(copy);
    trayThreads = trayInput(input);
    trayLabels = labels;
    updateTray();
  });
  ipcMain.handle('pi-kit:browser-local-certificates', (event, enabled: unknown) => {
    if (!fromRenderer(event)) throw new Error('forbidden');
    if (typeof enabled !== 'boolean') throw new Error('Invalid browser certificate preference.');
    browserArtifacts.setAllowInvalidLocalCertificates(enabled);
  });
  ipcMain.handle('pi-kit:browser-viewport', (event, input: unknown) => {
    if (!fromRenderer(event)) throw new Error('forbidden');
    const window = BrowserWindow.fromWebContents(event.sender);
    if (window) browserArtifacts.layout(window, BrowserViewportSchema.parse(input));
  });
  // `/quit`: the renderer asks, the app quits like Cmd+Q would.
  ipcMain.handle('pi-kit:quit', (event) => (fromRenderer(event) ? app.quit() : Promise.reject(new Error('forbidden'))));
  // Settings › Computer use: macOS applies a new Screen Recording grant only to an app that starts again. Quits the usual way (the backend stops with it), then starts again.
  ipcMain.handle('pi-kit:relaunch', (event) => {
    if (!fromRenderer(event)) throw new Error('forbidden');
    app.relaunch();
    app.quit();
  });
  // The folder picker behind `piKit.showOpenDialog` (the sidebar's "Add project", Settings › Projects, the onboarding's Open a folder).
  ipcMain.handle('pi-kit:open-folder', async (event) => {
    if (!fromRenderer(event)) throw new Error('forbidden');
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const result = await (win ? dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] }) : dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] }));
    return result.canceled ? undefined : result.filePaths[0];
  });
  // The theme setting's "System" follows the OS through Chromium's prefers-color-scheme; light and dark pin it.
  ipcMain.handle('pi-kit:theme-source', (event, source: unknown) => {
    if (!fromRenderer(event)) throw new Error('forbidden');
    if (source === 'system' || source === 'light' || source === 'dark') nativeTheme.themeSource = source;
  });
  ipcMain.handle('pi-kit:system-theme', (event) => {
    if (!fromRenderer(event)) throw new Error('forbidden');
    return nativeTheme.shouldUseDarkColors ? 'pi-dark' : 'pi-light';
  });
  // Voice input: macOS asks the user for the microphone itself the first time; a refusal is explained and the right pane offered.
  ipcMain.handle('pi-kit:microphone-access', (event) => {
    if (!fromRenderer(event)) throw new Error('forbidden');
    return requestMicrophone(process.platform, systemPreferences, async () => {
      const { response } = await dialog.showMessageBox({
        type: 'info',
        title: 'pi-kit',
        message: 'pi-kit needs the microphone for voice input.',
        detail: 'Whistle runs on this Mac and the audio is not sent anywhere. Turn the microphone on for pi-kit in System Settings › Privacy & Security › Microphone.',
        buttons: ['Open System Settings', 'Not now'],
        defaultId: 0,
        cancelId: 1,
      });
      if (response === 0) void shell.openExternal(MICROPHONE_SETTINGS_URL);
    });
  });

  await storageReady;
  ipcMain.handle('pi-kit:ui-storage-get', (event) => {
    if (!fromRenderer(event)) throw new Error('forbidden');
    return uiStorage?.snapshot();
  });
  ipcMain.handle('pi-kit:ui-storage-set', (event, key: unknown, value: unknown) => {
    if (!fromRenderer(event)) throw new Error('forbidden');
    return uiStorage?.set(key, value);
  });
  const win = createWindow();
  win.once('closed', () => browserArtifacts.dispose());
  // The main window takes over from the splash only once it has painted; a load that fails still closes the splash.
  win.once('ready-to-show', () => {
    win.show();
    if (!splash.isDestroyed()) splash.close();
  });
  try {
    await win.loadURL(DEV_URL ?? `${APP_ORIGIN}/`);
  } finally {
    if (!win.isVisible()) win.show();
    if (!splash.isDestroyed()) splash.close();
  }
  mainLog.line(`window loaded ${win.webContents.getURL()}`);
  if (SMOKE) await reportSmoke(win, url, token);
}

/** Smoke mode only: waits for `<pk-root>` to draw, then writes smoke.json for scripts/release-smoke.mjs. */
async function reportSmoke(win: BrowserWindow, url: string, token: string): Promise<void> {
  let rootChildren = 0;
  for (let i = 0; i < 100 && rootChildren === 0; i++) {
    rootChildren = Number(await win.webContents.executeJavaScript("document.querySelector('pk-root')?.childElementCount ?? 0").catch(() => 0));
    if (rootChildren === 0) await new Promise((resolve) => setTimeout(resolve, 200));
  }
  // Check from Chromium too: a healthy Node-side probe cannot catch a broken
  // preload, CSP, CORS, or local-network permission in the actual renderer.
  const connection = await win.webContents.executeJavaScript(`(async () => {
    try {
      const url = await window.piKit.getBackendUrl();
      const token = await window.piKit.getToken();
      const response = await fetch(url + '/api/health', { headers: { Authorization: 'Bearer ' + token } });
      return { status: response.status };
    } catch (error) { return { status: 0, error: String(error) }; }
  })()`);
  writeSmokeReport(app.getPath('userData'), {
    url,
    token,
    pid: process.pid,
    backendPid: backend?.child.pid,
    version: app.getVersion(),
    electron: process.versions.electron,
    platform: process.platform,
    arch: process.arch,
    packaged: app.isPackaged,
    window: { url: win.webContents.getURL(), rootChildren, backendStatus: connection.status, backendError: connection.error },
    splash: splashState,
  });
  mainLog?.line(`smoke report written (pk-root children: ${rootChildren})`);
}

app.whenReady().then(boot).catch((err: Error) => {
    mainLog?.line(`could not start: ${err.message}`);
    dialog.showErrorBox('pi-kit could not start', `${err.message}\n\nThe log is in ${app.getPath('logs')}.`);
    app.quit();
  });

app.on('window-all-closed', () => app.quit());
let flushingUiStorage = false;
app.on('before-quit', (event) => {
  if (uiStorage && !flushingUiStorage) {
    event.preventDefault();
    flushingUiStorage = true;
    void uiStorage.flush().catch((error: Error) => mainLog?.line(`UI preferences could not save: ${error.message}`)).finally(() => app.quit());
    return;
  }
  tray?.destroy();
  tray = undefined;
  watchdog?.stop();
  backend?.stop();
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && watchdog) {
    const win = createWindow();
    win.once('ready-to-show', () => win.show());
    void win.loadURL(DEV_URL ?? `${APP_ORIGIN}/`);
  }
});
