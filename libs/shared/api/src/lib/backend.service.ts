import { Injectable, InjectionToken, inject, isDevMode } from '@angular/core';
import './pi-kit-bridge';

const URL_KEY = 'pi-kit.backendUrl';
const TOKEN_KEY = 'pi-kit.token';
export interface BackendConnection {
  /** Phone sessions use same-origin cookies and a CSRF nonce, never the private desktop token. */
  readonly mode?: 'phone';
  url(): Promise<string>;
  token(): Promise<string>;
  /** Revalidate an approved device after suspension without resending user operations. */
  resume?(): Promise<void>;
}

/** May also be constructed before Angular bootstrap, then provided unchanged. */
export const BACKEND_CONNECTION = new InjectionToken<BackendConnection>('BACKEND_CONNECTION', {
  providedIn: 'root',
  factory: () => createBackendConnection(),
});

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage can be blocked; the token is then fetched again on the next load.
  }
}

/** Present only in the production index served by the private device gateway. */
export function isDeviceConnection(): boolean {
  return (
    !window.piKit && document.querySelector('meta[name="pi-kit-connection"]')?.getAttribute('content') === 'device'
  );
}

/** Electron resolves through preload; paired phones use their own same-origin session. */
export function createBackendConnection(devWebUrl = 'http://127.0.0.1:4300'): BackendConnection {
  if (isDeviceConnection()) {
    let nonce: Promise<string> | undefined;
    let generation = 0;
    const readSession = (): Promise<string> => {
      const requestedGeneration = generation;
      nonce ??= fetch('/phone/session', {
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
      })
        .then(async (response) => {
          if (response.status === 401) {
            window.location.replace('/phone');
            throw new Error('Pair this phone again in the desktop app.');
          }
          if (!response.ok) throw new Error('Could not read the phone session.');
          const body: unknown = await response.json();
          const token = body && typeof body === 'object' ? (body as { token?: unknown }).token : undefined;
          if (typeof token !== 'string' || token.length < 16 || token.length > 256)
            throw new Error('Invalid phone session.');
          return token;
        })
        .catch((error: unknown) => {
          if (requestedGeneration === generation) nonce = undefined;
          throw error;
        });
      return nonce;
    };
    return {
      mode: 'phone',
      url: async () => window.location.origin,
      token: readSession,
      resume: async () => {
        generation++;
        nonce = undefined;
        await readSession();
      },
    };
  }
  return {
    async url(): Promise<string> {
      if (window.piKit) return window.piKit.getBackendUrl();
      return readStorage(URL_KEY) ?? devWebUrl;
    },

    async token(): Promise<string> {
      if (window.piKit) return window.piKit.getToken();
      const stored = readStorage(TOKEN_KEY);
      if (!isDevMode()) {
        if (stored) return stored;
        throw new Error('No backend token available.');
      }
      // Every `npm run dev:web` start has a new token, so ask the backend each page load and keep the
      // stored one only as a fallback while the endpoint is unreachable.
      try {
        const res = await fetch(`${await this.url()}/api/dev/token`);
        if (!res.ok) throw new Error(`Dev token endpoint answered ${res.status}.`);
        const { token } = (await res.json()) as { token: string };
        writeStorage(TOKEN_KEY, token);
        return token;
      } catch (error) {
        if (stored) return stored;
        throw error;
      }
    },
  };
}

/**
 * The backend's address and bearer token for the renderer, from `BACKEND_CONNECTION` (Electron's preload, or the dev
 * endpoint on the web), and `fetch` against the backend with that token set.
 */
@Injectable({ providedIn: 'root' })
export class BackendService implements BackendConnection {
  private readonly connection = inject(BACKEND_CONNECTION);

  url(): Promise<string> {
    return this.connection.url();
  }
  token(): Promise<string> {
    return this.connection.token();
  }

  /** `fetch` against the backend with the bearer token; drops a stale stored token on 401. */
  async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${await this.token()}`);
    const res = await fetch(`${await this.url()}${path}`, {
      ...init,
      ...(this.connection.mode === 'phone' ? { credentials: 'same-origin' as const, redirect: 'error' as const } : {}),
      headers,
    });
    if (res.status === 401 && this.connection.mode === 'phone') {
      // A target's 401 is not proof that entry-device approval was lost. Revalidate only; never replay the operation.
      if (this.connection.resume) await this.connection.resume().catch(() => undefined);
      else window.location.replace('/phone');
    } else if (res.status === 401 && !window.piKit) {
      try {
        localStorage.removeItem(TOKEN_KEY);
      } catch {
        // ignore
      }
    }
    return res;
  }
}
