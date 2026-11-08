import { tailscaleApprovalUrl } from './tailscale-approval';
import { RemoteStorageError } from './remote-access-store';
import { RemoteAccessCommandError } from './tailscale-cli';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  RemoteAccess,
  type RemoteAccessDependencies,
  type RemoteAccessProcess,
  type RemoteAccessGateway,
  type RemoteAccessOptions,
} from './remote-access';

const dns = 'phone.example.ts.net';
function fakeGateway(): RemoteAccessGateway {
  return {
    listen: async () => 'http://127.0.0.1:60001',
    close: async () => undefined,
    beginPairing: () => ({
      code: 'ABCDEFGHJKLM',
      url: 'https://x.y.ts.net:8443/phone#ABCDEFGHJKLM',
      expiresAt: Date.now() + 60000,
    }),
    approve: () => undefined,
    reject: () => undefined,
    revoke: () => undefined,
    status: () => ({ requests: [], devices: [] }),
  };
}

function harness(
  options: {
    missing?: boolean;
    backend?: string;
    conflict?: unknown;
    pending?: boolean;
    stubborn?: boolean;
    gateway?: RemoteAccessGateway;
    stores?: Pick<RemoteAccessOptions, 'grants' | 'preferences'>;
  } = {},
) {
  let config: unknown = options.conflict ?? {};
  let backendState = options.backend ?? 'Running';
  let target = '';
  let previousConfig: unknown = config;
  let exit!: () => void;
  const kill = vi.fn((signal: string) => {
    if (!options.stubborn || signal === 'SIGKILL') {
      config = previousConfig;
      exit();
    }
  });
  const launch = vi.fn((_file: string, args: readonly string[]): RemoteAccessProcess => {
    target = args[2];
    const port = args[1].split('=')[1];
    previousConfig = config;
    if (!options.pending)
      config = {
        ...(config as Record<string, unknown>),
        Foreground: {
          'session-id': {
            TCP: { [port]: { HTTPS: true } },
            Web: { [`${dns}:${port}`]: { Handlers: { '/': { Proxy: target } } } },
          },
        },
      };
    return {
      exited: new Promise<void>((resolve) => {
        exit = resolve;
      }),
      kill,
    };
  });
  const run = vi.fn(async (_file: string, args: readonly string[]) => {
    if (args[0] === 'status')
      return JSON.stringify({
        BackendState: backendState,
        Self: { DNSName: `${dns}.` },
        Peer: { secret: 'not for UI' },
      });
    return JSON.stringify(config);
  });
  const deps: RemoteAccessDependencies = {
    gatewayFactory: vi.fn(() => options.gateway ?? fakeGateway()),
    findCli: vi.fn(async () => (options.missing ? undefined : '/safe/tailscale')),
    run,
    launch,
    startupTimeoutMs: 35,
    pollIntervalMs: 5,
    shutdownTimeoutMs: 10,
    restoreRetryMs: 5,
    restoreAttempts: 4,
  };
  const access = new RemoteAccess(deps, {
    rendererRoot: '/production',
    backend: () => ({ url: 'http://127.0.0.1:9999', token: 'secret' }),
    ...options.stores,
  });
  instances.push(access);
  return {
    access,
    run,
    launch,
    kill,
    deps,
    get target() {
      return target;
    },
    get config() {
      return config;
    },
    setConfig(value: unknown) {
      config = value;
    },
    setBackend(value: string) {
      backendState = value;
    },
    exit() {
      config = {};
      exit();
    },
  };
}
const instances: RemoteAccess[] = [];
afterEach(async () => {
  await Promise.all(instances.splice(0).map((access) => access.dispose()));
});

