/** API exposed by apps/desktop/src/preload.ts through contextBridge. */
/** The backend watchdog's state (apps/desktop/src/watchdog.ts). */
export interface BackendStatus {
  state: 'starting' | 'running' | 'restarting' | 'failed' | 'stopped';
  restarts: number;
  attempt?: number;
  delayMs?: number;
  reason?: string;
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
  tooltip: string;
  waitingMore: string;
  runningMore: string;
}

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
  /** Quits and starts the app again: macOS applies a new Screen Recording grant only to a restarted app (Settings › Computer use); absent in a browser. */
  relaunch?(): Promise<void>;
  /** The native folder picker; `undefined` if cancelled. */
  showOpenDialog?(): Promise<string | undefined>;
  /** `system` follows the OS, `light` and `dark` pin the window's colour scheme. */
  setThemeSource?(source: 'system' | 'light' | 'dark'): Promise<void>;
  systemTheme?(): Promise<'pi-dark' | 'pi-light'>;
  /** Voice input: macOS asks the user for microphone access the first time; `granted: false` carries a sentence that says what to do. */
  requestMicrophone?(): Promise<MicrophoneAccess>;
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
