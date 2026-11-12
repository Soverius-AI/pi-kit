import { TestBed } from '@angular/core/testing';
import { BackendService } from '@pi-kit/api';
import { PreviewPolicy } from './preview-policy';

describe('iframe preview policy', () => {
  let meta: HTMLMetaElement;
  beforeEach(() => {
    meta = document.createElement('meta');
    meta.name = 'pi-kit-preview-origins';
    meta.content = JSON.stringify(['https://preview.example', 'https://backend.example', location.origin]);
    document.head.appendChild(meta);
    TestBed.configureTestingModule({
      providers: [{ provide: BackendService, useValue: { url: async () => 'https://backend.example' } }],
    });
  });
  afterEach(() => {
    meta.remove();
    document.querySelector('meta[name="pi-kit-connection"]')?.remove();
    TestBed.resetTestingModule();
  });

  async function policy() {
    const service = TestBed.inject(PreviewPolicy);
    await Promise.resolve();
    return service;
  }

  it('waits for the backend origin and only admits explicitly configured origins', async () => {
    const service = TestBed.inject(PreviewPolicy);
    expect(service.resolve('https://preview.example/app')).toEqual({ blocked: 'pending' });
    await Promise.resolve();
    expect(service.resolve('https://preview.example/app')).toEqual({ url: 'https://preview.example/app' });
    expect(service.resolve('https://preview.example.evil/app')).toEqual({ blocked: 'origin' });
    expect(service.resolve('https://unapproved.example')).toEqual({ blocked: 'origin' });
    expect(service.external('https://unapproved.example')).toBe('https://unapproved.example/');
  });

  it('rejects protected origins, credentials and non-web URLs even if configuration permits them', async () => {
    const service = await policy();
    expect(service.resolve('https://backend.example/api')).toEqual({ blocked: 'protected' });
    expect(service.resolve(location.origin + '/api')).toEqual({ blocked: 'protected' });
    for (const url of [
      'javascript:alert(1)',
      'data:text/html,hi',
      '//preview.example',
      'https://user:password@preview.example',
    ])
      expect(service.resolve(url)).toEqual({ blocked: 'invalid' });
  });

  it('fails closed for missing or malformed origin configuration', async () => {
    meta.content = '["https://preview.example", "https://bad.example/path"]';
    expect((await policy()).resolve('https://preview.example')).toEqual({ blocked: 'unconfigured' });
  });

  it('rejects phone cookie hostnames across ports', async () => {
    const device = document.createElement('meta');
    device.name = 'pi-kit-connection';
    device.content = 'device';
    document.head.appendChild(device);
    const service = await policy();
    expect(service.external(`${location.protocol}//${location.hostname}:9876/`)).toBeUndefined();
  });
});
