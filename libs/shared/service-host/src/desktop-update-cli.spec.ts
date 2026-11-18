import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { finishDesktopUpdate, type DesktopUpdatePlan } from './desktop-update-cli';
import { desktopAsset } from './desktop-cli';
import type { HostDiscovery } from './discovery';
import { runCli, type CliContext } from './service-cli';
import type { ServiceManager } from './service-registration';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});
const io = () => ({ out: vi.fn(), err: vi.fn() });

async function world(badHash = false, target = 'darwin-arm64') {
  const dir = await mkdtemp(join(tmpdir(), 'pk-desktop-cli-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, 'pi-kit.app');
  await mkdir(root);
  await writeFile(join(root, 'original'), 'signed original bundle');
  const archive = Buffer.from('a fake zip: staging is tested independently');
  const asset = desktopAsset(target, '2.0.0')!;
  const file = asset.file;
  const hash = createHash('sha512')
    .update(badHash ? 'wrong archive' : archive)
    .digest('base64');
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(req.url!);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    if (req.url === '/latest')
      return res.end(
        JSON.stringify({
          tag_name: 'v2.0.0',
          assets: [
            { name: file, browser_download_url: `${base}/archive` },
            { name: asset.manifest, browser_download_url: `${base}/manifest` },
          ],
        }),
      );
    if (req.url === '/archive') return res.end(archive);
    if (req.url === '/manifest') return res.end(`version: 2.0.0\nfiles:\n  - url: ${file}\n    sha512: ${hash}\n`);
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise((resolve) => server.close(resolve)));
  const stage = vi.fn(async () => ({ replace: vi.fn(), cleanup: vi.fn() }));
  const ctx: CliContext = {
    version: '1.0.0',
    serviceName: 'test',
    dataDir: dir,
    logDir: dir,
    manager: undefined,
    discover: () => undefined,
    connect: async () => {
      throw new Error('no host');
    },
    tail: () => undefined,
    sleep: async () => undefined,
    desktopUpdate: {
      root,
      target,
      hostInstall: target.startsWith('linux-')
        ? root
        : target.startsWith('win32-')
          ? join(root, 'resources')
          : undefined,
      releases: `http://127.0.0.1:${(server.address() as AddressInfo).port}/latest`,
      version: () => '1.0.0',
      stage,
    },
  };
  const plans: DesktopUpdatePlan[] = [];
  ctx.startDesktopFinisher = (plan) => {
    plans.push(plan);
    cleanup.push(() => rm(plan.staging, { recursive: true, force: true }));
  };
  return { ctx, root, requests, plans, stage, archive };
}

function background(ctx: CliContext, steps: string[], attached = false, restartedVersion = '2.0.0') {
  const initial: HostDiscovery = {
    pid: 1,
    version: '1.0.0',
    level: 'login',
    socket: 's',
    token: 't',
    startedAt: 'now',
    install: ctx.desktopUpdate!.hostInstall ?? join(ctx.desktopUpdate!.root, 'Contents', 'Resources'),
  };
  let running: HostDiscovery | undefined = initial;
  ctx.discover = () => running;
  ctx.connect = async () =>
    ({
      call: async (method: string, action?: string) => {
        steps.push(action ? `${method}:${action}` : method);
        if (method === 'status') return { desktopAttached: attached };
        if (method === 'stop') {
          running = undefined;
          return {};
        }
        if (method === 'app-update') return { available: true, version: '2.0.0', downloaded: action !== 'check' };
        throw new Error(`unexpected RPC ${method}`);
      },
      close: () => undefined,
    }) as never;
  ctx.manager = {
    installed: () => true,
    start: async () => {
      steps.push('start');
      running = { ...initial, pid: 2, version: restartedVersion };
    },
  } as ServiceManager;
}

async function planFor(ctx: CliContext): Promise<DesktopUpdatePlan> {
  const staging = join(ctx.dataDir, 'staging');
  await mkdir(staging);
  const archive = join(staging, 'update.zip');
  await writeFile(archive, 'verified download');
  return { archive, version: '2.0.0', staging, log: join(ctx.logDir, 'update.log') };
}

describe('macOS desktop pi-kit update', () => {
  it('--check reads only the release feed and never downloads, stages or hands off', async () => {
    const { ctx, root, requests, plans, stage } = await world();
    const output = io();
    expect(await runCli(['update', '--check'], output, ctx)).toBe(0);
    expect(requests).toEqual(['/latest']);
    expect(output.out).toHaveBeenCalledWith(expect.stringContaining('2.0.0 is available'));
    expect(plans).toEqual([]);
    expect(stage).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual(['original']);
  });

  it.each(['linux-x64', 'linux-arm64', 'win32-x64', 'win32-arm64'])(
    'uses the correct verified desktop asset and install identity for %s',
    async (target) => {
      const { ctx, requests, plans } = await world(false, target);
      background(ctx, []);
      expect(await runCli(['update'], io(), ctx)).toBe(0);
      expect(requests).toEqual(['/latest', '/archive', '/manifest']);
      expect(plans).toHaveLength(1);
      expect(plans[0].archive).toContain(desktopAsset(target, '2.0.0')!.file);
      expect(plans[0].sha512).toMatch(/^[A-Za-z0-9+/]{86}==$/);
    },
  );

  it.each([false, true])(
    'fails before download/stop when write/admin access is missing (desktop attached: %s)',
    async (attached) => {
      const { ctx, requests, plans } = await world();
      const steps: string[] = [];
      background(ctx, steps, attached);
      ctx.desktopUpdate!.preflight = () => {
        throw new Error('Administrator/write permission required; no automatic elevation.');
      };
      const output = io();
      expect(await runCli(['update'], output, ctx)).toBe(1);
      expect(plans).toEqual([]);
      expect(steps).not.toContain('stop');
      expect(steps).not.toContain('app-update:download');
      expect(requests).toEqual(attached ? [] : ['/latest']);
      expect(output.err).toHaveBeenCalledWith(expect.stringContaining('permission required'));
    },
  );

  it('verifies the manifest SHA512 before detached handoff, leaving the original app and service alone', async () => {
    const { ctx, root, requests, plans, stage, archive } = await world();
    const steps: string[] = [];
    background(ctx, steps);
    expect(await runCli(['update'], io(), ctx)).toBe(0);
    expect(requests).toEqual(['/latest', '/archive', '/manifest']);
    expect(plans).toHaveLength(1);
    expect(await readFile(plans[0].archive)).toEqual(archive);
    expect(plans[0]).toMatchObject({ version: '2.0.0', log: join(ctx.logDir, 'desktop-update.log') });
    expect(steps).toEqual(['status']);
    expect(stage).not.toHaveBeenCalled();
    expect(await readFile(join(root, 'original'), 'utf8')).toBe('signed original bundle');
    expect(existsSync(`${root}.previous`)).toBe(false);
  });

  it('removes the downloaded staging directory on hash mismatch without touching the app', async () => {
    const { ctx, root, plans, stage } = await world(true);
    const before = (await readdir(tmpdir())).filter((name) => name.startsWith('pi-kit-desktop-update-'));
    const output = io();
    expect(await runCli(['update'], output, ctx)).toBe(1);
    expect(output.err).toHaveBeenCalledWith(expect.stringContaining('does not match latest-mac.yml'));
    expect(plans).toEqual([]);
    expect(stage).not.toHaveBeenCalled();
    expect((await readdir(tmpdir())).filter((name) => name.startsWith('pi-kit-desktop-update-'))).toEqual(before);
    expect(await readdir(root)).toEqual(['original']);
  });

  it('cleans up the verified archive when detached finisher spawning rejects', async () => {
    const { ctx, root, stage } = await world();
    let handedOff: DesktopUpdatePlan | undefined;
    ctx.startDesktopFinisher = async (plan) => {
      handedOff = plan;
      expect(existsSync(plan.archive)).toBe(true);
      throw new Error('finisher spawn failed');
    };
    const output = io();
    expect(await runCli(['update'], output, ctx)).toBe(1);
    expect(output.err).toHaveBeenCalledWith(expect.stringContaining('finisher spawn failed'));
    expect(handedOff).toBeDefined();
    expect(existsSync(handedOff!.staging)).toBe(false);
    expect(stage).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual(['original']);
  });

  it('gives an actionable error when an older attached host lacks the native updater RPC', async () => {
    const { ctx, requests, plans } = await world();
    background(ctx, [], true);
    const close = vi.fn();
    ctx.connect = async () =>
      ({
        call: async (method: string) => {
          if (method === 'status') return { desktopAttached: true };
          throw new Error('Unknown method: app-update');
        },
        close,
      }) as never;
    const output = io();
    expect(await runCli(['update'], output, ctx)).toBe(1);
    expect(output.err.mock.calls.flat().join('')).toMatch(/close.*(?:desktop|app)|(?:Settings|restart|relaunch)/i);
    expect(close).toHaveBeenCalledOnce();
    expect(requests).toEqual([]);
    expect(plans).toEqual([]);
  });

  it('discards an obsolete scheduled update without staging or stopping the service', async () => {
    const { ctx, stage } = await world();
    const steps: string[] = [];
    background(ctx, steps);
    ctx.desktopUpdate!.version = () => '2.0.0';
    const plan = await planFor(ctx);
    expect(await finishDesktopUpdate(plan, io(), ctx)).toBe(0);
    expect(stage).not.toHaveBeenCalled();
    expect(steps).toEqual([]);
    expect(existsSync(plan.staging)).toBe(false);
  });

  it.each([true, false])('uses native desktop RPC when attached (check only: %s)', async (check) => {
    const { ctx, requests, plans, stage } = await world();
    const steps: string[] = [];
    background(ctx, steps, true);
    expect(await runCli(check ? ['update', '--check'] : ['update'], io(), ctx)).toBe(0);
    expect(steps).toEqual(
      check
        ? ['status', 'app-update:check']
        : ['status', 'app-update:check', 'app-update:download', 'app-update:install'],
    );
    expect(requests).toEqual([]);
    expect(plans).toEqual([]);
    expect(stage).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'stages and verifies before stopping, and restarts after replacement (failure: %s)',
    async (fails) => {
      const { ctx, stage } = await world();
      const steps: string[] = [];
      background(ctx, steps, false, fails ? '1.0.0' : '2.0.0');
      const plan = await planFor(ctx);
      stage.mockImplementation(async () => {
        steps.push('stage and verify');
        expect(existsSync(plan.archive)).toBe(true);
        return {
          replace: vi.fn(() => {
            steps.push('replace');
            if (fails) throw new Error('replacement failed; rolled back');
          }),
          cleanup: vi.fn(() => {
            steps.push('cleanup');
          }),
        };
      });
      const output = io();
      expect(await finishDesktopUpdate(plan, output, ctx)).toBe(fails ? 1 : 0);
      expect(steps).toEqual(['stage and verify', 'status', 'stop', 'replace', 'start', 'cleanup']);
      expect(ctx.discover()).toMatchObject({ pid: 2 });
      expect(existsSync(plan.staging)).toBe(false);
      if (fails) expect(output.err).toHaveBeenCalledWith(expect.stringContaining('rolled back'));
    },
  );

  it('restores the prior app and restarts it when the updated service cannot start', async () => {
    const { ctx, stage } = await world();
    const steps: string[] = [];
    background(ctx, steps, false, '1.0.0');
    const originalStart = ctx.manager!.start.bind(ctx.manager);
    const staged = { replace: vi.fn(), rollback: vi.fn(), cleanup: vi.fn() };
    stage.mockResolvedValue(staged);
    let starts = 0;
    ctx.restartDesktopService = async () => {
      if (++starts === 1) throw new Error('new service failed');
      await originalStart();
    };
    const output = io();
    expect(await finishDesktopUpdate(await planFor(ctx), output, ctx)).toBe(1);
    expect(staged.rollback).toHaveBeenCalledOnce();
    expect(starts).toBe(2);
    expect(ctx.discover()).toMatchObject({ pid: 2 });
    expect(staged.cleanup).toHaveBeenCalledOnce();
  });

  it('does not stop a service whose privileged restart cannot be authorized', async () => {
    const { ctx, stage } = await world();
    const steps: string[] = [];
    background(ctx, steps);
    const staged = { replace: vi.fn(), cleanup: vi.fn() };
    stage.mockResolvedValue(staged);
    ctx.prepareDesktopServiceRestart = () => {
      throw new Error('sudo authorization required');
    };
    const output = io();
    expect(await finishDesktopUpdate(await planFor(ctx), output, ctx)).toBe(1);
    expect(steps).toEqual(['status']);
    expect(ctx.discover()).toMatchObject({ pid: 1 });
    expect(staged.replace).not.toHaveBeenCalled();
    expect(staged.cleanup).toHaveBeenCalledOnce();
    expect(output.err).toHaveBeenCalledWith(expect.stringContaining('sudo authorization required'));
  });

  it('refuses to update a different install that owns the profile', async () => {
    const { ctx, requests, plans } = await world();
    background(ctx, []);
    const running = ctx.discover()!;
    ctx.discover = () => ({ ...running, install: '/another/pi-kit.app/Contents/Resources' });
    const output = io();
    expect(await runCli(['update'], output, ctx)).toBe(1);
    expect(requests).toEqual([]);
    expect(plans).toEqual([]);
    expect(output.err).toHaveBeenCalledWith(expect.stringContaining('another pi-kit install'));
  });

  it('rechecks the handed-off checksum before staging or stopping anything', async () => {
    const { ctx, stage } = await world();
    const steps: string[] = [];
    background(ctx, steps);
    const plan = await planFor(ctx);
    plan.sha512 = createHash('sha512')
      .update(await readFile(plan.archive))
      .digest('base64');
    await writeFile(plan.archive, 'changed download');
    const output = io();
    expect(await finishDesktopUpdate(plan, output, ctx)).toBe(1);
    expect(stage).not.toHaveBeenCalled();
    expect(steps).toEqual([]);
    expect(output.err).toHaveBeenCalledWith(expect.stringContaining('changed after verification'));
  });

  it('never stops the service when staging/signature verification fails', async () => {
    const { ctx, stage } = await world();
    const steps: string[] = [];
    background(ctx, steps);
    const plan = await planFor(ctx);
    stage.mockRejectedValue(new Error('signature rejected'));
    expect(await finishDesktopUpdate(plan, io(), ctx)).toBe(1);
    expect(steps).toEqual([]);
    expect(ctx.discover()).toMatchObject({ pid: 1 });
    expect(existsSync(plan.staging)).toBe(false);
  });
});
