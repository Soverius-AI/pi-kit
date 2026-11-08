import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  type IpcMainInvokeEvent,
  Menu,
  type MenuItemConstructorOptions,
  nativeImage,
  nativeTheme,
  safeStorage,
  session,
  shell,
  systemPreferences,
  Tray,
} from 'electron';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { APP_ORIGIN, registerAppScheme, serveRenderer } from './app-protocol';
import { AppUpdater, type AppUpdateAction } from './app-updater';
import {
  backgroundStatus,
  type BackendEndpoint,
  cliInstallDir,
  cliLauncher,
  cliLauncherName,
  otherCommand,
  type DesktopAnswer,
  detachedAnswer,
  FileLog,
  HostClient,
  HostStartError,
  HOST_ALREADY_RUNNING,
  isAlive,
  isNewerVersion,
  liveDiscovery,
  otherInstall,
  ownAppImage,
  loginShellPath,
  type ServiceManager,
  spawnServiceHost,
  type SpawnedHost,
  SUPERVISOR_FLAG,
  serviceHandover,
  superviseServiceHost,
  temporaryLocation,
  type WatchdogStatus,
} from '@pi-kit/service-host';
import { backgroundService } from './background-service';
import { removeDatabases } from './database-reset';
import { configureLoopbackConnections } from './loopback-network';
import { BrowserArtifacts } from './browser';
import { BrowserActionSchema, BrowserOperationError, BrowserViewportSchema } from '@pi-kit/protocol';
import { MICROPHONE_SETTINGS_URL, requestMicrophone } from './microphone';
import { omarchyCurrentDir, type OmarchyTheme, OmarchyThemeWatcher } from './omarchy-theme';
import { omarchyThemeArgument, startingOmarchyTheme } from './omarchy-theme-handoff';
import { SMOKE, smokeDataDir, writeSmokeReport } from './smoke';
import { UiStorage } from './ui-storage';
import { RemoteAccessIpc } from './remote-access-ipc';
import { RemoteAccessSetup } from './remote-access-setup';
import { SafeStorageEncryption } from './instance-key-encryption';

/** Set by `pnpm run dev` to the Angular dev server. Unset in production: the static build is served. */
const DEV_URL = process.env['PI_KIT_DEV_URL'];
const RENDERER_ORIGIN = DEV_URL ? new URL(DEV_URL).origin : APP_ORIGIN;
// Development: dist/apps/desktop/{main,service-host}.cjs -> dist/apps/{backend,renderer/browser}.
// Packaged: Resources/app.asar/desktop/main.cjs holds the shell; the server is real files beside it, Resources/backend (the backend
// and the service host that runs it) and Resources/renderer/browser, laid out as the npm package lays them out.
const BACKEND_ENTRY = app.isPackaged
  ? join(process.resourcesPath, 'backend', 'main.js')
  : join(__dirname, '..', 'backend', 'main.js');
const HOST_ENTRY = app.isPackaged
  ? join(process.resourcesPath, 'backend', 'service-host.cjs')
  : join(__dirname, 'service-host.cjs');
const RENDERER_ROOT = app.isPackaged
  ? join(process.resourcesPath, 'renderer', 'browser')
  : join(__dirname, '..', 'renderer', 'browser');
/** The `pi-kit` command's bundle: beside the backend when packaged, the cli project's output in a checkout. */
const CLI_ENTRY = app.isPackaged
  ? join(process.resourcesPath, 'backend', 'pi-kit.cjs')
  : join(__dirname, '..', 'cli', 'pi-kit.cjs');

/** The service host that runs the backend, its watchdog and phone access (ADR-0036). */
let host: HostClient | undefined;
/** The host this app started, when it did; it ends with the app (`hostOwned`), a service's host does not. */
let hostProcess: SpawnedHost | undefined;
let hostOwned = false;
let background: ServiceManager | undefined;
/** The backend is moving into or out of the background service; the app restarts next. */
let switching = false;
/** Started by the Windows sign-in entry: supervise the host, no window. */
const SUPERVISOR = process.argv.includes(SUPERVISOR_FLAG);
let backendReady = false;
let endpoint: BackendEndpoint | undefined;
let latestStatus: WatchdogStatus = { state: 'starting', restarts: 0 };
let mainLog: FileLog | undefined;
let appUpdater: AppUpdater | undefined;
let tray: Tray | undefined;
let uiStorage: UiStorage | undefined;
/** Set on an Omarchy desktop only: its theme, followed while the app runs. */
let omarchy: OmarchyThemeWatcher | undefined;
interface TrayThread {
  id: string;
  title: string;
  project: string;
  state: 'running' | 'waiting';
}
let trayThreads: TrayThread[] = [];
let trayLabels: ReturnType<typeof trayLabelsInput> | undefined;
const browserArtifacts = new BrowserArtifacts(() => [RENDERER_ORIGIN, ...(endpoint ? [endpoint.url] : [])]);
const browserRequests = new Map<string, AbortController>();
const splashState = { loaded: false, shown: false };

