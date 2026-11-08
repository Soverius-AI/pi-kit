import { afterEach, describe, expect, it, vi } from 'vitest';
import { RemoteAccessStores } from './remote-access-store';

afterEach(() => vi.unstubAllGlobals());
describe('private phone approval adapter', () => {
  it('captures private loopback URL/token together with bounded, redirect-free requests', async () => {
    const fetch = vi.fn(async () => Response.json([]));
    vi.stubGlobal('fetch', fetch);
    const stores = new RemoteAccessStores(() => ({ url: 'http://127.0.0.1:23456', token: 'PRIVATE-MASTER' }));
    expect(await stores.grants.load()).toEqual([]);
    expect(fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:23456/api/instance/devices',
      expect.objectContaining({
        redirect: 'error',
        headers: { authorization: 'Bearer PRIVATE-MASTER' },
      }),
    );
  });
  it('refuses non-loopback, credential-bearing and malformed addresses before fetching', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    for (const url of [
      'https://remote.ts.net',
      'http://localhost:123',
      'http://user:secret@127.0.0.1:123',
      'http://127.0.0.1:123/api',
    ])
      await expect(new RemoteAccessStores(() => ({ url, token: 'secret' })).grants.load()).rejects.toThrow(
        'storage unavailable',
      );
    expect(fetch).not.toHaveBeenCalled();
  });
  it('fails closed on invalid or inaccessible approval data and validates preferences', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ secret: 'not a device list' })),
    );
    const stores = new RemoteAccessStores(() => ({ url: 'http://127.0.0.1:23456', token: 'secret' }));
    await expect(stores.grants.load()).rejects.toThrow();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ error: 'raw private response' }, { status: 500 })),
    );
    await expect(stores.preferences.load()).rejects.toThrow('Phone approval storage unavailable');
  });
});
