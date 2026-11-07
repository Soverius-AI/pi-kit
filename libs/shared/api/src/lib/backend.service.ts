import { Injectable, InjectionToken, inject, isDevMode } from '@angular/core';
import './pi-kit-bridge';

const URL_KEY = 'pi-kit.backendUrl';
const TOKEN_KEY = 'pi-kit.token';
const OWNER_TOKEN_KEY = 'pi-kit.owner';
export interface BackendConnection {
  /** Phones use same-origin cookies and a CSRF nonce, an owner's browser its own bearer token; never the private desktop token. */
  readonly mode?: 'phone' | 'owner';
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

/** `device` or `owner` in the production index the host's gateways serve. */
const servedAs = (): string | null | undefined =>
  window.piKit ? undefined : document.querySelector('meta[name="pi-kit-connection"]')?.getAttribute('content');

/** Present only in the production index served by the private device gateway. */
export function isDeviceConnection(): boolean {
  return servedAs() === 'device';
}

/** A browser the owner signed in with `pi-kit open`: a one-time code in the fragment buys a token kept in this origin's storage. */
function ownerConnection(): BackendConnection {
  let token: Promise<string> | undefined;
  const signIn = async (): Promise<string> => {
    const code = /^#owner=([A-Za-z0-9_-]{43})$/.exec(location.hash)?.[1];
    if (code) {
      history.replaceState(null, '', location.pathname + location.search);
      const response = await fetch('/owner/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code }),
        cache: 'no-store',
        redirect: 'error',
      });
      const issued = response.ok ? ((await response.json()) as { token?: unknown }).token : undefined;
      if (typeof issued === 'string') {
        writeStorage(OWNER_TOKEN_KEY, issued);
        return issued;
      }
    }
    const stored = readStorage(OWNER_TOKEN_KEY);
    if (stored) return stored;
    location.replace('/owner');
    throw new Error('Sign in with "pi-kit open" on this computer.');
  };
  return { mode: 'owner', url: async () => location.origin, token: () => (token ??= signIn()) };
}

/** Electron resolves through preload; paired phones and the owner's browser use the gateway that served them. */
export function createBackendConnection(devWebUrl = 'http://127.0.0.1:4300'): BackendConnection {
  if (servedAs() === 'owner') return ownerConnection();
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
      // The desktop app adds the token to the page's requests itself.
      if (window.piKit) return '';
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
    const token = await this.token();
    if (token) headers.set('Authorization', `Bearer ${token}`);
    const res = await fetch(`${await this.url()}${path}`, {
      ...init,
      ...(this.connection.mode === 'phone' ? { credentials: 'same-origin' as const, redirect: 'error' as const } : {}),
      headers,
    });
    if (res.status === 401 && this.connection.mode === 'phone') {
      // A target's 401 is not proof that entry-device approval was lost. Revalidate only; never replay the operation.
      if (this.connection.resume) await this.connection.resume().catch(() => undefined);
      else window.location.replace('/phone');
    } else if (res.status === 401 && this.connection.mode === 'owner') {
      if (res.headers.get('www-authenticate')?.includes('pi-kit-owner')) {
        try {
          localStorage.removeItem(OWNER_TOKEN_KEY);
        } catch {
          // ignore
        }
        window.location.replace('/owner');
      }
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
