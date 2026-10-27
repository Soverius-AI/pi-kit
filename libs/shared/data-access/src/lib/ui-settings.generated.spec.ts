import { TestBed } from '@angular/core/testing';
import {
  ApiClient,
  appSettingsSetSetting,
  appSettingsSettings,
  fakeBackend,
  secretsRedactionConfig,
  secretsSaveRedaction,
  unwrap,
} from '@pi-kit/api';

/** What goes on the wire for each call: the typed client runs for real, over a stand-in for the backend. */
describe('generated operations and ApiClient', () => {
  let backend: ReturnType<typeof fakeBackend>;

  beforeEach(() => {
    backend = fakeBackend();
    TestBed.configureTestingModule({ providers: [{ provide: ApiClient, useValue: backend.apiClient }] });
  });

  it('reads every stored preference and stores one value under its key', async () => {
    const api = TestBed.inject(ApiClient);
    backend.reply({ theme: 'dark' });
    expect(await unwrap(appSettingsSettings({ client: api.client }))).toEqual({ theme: 'dark' });
    expect(backend.calls[0]).toMatchObject({ method: 'GET', path: '/api/settings' });
    backend.reply();
    await unwrap(appSettingsSetSetting({ client: api.client, path: { key: 'selectedThread' }, body: { value: 't1' } }));
    expect(backend.calls[1]).toMatchObject({
      method: 'PUT',
      path: '/api/settings/selectedThread',
      body: { value: 't1' },
    });
  });

  it('says what a refused key is', async () => {
    backend.fail(400, 'Invalid settings key.');
    await expect(
      unwrap(
        appSettingsSetSetting({ client: TestBed.inject(ApiClient).client, path: { key: '1bad' }, body: { value: 1 } }),
      ),
    ).rejects.toThrow('Invalid settings key.');
  });

  it('reads and saves the redaction settings, the whole configuration at once', async () => {
    const api = TestBed.inject(ApiClient);
    backend.reply({ config: { patterns: [], offFor: [] }, errors: [] });
    expect(await unwrap(secretsRedactionConfig({ client: api.client }))).toEqual({
      config: { patterns: [], offFor: [] },
      errors: [],
    });
    expect(backend.calls[0]).toMatchObject({ method: 'GET', path: '/api/redaction' });
    backend.reply({ config: { patterns: [], offFor: ['/p'] }, errors: [] });
    await unwrap(secretsSaveRedaction({ client: api.client, body: { patterns: [], offFor: ['/p'] } }));
    expect(backend.calls[1]).toMatchObject({
      method: 'PUT',
      path: '/api/redaction',
      body: { patterns: [], offFor: ['/p'] },
    });
  });
});
