import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PiUpdateService } from './pi-update.service';

// pi is ESM only and the backend loads it with a native import() that vitest's module runner does not allow; a stand-in with the two members used.
vi.mock('./load-pi', () => ({
  loadPi: () => Promise.resolve({ VERSION: '1.2.0', getPackageDir: () => '/app/node_modules/@earendil-works/pi-coding-agent' }),
  piResolution: () => ({ source: 'bundled', version: '1.2.0', packageDir: '/app/node_modules/@earendil-works/pi-coding-agent', range: { min: '1.2.0', max: '1.x' }, notes: ['a note'] }),
}));

const respond = (body: unknown, status = 200) => vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));

describe('PiUpdateService (the check asks pi.dev, as pi does, and only reads)', () => {
  let installed: string;
  beforeEach(async () => {
    installed = '1.2.0';
    delete process.env['PI_OFFLINE'];
    delete process.env['PI_SKIP_VERSION_CHECK'];
  });
  afterEach(() => vi.unstubAllGlobals());

  it('reports a newer release, with the note, and names the command to run', async () => {
    const fetchMock = respond({ ok: true, version: '99.0.0', packageName: '@earendil-works/pi-coding-agent', note: 'Big release' });
    vi.stubGlobal('fetch', fetchMock);
    const result = await new PiUpdateService().check(true);
    expect(result).toMatchObject({ current: installed, latest: '99.0.0', updateAvailable: true, note: 'Big release', command: 'pi update' });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe('https://pi.dev/api/latest-version');
    expect((fetchMock.mock.calls[0][1] as RequestInit).method ?? 'GET').toBe('GET');
  });

  it('says up to date when the release is the installed one or older', async () => {
    vi.stubGlobal('fetch', respond({ version: installed }));
    expect(await new PiUpdateService().check(true)).toMatchObject({ latest: installed, updateAvailable: false });
    vi.stubGlobal('fetch', respond({ version: '0.0.1' }));
    expect(await new PiUpdateService().check(true)).toMatchObject({ updateAvailable: false });
  });

  it('does not call out when pi’s own switches are set', async () => {
    const fetchMock = respond({ version: '99.0.0' });
    vi.stubGlobal('fetch', fetchMock);
    process.env['PI_SKIP_VERSION_CHECK'] = '1';
    expect(await new PiUpdateService().check(true)).toMatchObject({ skipped: 'disabled', updateAvailable: false });
    delete process.env['PI_SKIP_VERSION_CHECK'];
    process.env['PI_OFFLINE'] = '1';
    expect(await new PiUpdateService().check(true)).toMatchObject({ skipped: 'offline' });
    expect(fetchMock).not.toHaveBeenCalled();
    delete process.env['PI_OFFLINE'];
  });

  it('reports a failure instead of throwing, and does not cache it', async () => {
    const service = new PiUpdateService();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    expect(await service.check()).toMatchObject({ updateAvailable: false, error: 'network down' });
    vi.stubGlobal('fetch', respond({ version: '99.0.0' }));
    expect(await service.check()).toMatchObject({ latest: '99.0.0', updateAvailable: true });
  });

  it('caches a good answer for a while', async () => {
    const fetchMock = respond({ version: '99.0.0' });
    vi.stubGlobal('fetch', fetchMock);
    const service = new PiUpdateService();
    await service.check();
    await service.check();
    expect(fetchMock).toHaveBeenCalledOnce();
    await service.check(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('answers about with the pi it runs', async () => {
    const about = await new PiUpdateService().about();
    expect(about.pi).toMatchObject({ version: installed, packageName: '@earendil-works/pi-coding-agent' });
    expect(about.pi.packageDir).toMatch(/pi-coding-agent$/);
    expect(about.pi).toMatchObject({ source: 'bundled', range: { min: '1.2.0', max: '1.x' }, notes: ['a note'] });
  });
});
