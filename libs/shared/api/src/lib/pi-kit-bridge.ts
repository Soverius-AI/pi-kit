// eslint-disable-next-line @nx/enforce-module-boundaries -- Type-only Electron IPC contract; protocol validators never enter the transport runtime.
import type { RemoteAccessSetupAction, RemoteAccessStatus } from '@pi-kit/protocol';

/** The backend watchdog's state (libs/shared/service-host/src/watchdog.ts, run by the service host). */
export interface BackendStatus {
  state: 'starting' | 'running' | 'restarting' | 'failed' | 'stopped';
  restarts: number;
  attempt?: number;
  delayMs?: number;
  reason?: string;
}

/** The `pi-kit` command for a terminal: whether this build has it, where it goes, and whether that folder is on PATH. */
export interface CommandStatus {
  available: boolean;
  dir: string;
  path: string;
  installed: boolean;
  onPath: boolean;
}

export interface BackgroundServiceStatus {
  supported: boolean;
  /** Why it cannot run on this computer, when it cannot. */
  reason?: string;
  enabled: boolean;
  cli?: CommandStatus;
}

export type TrayThreadState = 'running' | 'waiting';

/** One actionable thread shown in the desktop tray menu. */
export interface TrayThread {
  id: string;
  title: string;
  project: string;
  state: TrayThreadState;
}

/** App-owned native menu copy follows the renderer's selected language. */
export interface TrayLabels {
  needsYou: string;
  runningThreads: string;
  noActiveThreads: string;
  showApp: string;
  quit: string;
  quitAndStop: string;
  tooltip: string;
  waitingMore: string;
  runningMore: string;
}

/** API exposed by apps/desktop/src/preload.ts through contextBridge. */
export interface PiKitBridge {
  /** Replaces the actionable running/waiting thread list in the cross-platform system tray. */
  setTrayThreads?(threads: readonly TrayThread[], labels: TrayLabels): Promise<void>;
  /** The user chose a thread from the tray; returns the unsubscribe function. */
  onTrayOpenThread?(callback: (threadId: string) => void): () => void;
  /** Positions the isolated browser inside its artifact panel; never exposes browser commands or app credentials to a page. */
  setBrowserViewport?(viewport: {
    owner: string;
    threadId: string;
    bounds: { x: number; y: number; width: number; height: number } | null;
  }): Promise<void>;
  /** User opt-in for invalid certificates on literal loopback hosts, in artifact sessions only. Closes pages to clear cached trust. */
  setBrowserLocalCertificates?(enabled: boolean): Promise<void>;
  /** Read-only Tailscale discovery. Does not connect the VPN or publish anything. */
  getRemoteAccessStatus?(): Promise<RemoteAccessStatus>;
  /** Open only the app-owned Tailscale application/settings/validated approval page. */
  openRemoteAccessSetup?(action: RemoteAccessSetupAction): Promise<void>;
  /** Explicitly publish the authenticated phone gateway. */
  startRemoteAccess?(port?: number): Promise<RemoteAccessStatus>;
  /** Stop only pi-kit's phone gateway, leaving other Tailscale services intact. */
  stopRemoteAccess?(): Promise<RemoteAccessStatus>;
  beginRemotePairing?(): Promise<RemoteAccessStatus>;
  approveRemotePairing?(id: string): Promise<RemoteAccessStatus>;
  rejectRemotePairing?(id: string): Promise<RemoteAccessStatus>;
  revokeRemoteDevice?(id: string): Promise<RemoteAccessStatus>;
  getBackendUrl(): Promise<string>;
  getToken(): Promise<string>;
  /** Async native UI cache; undefined in development, where browser storage is used. */
  getUiStorage?(): Promise<Record<string, string> | undefined>;
  setUiStorage?(key: string, value: string): Promise<void>;
  getBackendStatus?(): Promise<BackendStatus>;
  /** Called on every change of the watchdog's state; returns the unsubscribe function. */
  onBackendStatus?(callback: (status: BackendStatus) => void): () => void;
  /** `/quit`: closes the app; absent in a browser. */
  quit?(): Promise<void>;
  /** Whether the backend keeps running after the app closes, as a service the operating system starts at sign-in. */
  getBackgroundService?(): Promise<BackgroundServiceStatus>;
  /** Moves the backend into the background service or back into the app; the app restarts to do it. */
  setBackgroundService?(enabled: boolean): Promise<void>;
  /** Writes the `pi-kit` launcher to a folder on PATH; only on a click. */
  installCommand?(): Promise<CommandStatus>;
  /** Quits and starts the app again: macOS applies a new Screen Recording grant only to a restarted app (Settings › Computer use); absent in a browser. */
  relaunch?(): Promise<void>;
  /** The native folder picker; `undefined` if cancelled. */
  showOpenDialog?(): Promise<string | undefined>;
  /** `system` follows the OS, `light` and `dark` pin the window's colour scheme. */
  setThemeSource?(source: 'system' | 'light' | 'dark'): Promise<void>;
  systemTheme?(): Promise<'pi-dark' | 'pi-light'>;
  /** Omarchy desktops only: the desktop's theme as it was when the window was created, known before the first paint. */
  omarchyTheme?: OmarchyTheme;
  /** The Omarchy theme now; `undefined` on any other desktop and for a theme without colours. */
  getOmarchyTheme?(): Promise<OmarchyTheme | undefined>;
  /** Called when the user switches the Omarchy theme; returns the unsubscribe function. */
  onOmarchyTheme?(callback: (theme: OmarchyTheme | undefined) => void): () => void;
  /** Voice input: macOS asks the user for microphone access the first time; `granted: false` carries a sentence that says what to do. */
  requestMicrophone?(): Promise<MicrophoneAccess>;
}

/** The Omarchy desktop's theme in pi-kit's tokens (apps/desktop/src/omarchy-theme.ts). */
export interface OmarchyTheme {
  /** The theme's slug, as `omarchy theme set` takes it. */
  name: string;
  mode: 'dark' | 'light';
  /** CSS custom properties for <html>; every value is a `#rrggbb` colour. */
  tokens: Record<string, string>;
}

export interface MicrophoneAccess {
  granted: boolean;
  /** macOS: `granted`, `denied`, `restricted`, `not-determined`; other systems answer `granted`. */
  status: string;
  message?: string;
}

declare global {
  interface Window {
    piKit?: PiKitBridge;
  }
}
