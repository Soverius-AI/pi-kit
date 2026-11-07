import { TestBed } from '@angular/core/testing';
import {
  BACKEND_CONNECTION,
  BackendService,
  createBackendConnection,
  isDeviceConnection,
  type BackendConnection,
} from './backend.service';

describe('BackendService transport', () => {
  afterEach(() => {
    document.querySelectorAll('meta[name="pi-kit-connection"]').forEach((meta) => meta.remove());
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('uses a same-origin phone session without reading or persisting a desktop/dev token', async () => {
    vi.stubGlobal('piKit', undefined);
    const meta = document.createElement('meta');
    meta.name = 'pi-kit-connection';
    meta.content = 'device';
    document.head.append(meta);
    const read = vi.spyOn(Storage.prototype, 'getItem');
    const write = vi.spyOn(Storage.prototype, 'setItem');
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ token: 'phone-csrf-nonce-not-the-backend-token' }),
    );
    vi.stubGlobal('fetch', fetch);
    const connection = createBackendConnection('http://127.0.0.1:9999');
    expect(isDeviceConnection()).toBe(true);
    expect(connection.mode).toBe('phone');
    expect(await connection.url()).toBe(window.location.origin);
    const [first, second] = await Promise.all([connection.token(), connection.token()]);
    expect(first).toBe('phone-csrf-nonce-not-the-backend-token');
    expect(second).toBe(first);
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith('/phone/session', {
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
    });
    expect(read).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it('revalidates after foreground resume without resending an API mutation', async () => {
    vi.stubGlobal('piKit', undefined);
    const marker = document.createElement('meta');
    marker.name = 'pi-kit-connection';
    marker.content = 'device';
    document.head.append(marker);
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ token: 'persistent-phone-csrf-nonce' }));
    vi.stubGlobal('fetch', fetch);
    const connection = createBackendConnection();
    expect(await connection.token()).toBe('persistent-phone-csrf-nonce');
    await connection.resume?.();
    expect(await connection.token()).toBe('persistent-phone-csrf-nonce');
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.every(([url]) => url === '/phone/session')).toBe(true);
  });

  it('ignores the phone marker in the trusted Electron renderer', async () => {
    const meta = document.createElement('meta');
    meta.name = 'pi-kit-connection';
    meta.content = 'device';
    document.head.append(meta);
    vi.stubGlobal('piKit', {
      getBackendUrl: async () => 'http://127.0.0.1:1234',
      getToken: async () => 'desktop-token',
    });
    const connection = createBackendConnection();
    expect(isDeviceConnection()).toBe(false);
    expect(await connection.token()).toBe('desktop-token');
  });

  it('retries a failed phone nonce request without falling back to dev token discovery', async () => {
    vi.stubGlobal('piKit', undefined);
    const meta = document.createElement('meta');
    meta.name = 'pi-kit-connection';
    meta.content = 'device';
    document.head.append(meta);
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ token: 'short' }))
      .mockResolvedValueOnce(Response.json({ token: 'valid-phone-csrf-nonce' }));
    vi.stubGlobal('fetch', fetch);
    const connection = createBackendConnection();
    await expect(connection.token()).rejects.toThrow('Invalid phone session');
    expect(await connection.token()).toBe('valid-phone-csrf-nonce');
    expect(fetch.mock.calls.every(([url]) => url === '/phone/session')).toBe(true);
  });

  it('sends the phone nonce with its cookie while retaining replay headers and cancellation', async () => {
    const connection: BackendConnection = {
      mode: 'phone',
      url: async () => window.location.origin,
      token: async () => 'phone-nonce',
    };
    TestBed.configureTestingModule({ providers: [{ provide: BACKEND_CONNECTION, useValue: connection }] });
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetch);
    const signal = new AbortController().signal;
    await TestBed.inject(BackendService).fetch('/api/threads/events', {
      signal,
      headers: { 'x-pi-replay-cursor': 'g:1' },
      credentials: 'omit',
    });
    const [, init] = fetch.mock.calls[0];
    expect(init?.credentials).toBe('same-origin');
    expect(init?.redirect).toBe('error');
    expect(init?.signal).toBe(signal);
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer phone-nonce');
    expect(new Headers(init?.headers).get('x-pi-replay-cursor')).toBe('g:1');
  });

  it('uses the provided connection, keeps headers and cancellation, and reads the token per request', async () => {
    const connection: BackendConnection = {
      url: async () => 'http://127.0.0.1:5678',
      token: vi.fn().mockResolvedValueOnce('first').mockResolvedValueOnce('second'),
    };
    TestBed.configureTestingModule({ providers: [{ provide: BACKEND_CONNECTION, useValue: connection }] });
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetch);
    const transport = TestBed.inject(BackendService);
    const abort = new AbortController();
    await transport.fetch('/api/health', { signal: abort.signal, headers: { Accept: 'application/json' } });
    await transport.fetch('/api/health');
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:5678/api/health');
    expect(init?.signal).toBe(abort.signal);
    expect(new Headers(init?.headers).get('accept')).toBe('application/json');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer first');
    expect(new Headers(fetch.mock.calls[1][1]?.headers).get('authorization')).toBe('Bearer second');
  });

  it('trades the one-time owner link for a token kept in this origin, as a full owner UI rather than a phone', async () => {
    vi.stubGlobal('piKit', undefined);
    const meta = document.createElement('meta');
    meta.name = 'pi-kit-connection';
    meta.content = 'owner';
    document.head.append(meta);
    localStorage.removeItem('pi-kit.owner');
    const code = 'c'.repeat(43);
    history.replaceState(null, '', `${location.pathname}#owner=${code}`);
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ token: 'owner-browser-token' }));
    vi.stubGlobal('fetch', fetch);

    const connection = createBackendConnection();
    expect(isDeviceConnection()).toBe(false);
    expect(connection.mode).toBe('owner');
    expect(await connection.token()).toBe('owner-browser-token');
    expect(location.hash).toBe('');
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('/owner/session');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ code });

    expect(await createBackendConnection().token()).toBe('owner-browser-token');
    expect(fetch).toHaveBeenCalledOnce();
    localStorage.removeItem('pi-kit.owner');
  });

  it('signs the owner browser out only when the owner listener itself refuses its token', async () => {
    localStorage.setItem('pi-kit.owner', 'owner-browser-token');
    const connection: BackendConnection = {
      mode: 'owner',
      url: async () => window.location.origin,
      token: async () => 'owner-browser-token',
    };
    TestBed.configureTestingModule({ providers: [{ provide: BACKEND_CONNECTION, useValue: connection }] });
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ error: 'peer refused' }, { status: 401 }))
      .mockResolvedValueOnce(
        Response.json(
          { error: 'Sign-in required' },
          { status: 401, headers: { 'WWW-Authenticate': 'Bearer realm="pi-kit-owner"' } },
        ),
      );
    vi.stubGlobal('fetch', fetch);
    const transport = TestBed.inject(BackendService);

    await transport.fetch('/api/instances/peer/proxy/api/threads');
    expect(localStorage.getItem('pi-kit.owner')).toBe('owner-browser-token');
    await transport.fetch('/api/threads');
    expect(localStorage.getItem('pi-kit.owner')).toBeNull();
  });
});
