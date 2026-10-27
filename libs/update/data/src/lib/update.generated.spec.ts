import { TestBed } from '@angular/core/testing';
import {
  ApiClient,
  createTypedClient,
  fakeBackend,
  unwrap,
  updateCancel,
  updateCheck,
  updateEvents,
  updateInstallApp,
  updateInstallCommand,
  updatePin,
  updateReleases,
  updateRestart,
  updateStart,
  updateStatus,
} from '@pi-kit/api';

/** What goes on the wire for each call: the typed client runs for real, over a stand-in for the backend. */
describe('generated operations', () => {
  let backend: ReturnType<typeof fakeBackend>;
  let api: ApiClient;

  beforeEach(() => {
    backend = fakeBackend();
    TestBed.configureTestingModule({ providers: [{ provide: ApiClient, useValue: backend.apiClient }] });
    api = TestBed.inject(ApiClient);
  });

  it.each([
    ['status', () => unwrap(updateStatus({ client: api.client })), 'GET', '/api/update/status', undefined],
    ['check', () => unwrap(updateCheck({ client: api.client })), 'POST', '/api/update/check', undefined],
    [
      'start',
      () => unwrap(updateStart({ client: api.client, body: { targets: ['pi', 'packages'] } })),
      'POST',
      '/api/update',
      { targets: ['pi', 'packages'] },
    ],
    ['cancel', () => unwrap(updateCancel({ client: api.client })), 'POST', '/api/update/cancel', undefined],
    ['restart', () => unwrap(updateRestart({ client: api.client })), 'POST', '/api/update/restart', undefined],
    [
      'installApp',
      () => unwrap(updateInstallApp({ client: api.client })),
      'POST',
      '/api/update/install-app',
      undefined,
    ],
    [
      'installCommand',
      () => unwrap(updateInstallCommand({ client: api.client })),
      'POST',
      '/api/update/install-command',
      undefined,
    ],
    ['releases', () => unwrap(updateReleases({ client: api.client })), 'GET', '/api/update/releases', undefined],
    [
      'pin a release',
      () => unwrap(updatePin({ client: api.client, body: { release: '1.3.0' } })),
      'POST',
      '/api/update/pin',
      { release: '1.3.0' },
    ],
    [
      'follow the newest again',
      () => unwrap(updatePin({ client: api.client, body: { release: null } })),
      'POST',
      '/api/update/pin',
      { release: null },
    ],
  ])('%s sends the method, path and body the contract names', async (_name, call, method, path, body) => {
    backend.reply({});
    await call();
    expect(backend.calls[0]).toMatchObject({ method, path });
    expect(backend.calls[0].body).toEqual(body);
  });

  it('says why an update could not start, as the backend does', async () => {
    backend.fail(409, 'An update is already running.');
    await expect(unwrap(updateStart({ client: api.client, body: { targets: ['pi'] } }))).rejects.toThrow(
      'An update is already running.',
    );
  });

  it('reads a generated event response line by line', async () => {
    const lines = [{ type: 'line', text: 'a', at: 1 }];
    const fetch = vi.fn(async () => new Response(lines.map((line) => JSON.stringify(line)).join('\n') + '\n'));
    const seen: unknown[] = [];
    await api.stream(updateEvents({ client: createTypedClient(fetch), parseAs: 'stream' }), (line) => seen.push(line));
    expect(fetch).toHaveBeenCalledWith('/api/update/events', expect.any(Object));
    expect(seen).toEqual(lines);
  });
});