// Fixes the userData folder (and with it the database) to .../pi-kit however Electron is launched.
app.setName('pi-kit');
configureLoopbackConnections(app.commandLine);

// Smoke mode (scripts/release-smoke.mjs): data and logs in the scratch folder the script names, a SIGTERM quits like Cmd+Q.
const SMOKE_DIR = smokeDataDir();
if (SMOKE_DIR) {
  app.setPath('userData', SMOKE_DIR);
  app.setPath('logs', join(SMOKE_DIR, 'logs'));
}
// A development launch (`pnpm dev`, `nx start desktop`) is not the signed app: Touch ID and its keychain group are out of reach, and the
// installed app's database is keyed to them. So a development build keeps a profile of its own (`PI_KIT_DATA_DIR`, else `.pi-kit-data-desktop`
// in the working directory), and never opens the installed app's data. Like production, a fresh profile does not enable Keychain.
const DEV_DIR =
  !app.isPackaged && !SMOKE_DIR
    ? process.env['PI_KIT_DATA_DIR'] || join(process.cwd(), '.pi-kit-data-desktop')
    : undefined;
if (DEV_DIR) app.setPath('userData', DEV_DIR);
if (SMOKE) process.on('SIGTERM', () => app.quit());
// One app per profile: another launch, or `pi-kit open`, brings this one forward. The Windows supervisor is not the app.
const SECOND_INSTANCE = !SUPERVISOR && !app.requestSingleInstanceLock();
if (SECOND_INSTANCE) app.quit();
app.on('second-instance', () => reopenWindow());

registerAppScheme();

/** Only our own renderer may ask for the backend address and token. */
function isRendererUrl(url: string | undefined): boolean {
  // URL.origin is "null" for the custom app:// scheme, so compare the prefix.
  return (
    !!url && url !== `${APP_ORIGIN}/__ui-storage` && (url === RENDERER_ORIGIN || url.startsWith(`${RENDERER_ORIGIN}/`))
  );
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
    if (
      typeof row['id'] !== 'string' ||
      typeof row['title'] !== 'string' ||
      typeof row['project'] !== 'string' ||
      (row['state'] !== 'running' && row['state'] !== 'waiting')
    )
      return [];
    return [
      {
        id: row['id'].slice(0, 200),
        title: row['title'].slice(0, 200),
        project: row['project'].slice(0, 200),
        state: row['state'],
      },
    ];
  });
}

/** Only translated text crosses this boundary; native menu actions stay owned by the main process. */
function trayLabelsInput(copy: unknown) {
  const keys = [
    'needsYou',
    'runningThreads',
    'noActiveThreads',
    'showApp',
    'quit',
    'quitAndStop',
    'tooltip',
    'waitingMore',
    'runningMore',
  ] as const;
  if (
    !copy ||
    typeof copy !== 'object' ||
    !keys.every((key) => typeof (copy as Record<string, unknown>)[key] === 'string')
  )
    throw new Error('Invalid tray labels.');
  return Object.fromEntries(keys.map((key) => [key, (copy as Record<string, string>)[key].slice(0, 500)])) as Record<
    (typeof keys)[number],
    string
  >;
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
  tray.setContextMenu(
    Menu.buildFromTemplate([
      ...entries(labels.needsYou, waiting, labels.waitingMore),
      ...entries(labels.runningThreads, running, labels.runningMore),
      ...(active === 0 ? [{ label: labels.noActiveThreads, enabled: false }, { type: 'separator' as const }] : []),
      { label: labels.showApp, click: () => showRenderer() },
      { label: labels.quit, click: () => app.quit() },
      // With the background service, Quit leaves the backend running; this one stops it until the next sign-in.
      ...(hostOwned || !host
        ? []
        : [{ label: labels.quitAndStop, click: () => void stopHost().finally(() => app.quit()) }]),
    ]),
  );
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
 * The Omarchy theme a window opens in: none once the user has chosen an explicit theme. The splash opens before the preferences
 * are read and takes the desktop's colours.
 */
function startingTheme(): OmarchyTheme | undefined {
  return startingOmarchyTheme(omarchy?.value, uiStorage?.snapshot()['pi-kit.theme']);
}

/** What a window shows before its page has painted: the window colour of the theme in effect. */
function windowBackground(): string {
  return startingTheme()?.tokens['--color-base-200'] ?? '#141414';
}

/** The splash in the Omarchy theme's colours; without one it keeps its own. */
function splashColors(): Record<string, string> {
  const tokens = startingTheme()?.tokens;
  if (!tokens) return {};
  return {
    bg: tokens['--color-base-200'],
    glow: tokens['--color-base-100'],
    edge: tokens['--pk-sunken'],
    fg: tokens['--color-base-content'],
    dim: tokens['--pk-muted'],
    track: tokens['--color-base-300'],
  };
}

/** Starts following the Omarchy theme; a no-op on any other desktop. */
function followOmarchyTheme(): void {
  const current = omarchyCurrentDir();
  if (!current) return;
  omarchy = new OmarchyThemeWatcher(current, (theme: OmarchyTheme | undefined) => {
    mainLog?.line(`Omarchy theme: ${theme ? `${theme.name} (${theme.mode})` : 'none with colours'}`);
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      win.setBackgroundColor(windowBackground());
      win.webContents.send('pi-kit:omarchy-theme-changed', theme);
    }
  });
  omarchy.start();
  mainLog?.line(
    `Omarchy theme: ${omarchy.value ? `${omarchy.value.name} (${omarchy.value.mode})` : 'none with colours'}`,
  );
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
    backgroundColor: windowBackground(),
    title: 'pi-kit',
    icon: APP_ICON,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  splash.setMenuBarVisibility(false);
  splash.once('ready-to-show', () => {
    splash.show();
    splashState.shown = true;
  });
  void splash
    .loadFile(join(__dirname, 'splash.html'), {
      query: { version: app.isPackaged ? `Version ${app.getVersion()}` : 'Development build', ...splashColors() },
    })
    .then(() => {
      splashState.loaded = true;
    })
    .catch((error: Error) => mainLog?.line(`splash could not load: ${error.message}`));
  return splash;
}

