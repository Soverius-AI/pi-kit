import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({ execFile: vi.fn(), spawn: vi.fn() }));
vi.mock('node:child_process', () => native);
import { RemoteAccess, type RemoteAccessGateway } from './remote-access';

const gateway: RemoteAccessGateway = {
  listen: async () => 'http://127.0.0.1:60001',
  close: async () => undefined,
  approve: () => undefined,
  reject: () => undefined,
  revoke: () => undefined,
  beginPairing: () => ({
    code: 'ABCDEFGHJKLM',
    url: 'https://x.y.ts.net:8443/phone#ABCDEFGHJKLM',
    expiresAt: Date.now() + 60000,
  }),
  status: () => ({ requests: [], devices: [] }),
};
const options = { rendererRoot: '/production', backend: () => undefined };

const dns = 'fixture.example.ts.net';
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});

describe('Tailscale invocation from Finder', () => {
  it('forces CLI mode on real command adapters even when Finder supplies no SHLVL', async () => {
    vi.stubEnv('SHLVL', undefined);
    vi.stubEnv('TAILSCALE_BE_CLI', '0');
    native.execFile.mockImplementation(
      (_file: string, args: string[], _options: unknown, done: (error: null, out: string, err: string) => void) => {
        done(
          null,
          JSON.stringify(
            args[0] === 'status' ? { BackendState: 'Running', Self: { DNSName: dns }, CertDomains: [dns] } : {},
          ),
          '',
        );
      },
    );
    const access = new RemoteAccess({ findCli: async () => '/test/tailscale', gatewayFactory: () => gateway }, options);
    try {
      expect((await access.status()).state).toBe('available');
      expect(native.execFile).toHaveBeenCalledTimes(2);
      for (const [, , options] of native.execFile.mock.calls) {
        expect(options.env.TAILSCALE_BE_CLI).toBe('1');
        expect(options.env.SHLVL).toBeUndefined();
        expect(options.shell).toBe(false);
      }
      expect(process.env['TAILSCALE_BE_CLI']).toBe('0');
      expect(native.spawn).not.toHaveBeenCalled();
    } finally {
      await access.dispose();
    }
  });

  it('also forces CLI mode for foreground publication, not only status queries', async () => {
    vi.stubEnv('SHLVL', undefined);
    let config: unknown = {};
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(() => {
        config = {};
        child.emit('exit');
        return true;
      }),
    });
    native.spawn.mockImplementation((_file: string, args: string[]) => {
      config = {
        TCP: { '8443': { HTTPS: true } },
        Web: { [`${dns}:8443`]: { Handlers: { '/': { Proxy: args[2] } } } },
      };
      return child;
    });
    const access = new RemoteAccess(
      {
        gatewayFactory: () => gateway,
        findCli: async () => '/test/tailscale',
        run: async (_file, args) =>
          JSON.stringify(
            args[0] === 'status' ? { BackendState: 'Running', Self: { DNSName: dns }, CertDomains: [dns] } : config,
          ),
      },
      options,
    );
    try {
      expect((await access.start()).state).toBe('serving');
      expect(native.spawn).toHaveBeenCalledOnce();
      expect(native.spawn.mock.calls[0][2]).toMatchObject({ shell: false, env: { TAILSCALE_BE_CLI: '1' } });
      expect(native.spawn.mock.calls[0][2].env.SHLVL).toBeUndefined();
    } finally {
      await access.dispose();
    }
  });
});
