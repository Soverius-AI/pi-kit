import { emptyBrowserState } from '@pi-kit/protocol';
import type { BackendEndpoint } from './backend';
import type { WatchdogStatus } from './watchdog';

/** What the backend reports over IPC before it exits on a failed start. */
export interface StartupFailure {
  reason: string;
  message: string;
}

/** The answer to the desktop's `attach` call. */
export interface HostAttachment {
  endpoint: BackendEndpoint;
  status: WatchdogStatus;
  backendPid?: number;
  /** The web app of this host's install, which the desktop shows so that UI and backend are one version. */
  rendererRoot?: string;
}

/** The answer to `status`, for anyone with the token: never the backend's token. */
export interface HostStatus {
  status: WatchdogStatus;
  desktopAttached: boolean;
  backendUrl?: string;
  backendPid?: number;
}

/** The body of a `desktop-answer` to the backend; `undefined` sends nothing (a cancellation has no answer). */
export type DesktopAnswer = Record<string, unknown> | undefined;

type Fields = Record<string, unknown>;

export function fields(value: unknown): Fields | undefined {
  return value && typeof value === 'object' ? (value as Fields) : undefined;
}

export function asStartupFailure(value: unknown): StartupFailure | undefined {
  const failure = fields(value);
  const reason = failure?.['reason'];
  const message = failure?.['message'];
  return typeof reason === 'string' && typeof message === 'string' ? { reason, message } : undefined;
}

export const startupFailureOf = (value: unknown): StartupFailure | undefined =>
  fields(value)?.['type'] === 'startup-failure' ? asStartupFailure(value) : undefined;

/** What the backend hears when it asks for something only the desktop app can do and no desktop is attached. */
export function detachedAnswer(value: unknown): DesktopAnswer {
  const message = fields(value);
  switch (message?.['type']) {
    case 'browser':
      return message['request'] === undefined && typeof message['threadId'] === 'string'
        ? { result: { state: emptyBrowserState(message['threadId'], false) } }
        : { error: 'The browser needs the pi-kit desktop app.', errorCode: 'unavailable' };
    case 'open-path':
      return { error: 'Opening a file in your editor needs the pi-kit desktop app.' };
    case 'reveal-path':
      return { error: 'Revealing a file in the file manager needs the pi-kit desktop app.' };
    case 'app-update':
      return { result: { unavailable: 'pi-kit updates itself in the desktop app.' } };
    case 'browser-cancel':
      return undefined;
    default:
      return { error: 'This needs the pi-kit desktop app.', errorCode: 'unavailable' };
  }
}

export const isRemoteDeviceId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);

export const isRemotePort = (value: unknown): value is number | undefined =>
  value === undefined || (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535);
