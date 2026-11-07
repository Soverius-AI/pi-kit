import { TestBed } from '@angular/core/testing';
import type { RemoteAccessStatus } from '@pi-kit/protocol';
import { searchSettings, settingsSections } from '@pi-kit/ui';
import { SettingsStore } from '@pi-kit/settings/data';
import { RemoteAccessSection } from './remote-access-section';
import { toDataURL } from 'qrcode';

vi.mock('qrcode', () => ({ toDataURL: vi.fn().mockResolvedValue('data:image/png;base64,cXI=') }));

describe('Settings › Remote access', () => {
  const previous = window.piKit;
  const getStatus = vi.fn<() => Promise<RemoteAccessStatus>>();
  const start = vi.fn<() => Promise<RemoteAccessStatus>>();
  const stop = vi.fn<() => Promise<RemoteAccessStatus>>();
  const pair = vi.fn<() => Promise<RemoteAccessStatus>>();
  const approve = vi.fn<(id: string) => Promise<RemoteAccessStatus>>();
  const reject = vi.fn<(id: string) => Promise<RemoteAccessStatus>>();
  const revoke = vi.fn<(id: string) => Promise<RemoteAccessStatus>>();
  const serving: RemoteAccessStatus = { state: 'serving', url: 'https://desktop.example.ts.net/' };
  const paired = (): RemoteAccessStatus => ({
    ...serving,
    pairing: {
      code: '12345678',
      url: 'https://desktop.example.ts.net/#pair=private-secret',
      expiresAt: Date.now() + 60_000,
    },
    requests: [{ id: 'request-1', name: 'My iPhone', confirmationCode: '654321', expiresAt: Date.now() + 60_000 }],
    devices: [{ id: 'device-1', name: 'Approved iPhone', createdAt: Date.now(), lastSeenAt: Date.now() }],
  });

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [{ provide: SettingsStore, useValue: { matches: () => new Set(['remote-access-port']) } }],
    });
    localStorage.removeItem('pi-kit.remoteAccess.port');
    vi.resetAllMocks();
    vi.mocked(toDataURL as (text: string) => Promise<string>).mockResolvedValue('data:image/png;base64,cXI=');
    pair.mockImplementation(async () => paired());
    approve.mockResolvedValue(serving);
    reject.mockResolvedValue(serving);
    revoke.mockResolvedValue(serving);
    getStatus.mockResolvedValue({ state: 'available', version: '1.90.0' });
    start.mockResolvedValue({ state: 'serving', url: 'https://desktop.example.ts.net/' });
    stop.mockResolvedValue({ state: 'available' });
    window.piKit = {
      getBackendUrl: async () => '',
      getRemoteAccessStatus: getStatus,
      startRemoteAccess: start,
      stopRemoteAccess: stop,
      beginRemotePairing: pair,
      approveRemotePairing: approve,
      rejectRemotePairing: reject,
      revokeRemoteDevice: revoke,
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    window.piKit = previous;
  });

  const render = async () => {
    const fixture = TestBed.createComponent(RemoteAccessSection);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    return {
      fixture,
      el,
      q: (id: string) => el.querySelector<HTMLElement>(`[data-testid="remote-access-${id}"]`),
      settle: async () => {
        await fixture.whenStable();
        fixture.detectChanges();
      },
    };
  };

  it('is explicitly desktop-only in a browser and never installs a bridge', async () => {
    delete window.piKit;
    const { q } = await render();
    expect(q('desktop-only')?.textContent).toContain('desktop app');
    expect(q('start')).toBeNull();
    expect(q('refresh')).toBeNull();
    expect(q('download')?.getAttribute('href')).toBe('https://tailscale.com/download');
    expect(getStatus).not.toHaveBeenCalled();
    expect(window.piKit).toBeUndefined();
  });

  it('checks on open, shows stopped and version, and never starts automatically', async () => {
    const { q, settle } = await render();
    expect(getStatus).toHaveBeenCalledTimes(1);
    expect(start).not.toHaveBeenCalled();
    expect(q('status')?.textContent).toContain('Remote access is disabled');
    expect(q('version')?.textContent).toContain('1.90.0');
    expect(q('url')).toBeNull();
    expect(q('safety')?.textContent).toContain('control the agent, files, and terminal');
    q('refresh')!.click();
    await settle();
    expect(getStatus).toHaveBeenCalledTimes(2);
  });

  it('shows approved HTTPS as complete rather than asking for approval again', async () => {
    getStatus.mockResolvedValue({ state: 'available', httpsReady: true, port: 8443 });
    const { el, q } = await render();
    expect(el.textContent).toContain('HTTPS certificates are approved');
    expect(el.textContent).not.toContain('find “HTTPS Certificates” and enable HTTPS');
    expect(q('setup')).toBeNull();
    expect(q('start')?.hasAttribute('disabled')).toBe(false);
  });

  it('passes a custom port on explicit enable and locks it while serving', async () => {
    start.mockResolvedValue({ state: 'serving', port: 9443, url: 'https://desktop.example.ts.net:9443' });
    const { q, fixture, settle } = await render();
    const input = q('port') as HTMLInputElement;
    expect(input.value).toBe('8443');
    input.value = '9443';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    fixture.detectChanges();
    q('start')!.click();
    await settle();
    expect(start).toHaveBeenCalledExactlyOnceWith(9443);
    expect(input.disabled).toBe(true);
    expect(q('url')?.getAttribute('href')).toBe('https://desktop.example.ts.net:9443/');
    q('stop')!.click();
    await settle();
    expect(input.disabled).toBe(false);
  });

  it('remembers a valid port when reopening Settings without enabling anything', async () => {
    const first = await render();
    const input = first.q('port') as HTMLInputElement;
    input.value = '443';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    first.fixture.destroy();
    const second = await render();
    expect((second.q('port') as HTMLInputElement).value).toBe('443');
    expect(start).not.toHaveBeenCalled();
  });

  it.each(['', '0', '65536', '1.5', '-1'])('rejects invalid port %s before any enable action', async (value) => {
    const { q, fixture } = await render();
    const input = q('port') as HTMLInputElement;
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    fixture.detectChanges();
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(q('port-error')?.textContent).toContain('1 to 65535');
    expect(q('start')?.hasAttribute('disabled')).toBe(true);
    q('start')!.click();
    expect(start).not.toHaveBeenCalled();
  });

  it('starts only on request and displays an active URL, then stops', async () => {
    const { q, settle } = await render();
    q('start')!.click();
    await settle();
    expect(start).toHaveBeenCalledTimes(1);
    expect(q('status')?.textContent).toContain('Remote access is enabled');
    expect(q('url')?.getAttribute('href')).toBe('https://desktop.example.ts.net/');
    expect(q('url')?.getAttribute('rel')).toBe('noopener noreferrer');
    q('stop')!.click();
    await settle();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(q('url')).toBeNull();
    expect(q('status')?.textContent).toContain('Remote access is disabled');
  });

  it('renders an already serving test without starting another', async () => {
    getStatus.mockResolvedValue({ state: 'serving', url: 'https://phone.example.ts.net' });
    const { q } = await render();
    expect(q('url')).not.toBeNull();
    expect(q('stop')).not.toBeNull();
    expect(start).not.toHaveBeenCalled();
  });

  it('handles action and refresh failures and clears busy so the user can retry', async () => {
    start.mockRejectedValue(new Error('Could not bind listener'));
    const { q, settle } = await render();
    q('start')!.click();
    await settle();
    expect(q('message')?.textContent).toContain('Could not bind listener');
    expect(q('message')?.getAttribute('role')).toBe('alert');
    expect(q('start')?.hasAttribute('disabled')).toBe(false);
    expect(q('url')).toBeNull();
    getStatus.mockRejectedValue(new Error('Status check failed'));
    q('refresh')!.click();
    await settle();
    expect(q('message')?.textContent).toContain('Status check failed');
    expect(q('refresh')?.hasAttribute('disabled')).toBe(false);
  });

  it('locks actions and shows a spinner while a request is pending', async () => {
    let resolve!: (status: RemoteAccessStatus) => void;
    start.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const { q, fixture, settle } = await render();
    q('start')!.click();
    fixture.detectChanges();
    expect(q('spinner')).not.toBeNull();
    expect(q('start')?.hasAttribute('disabled')).toBe(true);
    expect(q('refresh')?.hasAttribute('disabled')).toBe(true);
    q('start')!.click();
    expect(start).toHaveBeenCalledTimes(1);
    resolve({ state: 'available' });
    await settle();
    expect(q('spinner')).toBeNull();
  });

  it.each(['unavailable', 'disconnected', 'starting'] as const)(
    'does not suggest a ready test for %s',
    async (state) => {
      getStatus.mockResolvedValue({ state });
      const { q } = await render();
      expect(q('url')).toBeNull();
      expect(q('status')?.textContent).not.toContain('Remote access is enabled');
      expect(q('start')?.hasAttribute('disabled') ?? true).toBe(true);
    },
  );

  it('allows an explicit retry from the error state', async () => {
    getStatus.mockResolvedValue({ state: 'error', message: 'Tailscale failed' });
    const { q, settle } = await render();
    expect(q('message')?.getAttribute('role')).toBe('alert');
    expect(start).not.toHaveBeenCalled();
    q('start')!.click();
    await settle();
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('shows one actionable description instead of duplicating generic and native errors', async () => {
    getStatus.mockResolvedValue({ state: 'error', issue: 'connection-required', message: 'Connect Tailscale first.' });
    const { el, q } = await render();
    expect(el.querySelectorAll('[role="alert"]')).toHaveLength(1);
    expect(q('message')?.textContent).toContain('Connect Tailscale first.');
    expect(el.textContent).not.toContain('Remote access could not be checked or changed');
    expect(q('start')?.hasAttribute('disabled')).toBe(true);
  });

  it('treats running Tailscale without HTTPS certificates as setup, not ready', async () => {
    const setup = vi.fn().mockResolvedValue(undefined);
    Object.assign(window.piKit!, { openRemoteAccessSetup: setup });
    getStatus.mockResolvedValue({
      state: 'available',
      issue: 'https-required',
      setupAction: 'https',
      message: 'Enable HTTPS certificates in the Tailscale admin console, then check again.',
    });
    const { q, el, settle } = await render();
    expect(q('status')?.textContent).toContain('Setup needed');
    expect(el.textContent).not.toContain('Ready to connect');
    expect(el.querySelectorAll('[role="alert"]')).toHaveLength(1);
    expect(q('start')).toBeNull();
    expect(setup).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    q('setup')!.click();
    await settle();
    expect(setup).toHaveBeenCalledExactlyOnceWith('https');
    expect(q('setup-opened')?.textContent).toContain('then check again');
    expect(start).not.toHaveBeenCalled();
    expect(getStatus).toHaveBeenCalledTimes(1);
    q('refresh')!.click();
    await settle();
    expect(getStatus).toHaveBeenCalledTimes(2);
  });

  it('never offers enable from an unknown or failed status check', async () => {
    getStatus.mockResolvedValue({ state: 'error', issue: 'status-failed', message: 'Cannot read Tailscale status.' });
    const { q } = await render();
    expect(q('start')).toBeNull();
    expect(q('retry-status')).not.toBeNull();
    expect(q('status')?.textContent).toContain('Connection needs attention');
    expect(q('status')?.textContent).not.toContain('Setup needed');
    expect(start).not.toHaveBeenCalled();
  });

  it('does not turn untrusted or non-HTTPS status URLs into links', async () => {
    getStatus.mockResolvedValue({ state: 'serving', url: 'javascript:alert(1)' });
    expect((await render()).q('url')).toBeNull();
  });

  it('generates a local QR only after explicit pairing and shows code and expiry', async () => {
    getStatus.mockResolvedValue(paired());
    const { q, settle } = await render();
    expect(pair).not.toHaveBeenCalled();
    expect(toDataURL).not.toHaveBeenCalled();
    expect(q('qr')).toBeNull();
    q('pair')!.click();
    await settle();
    expect(pair).toHaveBeenCalledTimes(1);
    expect(toDataURL).toHaveBeenCalledWith('https://desktop.example.ts.net/#pair=private-secret', expect.any(Object));
    expect(q('qr')?.getAttribute('src')).toBe('data:image/png;base64,cXI=');
    expect(q('code')?.textContent).toContain('12345678');
    expect(q('expiry')?.textContent).toContain('Expires:');
    expect(q('url')?.getAttribute('href')).not.toContain('private-secret');
  });

  it.each(['approve', 'deny', 'revoke'] as const)('requires explicit %s and sends the correct id', async (action) => {
    getStatus.mockResolvedValue(paired());
    const { q, settle } = await render();
    expect(q('confirmation-code')?.textContent).toContain('654321');
    expect(q('request')?.textContent).toContain('My iPhone');
    expect(approve).not.toHaveBeenCalled();
    expect(reject).not.toHaveBeenCalled();
    expect(revoke).not.toHaveBeenCalled();
    q(action)!.click();
    await settle();
    expect(action === 'approve' ? approve : action === 'deny' ? reject : revoke).toHaveBeenCalledWith(
      action === 'revoke' ? 'device-1' : 'request-1',
    );
  });

  it.each(['pair', 'approve', 'deny', 'revoke', 'stop'] as const)(
    'keeps serving state and shows rejected %s actions',
    async (action) => {
      getStatus.mockResolvedValue(paired());
      const error = new Error('Action failed');
      ({ pair, approve, deny: reject, revoke, stop })[action].mockRejectedValue(error);
      const { q, settle } = await render();
      q(action)!.click();
      await settle();
      expect(q('message')?.textContent).toContain('Action failed');
      expect(q('message')?.getAttribute('role')).toBe('alert');
      expect(q(action)?.hasAttribute('disabled')).toBe(false);
      expect(q('url')).not.toBeNull();
    },
  );

  it('keeps pairing code usable if local QR generation rejects', async () => {
    getStatus.mockResolvedValue(serving);
    vi.mocked(toDataURL as (text: string) => Promise<string>).mockRejectedValue(new Error('QR unavailable'));
    const { q, settle } = await render();
    q('pair')!.click();
    await settle();
    expect(q('qr')).toBeNull();
    expect(q('code')?.textContent).toContain('12345678');
  });

  it('polls only while serving, preserves failures, and cancels polling on destroy', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    const { fixture, q, settle } = await render();
    await vi.advanceTimersByTimeAsync(2000);
    expect(getStatus).toHaveBeenCalledTimes(1);
    q('start')!.click();
    await settle();
    getStatus.mockResolvedValue(paired());
    await vi.advanceTimersByTimeAsync(2000);
    await settle();
    expect(q('request')).not.toBeNull();
    approve.mockRejectedValue(new Error('Approval failed'));
    q('approve')!.click();
    await settle();
    await vi.advanceTimersByTimeAsync(2000);
    await settle();
    expect(q('message')?.textContent).toContain('Approval failed');
    const calls = getStatus.mock.calls.length;
    fixture.destroy();
    await vi.advanceTimersByTimeAsync(4000);
    expect(getStatus).toHaveBeenCalledTimes(calls);
  });

  it('does not apply stale polling results over an explicit action', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    getStatus.mockResolvedValue(serving);
    const { q, settle } = await render();
    let resolve!: (status: RemoteAccessStatus) => void;
    getStatus.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    await vi.advanceTimersByTimeAsync(2000);
    q('stop')!.click();
    await settle();
    resolve(serving);
    await settle();
    expect(q('pair')).toBeNull();
    expect(q('status')?.textContent).toContain('Remote access is disabled');
  });

  it('removes expired QR codes and prevents approving expired requests', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    getStatus.mockResolvedValue(serving);
    const { q, settle } = await render();
    q('pair')!.click();
    await settle();
    const expired = paired();
    expired.pairing!.expiresAt = Date.now() - 1;
    expired.requests![0].expiresAt = Date.now() - 1;
    getStatus.mockResolvedValue(expired);
    await vi.advanceTimersByTimeAsync(2000);
    await settle();
    expect(q('qr')).toBeNull();
    expect(q('expired')).not.toBeNull();
    expect(q('approve')?.hasAttribute('disabled')).toBe(true);
  });

  it.each([
    'https://desktop.example.ts.net/?secret=private#code',
    'javascript:alert(1)',
    'https://user:password@example.test/#code',
  ])('does not generate QR for unsafe pairing URL %s', async (url) => {
    getStatus.mockResolvedValue(serving);
    pair.mockResolvedValue({ ...paired(), pairing: { code: '12345678', url, expiresAt: Date.now() + 60_000 } });
    const { q, settle } = await render();
    q('pair')!.click();
    await settle();
    expect(toDataURL).not.toHaveBeenCalled();
    expect(q('qr')).toBeNull();
  });

  it('ignores rejected in-flight actions after section destruction', async () => {
    let fail!: (error: Error) => void;
    start.mockReturnValue(
      new Promise((_resolve, reject) => {
        fail = reject;
      }),
    );
    const { fixture, q } = await render();
    q('start')!.click();
    fixture.destroy();
    fail(new Error('Already closed'));
    await Promise.resolve();
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('is in the App navigation and discoverable by Tailscale search', () => {
    const translate = (key: string) => key;
    expect(settingsSections(translate).find((section) => section.id === 'remote-access')?.group).toBe('App');
    expect(searchSettings(translate, 'tailscale').has('remote-access')).toBe(true);
  });
});