describe('RemoteAccess', () => {
  it('restores only prior publication consent and retains it on dispose, but clears it on explicit Disable', async () => {
    let desired = { desiredEnabled: false, httpsPort: 9443 };
    const preferences = {
      load: vi.fn(async () => desired),
      save: vi.fn(async (value: typeof desired) => {
        desired = value;
      }),
    };
    const gateway: RemoteAccessGateway = {
      listen: async () => 'http://127.0.0.1:9888',
      close: async () => undefined,
      beginPairing: () => ({ code: 'CODE', url: 'https://phone.example.ts.net/phone', expiresAt: Date.now() + 1000 }),
      approve: () => undefined,
      reject: () => undefined,
      revoke: () => undefined,
      status: () => ({ requests: [], devices: [] }),
    };
    const first = harness({ gateway, stores: { preferences } });
    await first.access.restore();
    expect(first.launch).not.toHaveBeenCalled();
    await first.access.start(9443);
    expect(desired).toEqual({ desiredEnabled: true, httpsPort: 9443 });
    await first.access.dispose();
    expect(desired.desiredEnabled).toBe(true);
    const second = harness({ gateway, stores: { preferences } });
    await second.access.restore();
    expect(second.launch).toHaveBeenCalledOnce();
    await second.access.stop();
    expect(desired).toEqual({ desiredEnabled: false, httpsPort: 9443 });
  });

  it('fails before publication when consent cannot be saved and does not blame HTTPS approval', async () => {
    const preferences = {
      load: async () => ({ desiredEnabled: false, httpsPort: 8443 }),
      save: async () => {
        throw new RemoteStorageError();
      },
    };
    const h = harness({ stores: { preferences } });
    expect(await h.access.start()).toMatchObject({
      state: 'error',
      issue: 'storage-unavailable',
      diagnostic: 'storage: unavailable',
    });
    expect(h.launch).not.toHaveBeenCalled();
    expect(h.deps.findCli).not.toHaveBeenCalled();
  });

  it('restores again while Tailscale is still connecting at boot, until it serves or the owner acts', async () => {
    const preferences = {
      load: async () => ({ desiredEnabled: true, httpsPort: 9443 }),
      save: vi.fn(async () => undefined),
    };
    const booting = harness({ backend: 'Starting', stores: { preferences } });
    const tailscale = booting.run.getMockImplementation()!;
    let checks = 0;
    booting.run.mockImplementation(async (file: string, args: readonly string[]) => {
      if (args[0] === 'status' && ++checks === 2) booting.setBackend('Running');
      return tailscale(file, args);
    });
    await booting.access.restore();
    expect(booting.launch).toHaveBeenCalledOnce();
    expect((await booting.access.status()).state).toBe('serving');

    // The owner disables remote access while the restore waits to try again: it gives up after that one attempt.
    const waiting = harness({ backend: 'Starting', stores: { preferences } });
    const stillStarting = waiting.run.getMockImplementation()!;
    let statusChecks = 0;
    waiting.run.mockImplementation(async (file: string, args: readonly string[]) => {
      if (args[0] === 'status' && ++statusChecks === 1) void waiting.access.stop();
      return stillStarting(file, args);
    });
    await waiting.access.restore();
    expect(waiting.launch).not.toHaveBeenCalled();
    // One restore attempt and stop's own check; without the owner's say, it would try four times.
    expect(statusChecks).toBe(2);
  });

  it('does not let a late restoration override newer explicit Disable consent', async () => {
    let finish!: (value: { desiredEnabled: boolean; httpsPort: number }) => void;
    const preferences = {
      load: () =>
        new Promise<{ desiredEnabled: boolean; httpsPort: number }>((resolve) => {
          finish = resolve;
        }),
      save: vi.fn(async () => undefined),
    };
    const h = harness({ stores: { preferences } });
    const restoring = h.access.restore();
    await h.access.stop();
    finish({ desiredEnabled: true, httpsPort: 9443 });
    await restoring;
    expect(h.launch).not.toHaveBeenCalled();
    expect((await h.access.status()).port).toBe(8443);
    expect(preferences.save).toHaveBeenCalledWith({ desiredEnabled: false, httpsPort: 8443 });
  });

  it('shows and revokes remembered devices while access is disabled, without exposing credential material', async () => {
    const revoke = vi.fn(async () => undefined);
    const grants = {
      load: async () => [
        { id: 'device', name: 'Phone', createdAt: 1, lastSeenAt: 2, csrf: 'PRIVATE-NONCE', cookieHash: 'PRIVATE-HASH' },
      ],
      save: async () => undefined,
      revoke,
    };
    const h = harness({ stores: { grants } });
    const status = await h.access.status();
    expect(status.devices).toEqual([{ id: 'device', name: 'Phone', createdAt: 1, lastSeenAt: 2 }]);
    expect(JSON.stringify(status)).not.toContain('PRIVATE');
    await h.access.revokeDevice('device');
    expect(revoke).toHaveBeenCalledWith('device');
    expect(h.launch).not.toHaveBeenCalled();
  });

  it.each([9443, 443, 65535, 1])(
    'publishes only the selected virtual HTTPS port %i and keeps it after stop',
    async (port) => {
      const other = port === 443 ? 8443 : 443;
      const h = harness({ conflict: { TCP: { [other]: { HTTPS: true } } } });
      expect(await h.access.start(port)).toMatchObject({
        state: 'serving',
        port,
        url: new URL(`https://${dns}:${port}`).origin,
      });
      expect(h.launch).toHaveBeenCalledWith('/safe/tailscale', ['serve', `--https=${port}`, h.target]);
      expect((await h.access.status()).port).toBe(port);
      await expect(h.access.start(other)).rejects.toThrow('Stop');
      expect(h.launch).toHaveBeenCalledTimes(1);
      expect(h.kill).not.toHaveBeenCalled();
      expect(await h.access.stop()).toMatchObject({ state: 'available', port });
      expect(h.config).toEqual({ TCP: { [other]: { HTTPS: true } } });
      expect(h.run.mock.calls.every(([, args]) => args.includes('--json'))).toBe(true);
      expect((await h.access.start()).port).toBe(port);
    },
  );

  it.each([0, 65536, -1, 1.5, '9443', NaN, null, Infinity])(
    'rejects invalid ports before discovery or publication: %s',
    async (port) => {
      const h = harness();
      await expect(h.access.start(port as number)).rejects.toThrow('Invalid');
      expect(h.deps.findCli).not.toHaveBeenCalled();
      expect(h.run).not.toHaveBeenCalled();
      expect(h.launch).not.toHaveBeenCalled();
      expect((await h.access.status()).port).toBe(8443);
    },
  );

  it('leaves an unrelated custom mapping alone when selecting a different port', async () => {
    const h = harness();
    await h.access.start(9443);
    const target = h.target;
    await h.access.stop();
    h.setConfig({
      TCP: { '9443': { HTTPS: true } },
      Web: { [`${dns}:9443`]: { Handlers: { '/': { Proxy: target } } } },
    });
    // A new unrelated configuration on 9443 must not be modified when selecting 443.
    expect((await h.access.start(443)).state).toBe('serving');
    expect(h.launch).toHaveBeenLastCalledWith('/safe/tailscale', ['serve', '--https=443', h.target]);
    expect(h.run.mock.calls.every(([, args]) => args.includes('--json'))).toBe(true);
  });

  it('detects absent and disconnected installations without launching or configuring anything', async () => {
    const missing = harness({ missing: true });
    expect((await missing.access.start()).state).toBe('unavailable');
    expect(missing.run).not.toHaveBeenCalled();
    const stopped = harness({ backend: 'Stopped' });
    expect((await stopped.access.start()).state).toBe('disconnected');
    expect(stopped.launch).not.toHaveBeenCalled();
  });

  it('includes only a sanitized optional version and distinguishes an unreachable daemon', async () => {
    const h = harness();
    h.run.mockResolvedValueOnce(
      JSON.stringify({ BackendState: 'Running', Version: '1.88.4-t123+abc', Self: { DNSName: dns } }),
    );
    expect((await h.access.status()).version).toBe('1.88.4-t123+abc');
    h.run.mockResolvedValueOnce(
      JSON.stringify({ BackendState: 'Running', Version: 'SECRET stderr\npeer list', Self: { DNSName: dns } }),
    );
    expect((await h.access.status()).version).toBeUndefined();
    h.run.mockRejectedValue(new RemoteAccessCommandError('unavailable'));
    expect(await h.access.status()).toMatchObject({
      state: 'disconnected',
      message: 'Tailscale is installed but its daemon is unreachable. Open Tailscale and connect first.',
    });
  });

  it.each([8443, 9443])(
    'detects a retained owned mapping on %i after foreground shutdown without blindly deleting it',
    async (port) => {
      const h = harness();
      await h.access.start(port);
      h.kill.mockImplementation(() => undefined);
      const result = await h.access.stop();
      expect(result.state).toBe('error');
      expect(result.message).toContain(`retained the previous remote access mapping on port ${port}`);
      expect(result.port).toBe(port);
      expect(h.run.mock.calls.every(([, args]) => args.includes('--json'))).toBe(true);
      await expect(fetch(h.target)).rejects.toThrow();
    },
  );

  it('identifies the macOS GUI-mode response without blaming tailnet approval', async () => {
    const h = harness();
    h.run.mockResolvedValueOnce('The Tailscale GUI failed to start: private OS text and diagnostic.');
    const result = await h.access.status();
    expect(result).toMatchObject({ state: 'error', issue: 'status-failed', diagnostic: 'status: cli-mode' });
    expect(result.message).toContain('integration issue');
    expect(result.message).toContain('approvals do not need to be changed');
    expect(result.message).not.toContain('private OS text');
    expect(h.launch).not.toHaveBeenCalled();
  });

  it('status is read-only and sanitizes DNS and all peer data', async () => {
    const h = harness();
    expect(await h.access.status()).toEqual({ port: 8443, state: 'available', dnsName: dns });
    expect(h.launch).not.toHaveBeenCalled();
    expect(h.run.mock.calls.map((call) => call[1])).toEqual([
      ['status', '--json'],
      ['serve', 'status', '--json'],
    ]);
    h.run.mockResolvedValue(
      JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'https://evil.ts.net/?secret' } }),
    );
    expect((await h.access.start()).state).toBe('error');
    expect(h.launch).not.toHaveBeenCalled();
  });

  it.each([
    { TCP: { '8443': { TCPForward: 'localhost:80' } } },
    { Web: { [`${dns}:8443`]: { Handlers: {} } } },
    { AllowFunnel: { [`${dns}:8443`]: true } },
    { Foreground: { other: { TCP: { '8443': { HTTPS: true } } } } },
  ])('refuses existing 8443 configuration without modification: %j', async (conflict) => {
    const h = harness({ conflict });
    expect((await h.access.start()).message).toContain('already configured');
    expect(h.launch).not.toHaveBeenCalled();
    expect(h.run.mock.calls.every(([, args]) => args.includes('--json'))).toBe(true);
  });

  it('bounds pending HTTPS consent, terminates its process, and gives safe guidance', async () => {
    const h = harness({ pending: true, stubborn: true });
    const result = await h.access.start();
    expect(result.state).toBe('error');
    expect(result.message).toContain('enable HTTPS');
    expect(h.kill.mock.calls.map(([signal]) => signal)).toEqual(['SIGINT', 'SIGKILL']);
    await expect(fetch(h.target)).rejects.toThrow();
  });

  it('never reports serving for Funnel, HTTP or a different target', async () => {
    for (const kind of ['funnel', 'http', 'target']) {
      const h = harness({ pending: true });
      h.launch.mockImplementationOnce((_file, args) => {
        h.setConfig({
          TCP: { '8443': { HTTPS: kind !== 'http' } },
          Web: {
            [`${dns}:8443`]: { Handlers: { '/': { Proxy: kind === 'target' ? 'http://127.0.0.1:1' : args[2] } } },
          },
          AllowFunnel: { [`${dns}:8443`]: kind === 'funnel' },
        });
        return { exited: new Promise(() => undefined), kill: vi.fn() };
      });
      expect((await h.access.start()).state).toBe('error');
    }
  });

  it('clears a serving process on exit and closes its private gateway', async () => {
    const h = harness();
    await h.access.start();
    const target = h.target;
    h.exit();
    await Promise.resolve();
    expect((await h.access.status()).state).not.toBe('serving');
    await expect(fetch(target)).rejects.toThrow();
  });

  it('does not delete a mapping changed by someone else', async () => {
    const h = harness();
    await h.access.start();
    h.setConfig({ TCP: { '8443': { TCPForward: 'localhost:7777' } } });
    expect((await h.access.status()).state).toBe('error');
    expect(h.run.mock.calls.every(([, args]) => args.includes('--json'))).toBe(true);
    expect(h.kill).toHaveBeenCalledWith('SIGINT');
  });

  it('serializes concurrent starts and cancels queued starts on stop/dispose', async () => {
    const h = harness();
    const results = await Promise.all([h.access.start(), h.access.start()]);
    expect(results.map((result) => result.state)).toEqual(['serving', 'serving']);
    expect(h.launch).toHaveBeenCalledTimes(1);
    await h.access.stop();
    const start = h.access.start();
    const stop = h.access.stop();
    await Promise.all([start, stop]);
    expect(h.launch).toHaveBeenCalledTimes(1);
    await h.access.dispose();
    await h.access.dispose();
    expect((await h.access.start()).state).toBe('unavailable');
  });

  it('cancels an active pending start and does not leak subprocess errors', async () => {
    const h = harness({ pending: true });
    const starting = h.access.start();
    while (!h.launch.mock.calls.length) await new Promise((resolve) => setTimeout(resolve, 1));
    const calls = h.run.mock.calls.length;
    await expect(h.access.start(9443)).rejects.toThrow('Stop');
    expect(h.run).toHaveBeenCalledTimes(calls);
    expect(h.kill).not.toHaveBeenCalled();
    await h.access.stop();
    expect((await starting).state).not.toBe('serving');
    expect(h.kill).toHaveBeenCalledTimes(1);
    h.run.mockRejectedValue(new Error('SECRET stderr peer list'));
    expect(JSON.stringify(await h.access.status())).not.toContain('SECRET');
  });
});

