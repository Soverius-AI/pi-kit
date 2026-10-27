import { TestBed } from '@angular/core/testing';
import { BACKEND_CONNECTION, BackendService, type BackendConnection } from './backend.service';

describe('BackendService transport', () => {
  afterEach(() => vi.unstubAllGlobals());

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
});