function setSplashStatus(splash: BrowserWindow | undefined, text: string): void {
  if (!splash || splash.isDestroyed()) return;
  void splash.webContents.executeJavaScript(`window.setStatus(${JSON.stringify(text)})`).catch(() => undefined);
}

function createWindow(): BrowserWindow {
  const theme = startingTheme();
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 375,
    minHeight: 480,
    title: 'pi-kit',
    show: false,
    backgroundColor: windowBackground(),
    icon: APP_ICON,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // The preload hands this to the page before its first paint, so the window never opens in other colours.
      additionalArguments: theme ? [omarchyThemeArgument(theme)] : [],
    },
  });
  // A link that wants a new window (an OAuth sign-in page, an MCP server's login) opens in the user's browser, never in the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(url))
      void shell.openExternal(url);
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
  mainLog?.line(
    `backend ${status.state}${status.reason ? `: ${status.reason}` : ''}${status.delayMs ? `, next attempt in ${status.delayMs} ms` : ''} (restarts: ${status.restarts})`,
  );
  for (const win of BrowserWindow.getAllWindows())
    if (!win.isDestroyed()) win.webContents.send('pi-kit:backend-status', status);
  if (status.state === 'failed') void offerRetry(status);
}

/**
 * Starts the app again. An AppImage's files live in a mount that goes away with this process, and Electron's relaunch helper
 * runs from there too: a shell outside the mount waits for this process to end (it holds the single-instance lock) and then
 * starts the image itself. The shell first closes what it inherited, which would otherwise keep the old mount busy and its
 * sockets bound in every process of the new app; bash, which the image's AppRun needs anyway, since dash names no
 * descriptor above 9.
 */
function relaunch(): void {
  const image = ownAppImage(__dirname);
  if (image) {
    const script = [
      'for fd in /proc/$$/fd/*; do fd=${fd##*/}; ((fd > 2)) && exec {fd}>&-; done 2>/dev/null',
      'while kill -0 "$0" 2>/dev/null; do sleep 0.2; done',
      'exec "$@"',
    ].join('\n');
    spawn('bash', ['-c', script, String(process.pid), image, ...process.argv.slice(1)], {
      detached: true,
      stdio: 'ignore',
    }).unref();
  } else app.relaunch();
  app.quit();
}