describe('authenticated phone gateway integration', () => {
  it('starts only explicitly, forwards pairing operations and closes on stop', async () => {
    let pairing: { code: string; url: string; expiresAt: number } | undefined;
    const gateway: RemoteAccessGateway = {
      listen: vi.fn(async () => 'http://127.0.0.1:45678'),
      close: vi.fn(async () => {
        pairing = undefined;
      }),
      status: () => ({ pairing, requests: [], devices: [] }),
      beginPairing: vi.fn(() => (pairing = { code: '123456', url: `https://${dns}:8443/pair`, expiresAt: 123 })),
      approve: vi.fn(),
      reject: vi.fn(),
      revoke: vi.fn(),
    };
    const { access, deps } = harness({ gateway });
    await access.status();
    expect(gateway.listen).not.toHaveBeenCalled();
    await expect(access.beginPairing()).rejects.toThrow('not serving');
    expect((await access.start()).state).toBe('serving');
    expect(deps.gatewayFactory).toHaveBeenCalledWith(
      expect.objectContaining({ rendererRoot: '/production', publicOrigin: `https://${dns}:8443` }),
    );
    expect((await access.beginPairing()).pairing?.code).toBe('123456');
    await access.approvePairing('opaque-id');
    await access.rejectPairing('opaque-id');
    await access.revokeDevice('opaque-id');
    expect(gateway.approve).toHaveBeenCalledWith('opaque-id');
    expect(gateway.reject).toHaveBeenCalledWith('opaque-id');
    expect(gateway.revoke).toHaveBeenCalledWith('opaque-id');
    await expect(access.revokeDevice('--bad id')).rejects.toThrow('Invalid');
    const stopped = await access.stop();
    expect(stopped.pairing).toBeUndefined();
    expect(gateway.close).toHaveBeenCalledOnce();
    await expect(access.beginPairing()).rejects.toThrow('not serving');
  });
});

