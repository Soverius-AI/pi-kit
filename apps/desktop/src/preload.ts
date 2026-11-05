import { contextBridge, ipcRenderer } from 'electron';
import type { RemoteAccessSetupAction } from '@pi-kit/protocol';
import { asOmarchyTheme, omarchyThemeFromArguments } from './omarchy-theme-handoff';

/** The only surface the renderer gets from Electron. Keep it minimal. */
contextBridge.exposeInMainWorld('piKit', {
  setTrayThreads: (threads: unknown, labels: unknown): Promise<void> =>
    ipcRenderer.invoke('pi-kit:tray-threads', threads, labels),
  onTrayOpenThread: (callback: (threadId: string) => void): (() => void) => {
    const listener = (_event: unknown, threadId: unknown) => {
      if (typeof threadId === 'string') callback(threadId);
    };
    ipcRenderer.on('pi-kit:tray-open-thread', listener);
    return () => ipcRenderer.removeListener('pi-kit:tray-open-thread', listener);
  },
  setBrowserLocalCertificates: (enabled: boolean): Promise<void> =>
    ipcRenderer.invoke('pi-kit:browser-local-certificates', enabled),
  setBrowserViewport: (viewport: unknown): Promise<void> => ipcRenderer.invoke('pi-kit:browser-viewport', viewport),
  getRemoteAccessStatus: () => ipcRenderer.invoke('pi-kit:remote-access-status'),
  openRemoteAccessSetup: (action: RemoteAccessSetupAction): Promise<void> =>
    ipcRenderer.invoke('pi-kit:remote-access-setup', action),
  startRemoteAccess: (port?: number) => ipcRenderer.invoke('pi-kit:remote-access-start', port),
  stopRemoteAccess: () => ipcRenderer.invoke('pi-kit:remote-access-stop'),
  beginRemotePairing: () => ipcRenderer.invoke('pi-kit:remote-pair-begin'),
  approveRemotePairing: (id: string) => ipcRenderer.invoke('pi-kit:remote-pair-approve', id),
  rejectRemotePairing: (id: string) => ipcRenderer.invoke('pi-kit:remote-pair-reject', id),
  revokeRemoteDevice: (id: string) => ipcRenderer.invoke('pi-kit:remote-device-revoke', id),
  getBackendUrl: (): Promise<string> => ipcRenderer.invoke('pi-kit:backend-url'),
  getToken: (): Promise<string> => ipcRenderer.invoke('pi-kit:token'),
  getUiStorage: (): Promise<Record<string, string> | undefined> => ipcRenderer.invoke('pi-kit:ui-storage-get'),
  setUiStorage: (key: string, value: string): Promise<void> => ipcRenderer.invoke('pi-kit:ui-storage-set', key, value),
  /** The backend watchdog's state: it changes when the backend crashes, is restarted, or is given up on. */
  getBackendStatus: (): Promise<unknown> => ipcRenderer.invoke('pi-kit:backend-status-get'),
  onBackendStatus: (callback: (status: unknown) => void): (() => void) => {
    const listener = (_event: unknown, status: unknown) => callback(status);
    ipcRenderer.on('pi-kit:backend-status', listener);
    return () => ipcRenderer.removeListener('pi-kit:backend-status', listener);
  },
  quit: (): Promise<void> => ipcRenderer.invoke('pi-kit:quit'),
  getBackgroundService: (): Promise<unknown> => ipcRenderer.invoke('pi-kit:background-service-get'),
  setBackgroundService: (enabled: boolean): Promise<void> =>
    ipcRenderer.invoke('pi-kit:background-service-set', enabled),
  installCommand: (): Promise<unknown> => ipcRenderer.invoke('pi-kit:cli-install'),
  /** Quits and starts the app again (Settings › Computer use, after a new macOS permission). */
  relaunch: (): Promise<void> => ipcRenderer.invoke('pi-kit:relaunch'),
  /** The folder picker; `undefined` if cancelled. */
  showOpenDialog: (): Promise<string | undefined> => ipcRenderer.invoke('pi-kit:open-folder'),
  /** `system` follows the OS, `light` and `dark` pin the window's colour scheme. */
  setThemeSource: (source: 'system' | 'light' | 'dark'): Promise<void> =>
    ipcRenderer.invoke('pi-kit:theme-source', source),
  /** The theme the OS asks for right now. */
  systemTheme: (): Promise<'pi-dark' | 'pi-light'> => ipcRenderer.invoke('pi-kit:system-theme'),
  /** Omarchy desktops only: the desktop's theme as this window was created with it, there before the first paint. */
  omarchyTheme: omarchyThemeFromArguments(process.argv),
  /** The Omarchy theme now; `undefined` on any other desktop. */
  getOmarchyTheme: async (): Promise<unknown> => asOmarchyTheme(await ipcRenderer.invoke('pi-kit:omarchy-theme')),
  /** Called when the user switches the Omarchy theme. */
  onOmarchyTheme: (callback: (theme: unknown) => void): (() => void) => {
    const listener = (_event: unknown, theme: unknown) => callback(asOmarchyTheme(theme));
    ipcRenderer.on('pi-kit:omarchy-theme-changed', listener);
    return () => ipcRenderer.removeListener('pi-kit:omarchy-theme-changed', listener);
  },
  /** Voice input: on macOS the system's microphone prompt the first time; `granted: false` carries what to do. */
  requestMicrophone: (): Promise<{ granted: boolean; status: string; message?: string }> =>
    ipcRenderer.invoke('pi-kit:microphone-access'),
});