/** The backend crashed too often in a row: the renderer says so in a toast, and the user decides here. */
async function offerRetry(status: WatchdogStatus): Promise<void> {
  const { response } = await dialog.showMessageBox({
    type: 'error',
    title: 'pi-kit',
    message: host?.connected ? 'The pi-kit backend keeps stopping.' : 'The pi-kit backend stopped.',
    detail: `${status.reason ?? ''}\n\nThe log is in ${app.getPath('logs')}.`,
    buttons: ['Try again', 'Quit'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response === 0 && host?.connected) host.retry();
  // The host itself is gone: a fresh start of the app finds or starts the next one.
  else if (response === 0) {
    relaunch();
  } else app.quit();
}

/** Answers the backend's requests for what only Electron can do, relayed by the host; `undefined` answers nothing. */
async function answerBackend(value: unknown): Promise<DesktopAnswer> {
  const message = (value ?? {}) as {
    type?: string;
    id?: string;
    path?: string;
    action?: AppUpdateAction;
    threadId?: string;
    request?: unknown;
  };
  if (message.type === 'browser-cancel' && typeof message.id === 'string') {
    browserRequests.get(message.id)?.abort();
    return undefined;
  }
  if (message.type === 'browser' && typeof message.id === 'string' && typeof message.threadId === 'string') {
    const id = message.id;
    const threadId = message.threadId;
    const controller = new AbortController();
    browserRequests.set(id, controller);
    const action = message.request === undefined ? undefined : BrowserActionSchema.safeParse(message.request);
    try {
      if (action && !action.success) throw new BrowserOperationError('invalid', 'Invalid browser action.');
      return {
        result: action
          ? await browserArtifacts.run(threadId, action.data, controller.signal)
          : { state: browserArtifacts.state(threadId) },
      };
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : 'The browser action failed.',
        errorCode: error instanceof BrowserOperationError ? error.code : 'failed',
      };
    } finally {
      browserRequests.delete(id);
    }
  }
  // pi-kit's own update: the backend decides when, this process does it with electron-updater.
  if (message.type === 'app-update') {
    const updater = appUpdates();
    // Windows' installer cannot replace a pi-kit.exe that still runs, and the host and backend are pi-kit.exe too.
    if (message.action === 'install' && process.platform === 'win32' && updater.pending) {
      switching = true;
      await stopHost();
    }
    return updater.run(message.action ?? 'check').then(
      (result) => ({ result }),
      (error: Error) => ({ error: error.message }),
    );
  }
  // "Open in editor": the backend validated the path, the OS opens it with the default application (shell.openPath).
  if (message.type === 'open-path' && typeof message.path === 'string') {
    const error = await shell.openPath(message.path);
    return error ? { error } : {};
  }
  // "Reveal in Finder / Explorer" (the Files panel's context menu): the backend validated the path as for open-path.
  if (message.type === 'reveal-path' && typeof message.path === 'string') {
    shell.showItemInFolder(message.path);
    return {};
  }
  // A request this app does not know comes from a newer server: answer as a host without a desktop does, so it never waits.
  return detachedAnswer(value);
}

/** The one updater: electron-updater's events go to the log and to the backend's update job. */
function appUpdates(): AppUpdater {
  return (appUpdater ??= new AppUpdater((event) => {
    mainLog?.line(`app update: ${JSON.stringify(event)}`);
    host?.appUpdateEvent(event);
  }));
}

/** Quit was chosen in a startup dialog. */
class StartupCancelled extends Error {}

/** The first start; a broken database can be recreated and the backend started again. */
async function firstLaunch(host: HostClient, splash: BrowserWindow): Promise<{ bootId?: string }> {
  for (;;) {
    try {
      return await host.start();
    } catch (error) {
      const failure = error instanceof HostStartError ? error.failure : undefined;
      if (failure?.reason === 'database-version') {
        await dialog.showMessageBox({
          type: 'error',
          title: 'pi-kit',
          message: 'This profile needs a compatible pi-kit version.',
          detail: failure.message,
          buttons: ['Quit'],
          defaultId: 0,
          cancelId: 0,
        });
        throw new StartupCancelled();
      }
      if (failure?.reason !== 'database-broken') throw error;
      if (!(await offerDatabaseReset(failure.message))) throw new StartupCancelled();
      const removed = removeDatabases(app.getPath('userData'));
      mainLog?.line(`database recreated on request: removed ${removed.join(', ') || 'nothing'}`);
      setSplashStatus(splash, 'Creating a new database…');
    }
  }
}

async function offerDatabaseReset(reason: string): Promise<boolean> {
  const { response } = await dialog.showMessageBox({
    type: 'error',
    title: 'pi-kit',
    message: 'The pi-kit database is broken.',
    detail: `${reason}\n\nRecreate deletes pi-kit's databases and starts with new, empty ones. Your pi sessions are kept and the threads are rebuilt from them; what pi-kit kept only in its database (feedback, reviews, background agents) is lost.\n\nThe log is in ${app.getPath('logs')}.`,
    buttons: ['Recreate database', 'Quit'],
    defaultId: 0,
    cancelId: 1,
  });
  return response === 0;
}

let loginPath: string | null | undefined;
/**
 * A Dock-launched macOS app and a service both start with a bare PATH; pi's tools want the user's, which the login shell
 * knows (asked once). A development build was started from a terminal that has it.
 */
function userPath(): string | undefined {
  loginPath ??= (app.isPackaged ? loginShellPath() : undefined) ?? process.env['PATH'] ?? null;
  return loginPath ?? undefined;
}

/** The environment of a host this process spawns: its own, or the Windows supervisor's. */
function hostEnvironment(): Record<string, string> {
  const path = userPath();
  return {
    ...(path ? { PATH: path } : {}),
    // Where the host writes service.log and backend.log, and the backend its update job's log, next to main.log.
    PI_KIT_LOG_DIR: app.getPath('logs'),
    PI_KIT_BACKEND_ENTRY: BACKEND_ENTRY,
    PI_KIT_ORIGIN: RENDERER_ORIGIN,
    PI_KIT_DATA_DIR: app.getPath('userData'),
    PI_KIT_CWD: defaultCwd(),
    PI_KIT_VERSION: app.getVersion(),
    // What the host serves to paired phones; it reads it from the asar like this process does.
    PI_KIT_RENDERER_ROOT: RENDERER_ROOT,
  };
}

function commandLauncher(): string {
  return cliLauncher(process.platform, {
    runtime: process.execPath,
    script: CLI_ENTRY,
    ...(process.env['APPIMAGE'] ? { appImage: process.env['APPIMAGE'] } : {}),
  });
}

/** Settings › General › Background: whether `pi-kit` is installed for a terminal, and whether that folder is on its PATH. */
function commandStatus(): {
  available: boolean;
  dir: string;
  path: string;
  installed: boolean;
  onPath: boolean;
  other?: string;
} {
  // PI_KIT_BIN_DIR: the folder `pi-kit-secret`'s "Install on PATH" also honours.
  const dir = process.env['PI_KIT_BIN_DIR'] || cliInstallDir(process.platform, process.env);
  const path = join(dir, cliLauncherName(process.platform));
  const available = existsSync(CLI_ENTRY) && !temporaryLocation(process.platform, process.execPath);
  const other = otherCommand(path);
  const installed = available && !other && existsSync(path) && readFileSync(path, 'utf8') === commandLauncher();
  const onPath = (userPath() ?? '').split(delimiter).includes(dir);
  return { available, dir, path, installed, onPath, ...(other ? { other } : {}) };
}

/**
 * Puts the backend's token on the app page's own requests in the network layer, so it never enters page JavaScript. Frames the
 * backend serves (the MCP app and GenUI sandboxes) send no app Origin and get none: the missing token is what keeps them out.
 */
function authorizeAppRequests({ url, token }: BackendEndpoint): void {
  session.defaultSession.webRequest.onBeforeSendHeaders({ urls: [`${url}/*`] }, (details, callback) => {
    const headers = details.requestHeaders;
    if ((headers['Origin'] ?? headers['origin']) === RENDERER_ORIGIN) headers['Authorization'] = `Bearer ${token}`;
    callback({ requestHeaders: headers });
  });
}

/** Stops whichever host owns the data folder and waits until it is gone. */
async function stopHost(): Promise<void> {
  const running = liveDiscovery(app.getPath('userData'));
  host?.stop();
  for (let i = 0; i < 300 && running && isAlive(running.pid); i++) await new Promise((r) => setTimeout(r, 100));
}

/**
 * Enters the host that owns the data folder. With the background service registered, that is the operating system's host,
 * started or moved onto this version when needed; otherwise this app starts one as its child and it ends with the app.
 */
async function openHost(status: (text: string) => void): Promise<HostClient> {
  const dataDir = app.getPath('userData');
  const env = hostEnvironment();
  background = backgroundService({
    app,
    dataDir,
    logDir: app.getPath('logs'),
    hostEntry: HOST_ENTRY,
    ...(env['PATH'] ? { path: env['PATH'] } : {}),
    devEnv: {
      PI_KIT_BACKEND_ENTRY: BACKEND_ENTRY,
      PI_KIT_ORIGIN: RENDERER_ORIGIN,
      PI_KIT_VERSION: app.getVersion(),
      PI_KIT_RENDERER_ROOT: RENDERER_ROOT,
    },
    stopHost,
  });
  // The profile's service may be registered by this app or by another install (a server install from npm or a tarball; on
  // Windows its scheduled task rather than this app's sign-in entry). The newest install runs it, and one of this version
  // keeps it (§5).
  const supported = !!background && !(await background.unsupported());
  const other = background ? otherInstall(background, ownAppImage(__dirname) ?? HOST_ENTRY) : undefined;
  if (background && supported && (background.installed() || other)) {
    mainLog?.line('background service registered: attaching to it');
    const peek = liveDiscovery(dataDir);
    const handover = serviceHandover(app.getVersion(), peek?.version, other);
    if (handover.action === 'update-first') {
      if (await becomeVersion(handover.version, status)) return new Promise<never>(() => undefined);
      if (!peek) await background.start();
    } else if (handover.action === 'attach') {
      mainLog?.line(`the service belongs to ${other?.entry}, this app's version: leaving it there`);
      if (!peek) await background.start();
    } else {
      // Keeps paths, version and PATH current; a changed registration restarts the service on it.
      await background.install();
      const running = liveDiscovery(dataDir);
      if (!running) await background.start();
      else if (running.version !== app.getVersion()) await background.restart();
    }
    const { client, discovery } = await HostClient.find(dataDir, {
      accept: (found) => found.version === app.getVersion() || isNewerVersion(found.version, app.getVersion()),
      timeoutMs: 60_000,
    });
    mainLog?.line(`attached to the ${discovery.level} host, pid ${discovery.pid}`);
    return client;
  }
  // macOS at boot: the LaunchDaemon is root's, so the app cannot take it over, only become the newer version it runs.
  if (other && !supported) {
    const handover = serviceHandover(app.getVersion(), liveDiscovery(dataDir)?.version, other);
    if (handover.action === 'update-first' && (await becomeVersion(handover.version, status)))
      return new Promise<never>(() => undefined);
  }
  const spawned = spawnServiceHost(HOST_ENTRY, { ...process.env, ...env });
  hostProcess = spawned;
  mainLog?.line(`service host started, pid ${spawned.pid}`);
  // Another host owns the folder (one left from a service just switched off): this app uses that one.
  let foreign = false;
  void spawned.exited.then((exit) => (foreign = exit.code === HOST_ALREADY_RUNNING));
  const { client, discovery } = await HostClient.find(dataDir, {
    accept: (found) => found.pid === spawned.pid || foreign,
    gone: spawned.exited.then((exit) => (exit.code === HOST_ALREADY_RUNNING ? new Promise(() => undefined) : exit)),
  });
  hostOwned = discovery.pid === spawned.pid;
  if (!hostOwned) mainLog?.line(`attached to the ${discovery.level} host, pid ${discovery.pid}`);
  return client;
}

/**
 * The service runs a newer install: the app becomes that version first, so the window has every native feature the newer
 * server expects. `false` when no such release exists; the app then attaches as it is.
 */
async function becomeVersion(version: string, status: (text: string) => void): Promise<boolean> {
  mainLog?.line(`the service runs ${version}, newer than this app`);
  status(`Updating pi-kit to ${version} to match the background service…`);
  if (
    await appUpdates()
      .updateTo(version)
      .catch(() => false)
  )
    return true;
  mainLog?.line(`no app release of ${version} or newer: attaching without moving the service`);
  return false;
}

/** Settings › General: moves the backend into the operating system's service or back into this app, through a restart of the app. */
async function switchBackground(enabled: unknown): Promise<void> {
  if (typeof enabled !== 'boolean') throw new Error('Invalid background service choice.');
  const status = await backgroundStatus(background);
  if (!status.supported || !background) throw new Error(status.reason ?? 'Unsupported.');
  if (status.enabled === enabled) return;
  switching = true;
  mainLog?.line(`background service: turning ${enabled ? 'on' : 'off'}`);
  try {
    // The next owner needs the data folder: this app's host, or the service's, goes first.
    await stopHost();
    if (enabled) await background.install();
    else await background.uninstall();
  } catch (error) {
    mainLog?.line(`background service could not switch: ${error instanceof Error ? error.message : String(error)}`);
  }
  relaunch();
}

/**
 * The host went away under the app. A service's host moves on purpose (`pi-kit service restart`, `pi-kit update`, a server
 * install taking the service over), so the app restarts onto the next host of the data folder. The host this app started
 * dying, or no next host within two minutes, is a failure.
 */
async function followHost(previousPid: number | undefined): Promise<void> {
  for (let i = 0; !hostOwned && !shutdownStarted && i < 1200; i++) {
    const next = liveDiscovery(app.getPath('userData'));
    if (next && next.pid !== previousPid) {
      mainLog?.line(`the service host is now pid ${next.pid}: restarting onto it`);
      relaunch();
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!shutdownStarted)
    broadcast({ state: 'failed', restarts: latestStatus.restarts, reason: 'the pi-kit service host stopped' });
}

/** The Windows sign-in entry: no window, only the host, started again after a crash with a growing pause. */
async function superviseHost(): Promise<void> {
  const log = new FileLog(app.getPath('logs'), 'supervisor.log');
  log.line(`pi-kit ${app.getVersion()} supervising the service host`);
  await superviseServiceHost(
    () => spawnServiceHost(HOST_ENTRY, { ...process.env, ...hostEnvironment(), PI_KIT_SERVICE_LEVEL: 'login' }),
    (line) => log.line(line),
  );
  app.quit();
}

async function boot(): Promise<void> {
  const logs = app.getPath('logs');
  mainLog = new FileLog(logs, 'main.log');
  mainLog.line(
    `pi-kit ${app.getVersion()} starting (${app.isPackaged ? 'packaged' : 'development'}, electron ${process.versions.electron}, ${process.platform}-${process.arch})`,
  );
  app.setAboutPanelOptions({
    applicationName: 'pi-kit',
    applicationVersion: app.getVersion(),
    version: `Electron ${process.versions.electron}`,
    credits: `Built by ${PUBLISHER}.\nA desktop UI for the pi coding agent.`,
    copyright: `© ${new Date().getFullYear()} ${PUBLISHER}`,
    iconPath: APP_ICON,
  });
  if (process.platform === 'darwin' && !app.isPackaged) app.dock?.setIcon(APP_ICON);
  followOmarchyTheme();
  const splash = createSplash();
  setSplashStatus(splash, 'Starting the backend…');

  const client = await openHost((text) => setSplashStatus(splash, text));
  host = client;
  const attachedPid = liveDiscovery(app.getPath('userData'))?.pid;
  client.onClose(() => {
    if (shutdownStarted || switching) return;
    mainLog?.line('the service host went away');
    void followHost(attachedPid);
  });
  client.onStatus(broadcast);
  client.serveBackendRequests(answerBackend);
  client.serveSealing(new SafeStorageEncryption(safeStorage));
  const attachment = await client.attach();
  endpoint = attachment.endpoint;
  if (!DEV_URL) serveRenderer(attachment.rendererRoot ?? RENDERER_ROOT, endpoint.url);
  authorizeAppRequests(endpoint);
  const storageReady = !DEV_URL
    ? (async () => {
        uiStorage = new UiStorage(join(app.getPath('userData'), 'ui-storage.json'));
        await uiStorage.load(async () => {
          const worker = new BrowserWindow({
            show: false,
            width: 1,
            height: 1,
            webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
          });
          try {
            await worker.loadURL(`${APP_ORIGIN}/__ui-storage`);
            return await worker.webContents.executeJavaScript('Object.fromEntries(Object.entries(localStorage))');
          } finally {
            worker.destroy();
          }
        });
      })().catch((error: Error) => mainLog?.line(`UI preference cache could not load: ${error.message}`))
    : Promise.resolve();
  // The first start fails fast with a dialog; only a backend that was up is restarted by the host's watchdog.
  const started = await firstLaunch(client, splash);
  backendReady = true;
  mainLog.line(`backend healthy at ${endpoint.url} (bootId ${started.bootId})`);
  setSplashStatus(splash, 'pi is ready. Opening…');
  const { url, token } = endpoint;

  createTray();
  ipcMain.handle('pi-kit:backend-url', (event) => (fromRenderer(event) ? url : Promise.reject(new Error('forbidden'))));
  // The watchdog's state, for a window that opened after the last change.
  ipcMain.handle('pi-kit:backend-status-get', (event) =>
    fromRenderer(event) ? latestStatus : Promise.reject(new Error('forbidden')),
  );
  // Explicit opt-in; publishes no backend routes or credentials. The gateway runs in the host, so phones keep working without a window.
  const setup = new RemoteAccessSetup(shell);
  new RemoteAccessIpc(
    client.remote,
    fromRenderer,
    () => shutdownStarted,
    async (action) => setup.open(action, await client.remote.setupUrl()),
  ).register(ipcMain);
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
  ipcMain.handle('pi-kit:background-service-get', async (event) => {
    if (!fromRenderer(event)) throw new Error('forbidden');
    return { ...(await backgroundStatus(background)), cli: commandStatus() };
  });
  ipcMain.handle('pi-kit:cli-install', (event) => {
    if (!fromRenderer(event)) throw new Error('forbidden');
    const status = commandStatus();
    if (!status.available) throw new Error('The pi-kit command is not part of this build.');
    if (status.other) throw new Error(`${status.path} is the pi-kit command of another install (${status.other}).`);
    mkdirSync(status.dir, { recursive: true });
    writeFileSync(status.path, commandLauncher(), { mode: 0o755 });
    chmodSync(status.path, 0o755);
    return commandStatus();
  });
  ipcMain.handle('pi-kit:background-service-set', (event, enabled: unknown) => {
    if (!fromRenderer(event) || shutdownStarted) throw new Error('forbidden');
    return switchBackground(enabled);
  });
  // Settings › Computer use: macOS applies a new Screen Recording grant only to an app that starts again.
  ipcMain.handle('pi-kit:relaunch', (event) => {
    if (!fromRenderer(event)) throw new Error('forbidden');
    relaunch();
  });
  // The folder picker behind `piKit.showOpenDialog` (the sidebar's "Add project", Settings › Projects, the onboarding's Open a folder).
  ipcMain.handle('pi-kit:open-folder', async (event) => {
    if (!fromRenderer(event)) throw new Error('forbidden');
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const result = await (win
      ? dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] })
      : dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] }));
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
  // On an Omarchy desktop "System" is the Omarchy theme; `undefined` anywhere else and for a theme without colours.
  ipcMain.handle('pi-kit:omarchy-theme', (event) => {
    if (!fromRenderer(event)) throw new Error('forbidden');
    return omarchy?.value;
  });
  // Voice input: macOS asks the user for the microphone itself the first time; a refusal is explained and the right pane offered.
  ipcMain.handle('pi-kit:microphone-access', (event) => {
    if (!fromRenderer(event)) throw new Error('forbidden');
    return requestMicrophone(process.platform, systemPreferences, async () => {
      const { response } = await dialog.showMessageBox({
        type: 'info',
        title: 'pi-kit',
        message: 'pi-kit needs the microphone for voice input.',
        detail:
          'Whistle runs on this Mac and the audio is not sent anywhere. Turn the microphone on for pi-kit in System Settings › Privacy & Security › Microphone.',
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
    rootChildren = Number(
      await win.webContents
        .executeJavaScript("document.querySelector('pk-root')?.childElementCount ?? 0")
        .catch(() => 0),
    );
    if (rootChildren === 0) await new Promise((resolve) => setTimeout(resolve, 200));
  }
  // Check from Chromium too: a healthy Node-side probe cannot catch a broken
  // preload, CSP, CORS, or local-network permission in the actual renderer.
  const connection = await win.webContents.executeJavaScript(`(async () => {
    try {
      const url = await window.piKit.getBackendUrl();
      const response = await fetch(url + '/api/instance');
      return { status: response.status };
    } catch (error) { return { status: 0, error: String(error) }; }
  })()`);
  writeSmokeReport(app.getPath('userData'), {
    url,
    token,
    pid: process.pid,
    hostPid: hostProcess?.pid,
    backendPid: host?.backendPid,
    version: app.getVersion(),
    electron: process.versions.electron,
    platform: process.platform,
    arch: process.arch,
    packaged: app.isPackaged,
    window: {
      url: win.webContents.getURL(),
      rootChildren,
      backendStatus: connection.status,
      backendError: connection.error,
    },
    splash: splashState,
  });
  mainLog?.line(`smoke report written (pk-root children: ${rootChildren})`);
}

app
  .whenReady()
  .then(() => (SECOND_INSTANCE ? undefined : SUPERVISOR ? superviseHost() : boot()))
  .catch((err: Error) => {
    if (err instanceof StartupCancelled) {
      mainLog?.line('could not start: the user quit');
      app.quit();
      return;
    }
    // The service's host went away while this app started (a restart or an update elsewhere): its close handler follows it.
    if (host && !host.connected && !hostOwned) {
      mainLog?.line(`could not start: ${err.message}; waiting for the service host to come back`);
      return;
    }
    mainLog?.line(`could not start: ${err.message}`);
    dialog.showErrorBox('pi-kit could not start', `${err.message}\n\nThe log is in ${app.getPath('logs')}.`);
    app.quit();
  });

app.on('window-all-closed', () => app.quit());
let shutdownStarted = false;
let shutdownComplete = false;
app.on('before-quit', (event) => {
  if (!shutdownComplete) {
    event.preventDefault();
    if (!shutdownStarted) {
      shutdownStarted = true;
      browserArtifacts.dispose();
      void Promise.allSettled([
        uiStorage?.flush().catch((error: Error) => mainLog?.line(`UI preferences could not save: ${error.message}`)),
        // A downloaded update installs as the app quits; on Windows only once no pi-kit.exe runs.
        ...(process.platform === 'win32' && appUpdater?.pending ? [stopHost()] : []),
      ]).finally(() => {
        shutdownComplete = true;
        app.quit();
      });
    }
    return;
  }
  tray?.destroy();
  tray = undefined;
  omarchy?.stop();
  // Our own host also stops on IPC disconnect; a background service's host keeps running.
  if (hostOwned) host?.stop();
});
/** Brings the app window forward, or opens it again once the backend is up. */
function reopenWindow(): void {
  if (rendererWindow()) return showRenderer();
  if (!backendReady) return;
  const win = createWindow();
  win.once('closed', () => browserArtifacts.dispose());
  win.once('ready-to-show', () => win.show());
  void win.loadURL(DEV_URL ?? `${APP_ORIGIN}/`);
}
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) reopenWindow();
});