describe('guided prerequisites and sanitized diagnostics', () => {
  it('blocks an explicit missing HTTPS certificate before opening any gateway or publishing', async () => {
    const gateway = { listen: vi.fn(), close: vi.fn() } as unknown as RemoteAccessGateway;
    const h = harness({ gateway });
    h.run.mockImplementation(async (_file, args) =>
      args[0] === 'status'
        ? JSON.stringify({ BackendState: 'Running', Self: { DNSName: dns }, CertDomains: [] })
        : '{}',
    );
    expect(await h.access.status()).toMatchObject({
      state: 'available',
      issue: 'https-required',
      setupAction: 'https',
    });
    expect(await h.access.start()).toMatchObject({ state: 'available', issue: 'https-required' });
    expect(gateway.listen).not.toHaveBeenCalled();
    expect(h.deps.gatewayFactory).not.toHaveBeenCalled();
    expect(h.launch).not.toHaveBeenCalled();
    expect(h.run.mock.calls.every(([, args]) => args.includes('--json'))).toBe(true);
  });

  it('permits an explicit matching HTTPS certificate and preserves legacy missing CertDomains', async () => {
    const h = harness();
    const original = h.run.getMockImplementation()!;
    h.run.mockImplementation(async (file, args) =>
      args[0] === 'status'
        ? JSON.stringify({ BackendState: 'Running', Self: { DNSName: dns }, CertDomains: [dns] })
        : original(file, args),
    );
    expect((await h.access.start()).state).toBe('serving');
    expect(h.launch).toHaveBeenCalledOnce();
  });

  it('explains NeedsLogin without launching', async () => {
    const h = harness({ backend: 'NeedsLogin' });
    expect(await h.access.start()).toMatchObject({
      state: 'disconnected',
      issue: 'connection-required',
      setupAction: 'tailscale',
      message: expect.stringContaining('Sign in'),
    });
    expect(h.launch).not.toHaveBeenCalled();
  });

  it.each(['', 'SECRET peer list', 'null', '[]', '{}'])('labels invalid status data safely: %s', async (data) => {
    const h = harness();
    h.run.mockResolvedValueOnce(data);
    const result = await h.access.status();
    expect(result).toMatchObject({ issue: 'status-failed', diagnostic: 'status: invalid-json' });
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });

  it.each(['', 'SECRET peer list', 'null', '[]'])('labels invalid Serve data separately: %s', async (data) => {
    const h = harness();
    h.run.mockResolvedValueOnce(JSON.stringify({ BackendState: 'Running' })).mockResolvedValueOnce(data);
    const result = await h.access.status();
    expect(result).toMatchObject({
      issue: 'status-failed',
      diagnostic: 'serve-status: invalid-json',
      message: expect.stringContaining('Serve status'),
    });
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });

  it('accepts an empty Serve object but not empty main status', async () => {
    const h = harness();
    expect((await h.access.status()).state).toBe('available');
  });

  it('maps native timeouts and permission failures without leaking raw stderr or paths', async () => {
    const h = harness();
    h.run.mockRejectedValueOnce(
      RemoteAccessCommandError.from({ killed: true, code: 'ETIMEDOUT' }, 'SECRET /private/key token'),
    );
    expect(await h.access.status()).toMatchObject({
      issue: 'status-failed',
      diagnostic: 'status: command-timeout',
      message: expect.stringContaining('timed out'),
    });
    h.run.mockRejectedValueOnce(
      RemoteAccessCommandError.from({ code: 1 }, 'permission denied SECRET /private/key token'),
    );
    const result = await h.access.status();
    expect(result).toMatchObject({ issue: 'permission-denied', diagnostic: 'status: command-permission (exit 1)' });
    expect(JSON.stringify(result)).not.toMatch(/SECRET|private|token/);
    expect(RemoteAccessCommandError.from({ code: 'ENOENT' }).kind).toBe('unavailable');
    expect(RemoteAccessCommandError.from({ code: 'EACCES' }).kind).toBe('permission');
    expect(RemoteAccessCommandError.from({ code: 2 }).diagnostic).toBe('command-failed (exit 2)');
  });

  it('identifies missing gateway assets instead of blaming Tailscale', async () => {
    const gateway = {
      listen: vi.fn().mockRejectedValue(Object.assign(new Error('SECRET /missing/assets'), { code: 'ENOENT' })),
      close: vi.fn(),
    } as unknown as RemoteAccessGateway;
    const h = harness({ gateway });
    const result = await h.access.start();
    expect(result).toMatchObject({ issue: 'assets-missing', diagnostic: 'gateway: assets-missing' });
    expect(JSON.stringify(result)).not.toContain('SECRET');
    expect(h.launch).not.toHaveBeenCalled();
  });

  it('captures consent privately and only exposes an explicitly validated setup URL', async () => {
    const h = harness({ pending: true });
    h.launch.mockReturnValueOnce({
      exited: new Promise(() => undefined),
      kill: vi.fn(),
      output: () => 'SECRET https://login.tailscale.com/f/serve?node=abc123',
    });
    const result = await h.access.start();
    expect(result).toMatchObject({ issue: 'approval-required', setupAction: 'authorize' });
    expect(JSON.stringify(result)).not.toMatch(/SECRET|abc123|login.tailscale.com/);
    expect(h.access.setupUrl()).toBe('https://login.tailscale.com/f/serve?node=abc123');
  });

  it.each([
    'https://evil.example/f/serve',
    'http://login.tailscale.com/f/serve',
    'https://login.tailscale.com.evil.example/f/serve',
    'https://user:pass@login.tailscale.com/f/serve',
    'https://login.tailscale.com:444/f/serve',
    'https://login.tailscale.com/other',
    'https://login.tailscale.com/f/serve#secret',
  ])('rejects untrusted consent URLs: %s', (url) => {
    expect(tailscaleApprovalUrl(url)).toBeUndefined();
  });

  it.each([
    ['permission denied SECRET', 'permission-denied'],
    ['failed to connect to daemon SECRET', 'connection-required'],
    ['HTTPS is not enabled SECRET', 'https-required'],
    ['address already in use SECRET', 'port-in-use'],
  ])('classifies private foreground failures: %s', async (output, issue) => {
    const h = harness({ pending: true });
    h.launch.mockReturnValueOnce({ exited: new Promise(() => undefined), kill: vi.fn(), output: () => output });
    const result = await h.access.start();
    expect(result.issue).toBe(issue);
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });

  it('does not make arbitrary external output actionable or leak it', async () => {
    const h = harness({ pending: true });
    h.launch.mockReturnValueOnce({
      exited: new Promise(() => undefined),
      kill: vi.fn(),
      output: () => 'SECRET https://evil.example/f/serve',
    });
    const result = await h.access.start();
    expect(h.access.setupUrl()).toBeUndefined();
    expect(result.issue).toBe('start-failed');
    expect(JSON.stringify(result)).not.toMatch(/SECRET|evil.example/);
  });
});
