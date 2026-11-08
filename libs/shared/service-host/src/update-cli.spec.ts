import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { HostDiscovery } from './discovery';
import { type CliContext, runCli } from './service-cli';
import type { ServiceManager } from './service-registration';
import { type FinishPlan, finishWindowsUpdate, type NpmUpdate } from './update-cli';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

const TARGET = 'linux-x64';

/** A server install of 1.0.0, and a release feed whose 2.0.0 archive for the target is real; `sums` overrides its SHA256SUMS. */
async function world(sums?: string, target = TARGET) {
  const dir = await mkdtemp(join(tmpdir(), 'pk-update-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, 'pi-kit-server');
  await mkdir(join(root, 'backend'), { recursive: true });
  await writeFile(join(root, 'package.json'), '{"version":"1.0.0"}');

  const name = `pi-kit-server-2.0.0-${target}`;
  // Windows' archive is a zip; `tar -xf` reads either, so a gzipped tar stands in for it here.
  const file = `${name}${target.startsWith('win32-') ? '.zip' : '.tar.gz'}`;
  await mkdir(join(dir, 'release', name, 'backend'), { recursive: true });
  await writeFile(join(dir, 'release', name, 'backend', 'service-host.cjs'), '');
  await writeFile(join(dir, 'release', name, 'package.json'), '{"version":"2.0.0"}');
  execFileSync('tar', ['-czf', join(dir, file), '-C', join(dir, 'release'), name]);
  const archive = await readFile(join(dir, file));
  const hash = createHash('sha256').update(archive).digest('hex');

  const server = createServer((req, res) => {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    if (req.url === '/latest')
      return res.end(
        JSON.stringify({
          tag_name: 'v2.0.0',
          assets: [
            { name: file, browser_download_url: `${base}/archive` },
            { name: 'SHA256SUMS', browser_download_url: `${base}/sums` },
          ],
        }),
      );
    if (req.url === '/archive') return res.end(archive);
    if (req.url === '/sums') return res.end(sums ?? `${hash}  ${file}\n`);
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise((resolve) => server.close(resolve)));
  const releases = `http://127.0.0.1:${(server.address() as AddressInfo).port}/latest`;
  return { root, install: { root, version: '1.0.0', target, releases } };
}

function context(install: CliContext['serverInstall'], running?: HostDiscovery): CliContext {
  return {
    version: '1.0.0',
    serviceName: 'test',
    dataDir: tmpdir(),
    logDir: tmpdir(),
    manager: undefined,
    discover: () => running,
    connect: async () => {
      throw new Error('no host');
    },
    tail: () => undefined,
    sleep: async () => undefined,
    serverInstall: install,
  };
}

/** An npm install of 1.0.0 under `modules` with its service running, and an npm that serves `served`. */
function npmInstall(target: string, modules: string, served: Record<string, string> = {}) {
  const host: HostDiscovery = { pid: 1, version: '1.0.0', level: 'login', socket: 's', token: 't', startedAt: 'now' };
  const steps: string[] = [];
  const sep = modules.includes('\\') ? '\\' : '/';
  const root = [modules, '@soverius-ai', 'pi-kit', 'node_modules', '@soverius-ai', `pi-kit-${target}`].join(sep);
  let running: HostDiscovery | undefined = host;
  const registry: Record<string, string> = Object.keys(served).length
    ? served
    : { '@soverius-ai/pi-kit': '2.0.0', [`@soverius-ai/pi-kit-${target}@2.0.0`]: '2.0.0' };
  const ctx: CliContext = {
    ...context({ root, version: '1.0.0', target, releases: 'http://127.0.0.1:9/latest', npm: '@soverius-ai/pi-kit' }),
    discover: () => running,
    connect: async () =>
      ({ call: async () => void (steps.push('stop'), (running = undefined)), close: () => undefined }) as never,
    manager: {
      start: async () => void (steps.push('start'), (running = { ...host, pid: 2, version: '2.0.0' })),
    } as unknown as ServiceManager,
    npm: {
      view: (spec) => registry[spec],
      install: (prefix, spec) => (steps.push(`npm ${prefix} ${spec}`), true),
    },
  };
  return { ctx, steps };
}

const versionAt = async (root: string) => JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
const io = { out: () => undefined, err: () => undefined };

describe('pi-kit update', () => {
  it('swaps in the verified release at the same path and keeps the install it replaced', async () => {
    const { root, install } = await world();
    expect(await runCli(['update'], io, context(install))).toBe(0);
    expect(await versionAt(root)).toBe('2.0.0');
    expect(await versionAt(`${root}.previous`)).toBe('1.0.0');
  });

  it('changes nothing when the tarball does not match the release’s SHA256SUMS', async () => {
    const { root, install } = await world(`${'0'.repeat(64)}  pi-kit-server-2.0.0-${TARGET}.tar.gz\n`);
    expect(await runCli(['update'], io, context(install))).toBe(1);
    expect(await versionAt(root)).toBe('1.0.0');
    expect(existsSync(`${root}.previous`)).toBe(false);
  });

  it('updates an npm install with npm, under the prefix npm installed it in, with the service stopped meanwhile', async () => {
    const { ctx, steps } = npmInstall('linux-x64', '/opt/homebrew/lib/node_modules/@soverius-ai/pi-kit/node_modules');
    expect(await runCli(['update'], io, ctx)).toBe(0);
    expect(steps).toEqual(['stop', 'npm /opt/homebrew @soverius-ai/pi-kit@2.0.0', 'start']);
  });

  it('leaves an npm install as it is while npm has the new version but not yet this machine’s package of it', async () => {
    const { ctx, steps } = npmInstall('linux-x64', '/usr/lib/node_modules', { '@soverius-ai/pi-kit': '2.0.0' });
    const printed: string[] = [];
    const say = { out: (text: string) => void printed.push(text), err: (text: string) => void printed.push(text) };
    expect(await runCli(['update'], say, ctx)).toBe(1);
    expect(steps).toEqual([]);
    expect(printed.join('')).toContain('not yet @soverius-ai/pi-kit-linux-x64 2.0.0');
  });

  it('on Windows, leaves npm to the finisher, which runs it once this command has exited', async () => {
    const { ctx, steps } = npmInstall('win32-x64', 'C:\\Users\\ana\\AppData\\Roaming\\npm\\node_modules');
    const plans: FinishPlan[] = [];
    expect(await runCli(['update'], io, { ...ctx, startFinisher: (plan) => void plans.push(plan) })).toBe(0);
    expect(steps).toEqual(['stop']);
    expect(plans).toEqual([
      expect.objectContaining({
        npm: { prefix: 'C:\\Users\\ana\\AppData\\Roaming\\npm', spec: '@soverius-ai/pi-kit@2.0.0' },
        task: 'test',
      }),
    ]);
  });

  it('on Windows, verifies, unpacks and stops the service, then leaves the swap to a finisher', async () => {
    const { root, install } = await world(undefined, 'win32-x64');
    const host: HostDiscovery = { pid: 1, version: '1.0.0', level: 'login', socket: 's', token: 't', startedAt: 'now' };
    let stopped = false;
    const plans: FinishPlan[] = [];
    const ctx: CliContext = {
      ...context(install, host),
      discover: () => (stopped ? undefined : host),
      connect: async () => ({ call: async () => void (stopped = true), close: () => undefined }) as never,
      startFinisher: (plan) => void plans.push(plan),
    };
    expect(await runCli(['update'], io, ctx)).toBe(0);
    expect(stopped).toBe(true);
    expect(plans).toEqual([
      {
        parent: process.pid,
        install: root,
        unpacked: expect.stringMatching(/pi-kit-server-2\.0\.0-win32-x64$/),
        previous: `${root}.previous`,
        staging: expect.any(String),
        task: 'test',
        log: join(tmpdir(), 'update.log'),
      },
    ]);
    expect(await versionAt(root)).toBe('1.0.0');
    expect(await versionAt(plans[0].unpacked)).toBe('2.0.0');
  });

  it('changes nothing while "pi-kit serve" runs the profile', async () => {
    const { root, install } = await world();
    const serving: HostDiscovery = {
      pid: 1,
      version: '1.0.0',
      level: 'serve',
      socket: 's',
      token: 't',
      startedAt: 'now',
    };
    expect(await runCli(['update'], io, context(install, serving))).toBe(1);
    expect(await versionAt(root)).toBe('1.0.0');
  });
});

describe('the Windows finisher', () => {
  const plan: FinishPlan = {
    parent: 42,
    install: 'C:/pk',
    unpacked: 'C:/stage/pk-2',
    previous: 'C:/pk.previous',
    staging: 'C:/stage',
    task: 'pi-kit',
    log: 'C:/update.log',
  };
  function machine(options: { parentRuns: number; busy: number; failMoveIn?: boolean }) {
    const steps: string[] = [];
    let polls = 0;
    let busy = options.busy;
    return {
      steps,
      ops: {
        alive: () => polls++ < options.parentRuns,
        rename: (from: string, to: string) => {
          if (from === plan.install && busy-- > 0) throw new Error('EBUSY: resource busy or locked');
          if (from === plan.unpacked && options.failMoveIn) throw new Error('EPERM: operation not permitted');
          steps.push(`rename ${from} -> ${to}`);
        },
        remove: (path: string) => void steps.push(`remove ${path}`),
        npm: (update: NpmUpdate) => (steps.push(`npm ${update.prefix} ${update.spec}`), true),
        runTask: (name: string) => void steps.push(`run ${name}`),
        log: (line: string) => void steps.push(`log ${line.split(':')[0]}`),
        sleep: async () => void steps.push('wait'),
      },
    };
  }

  it('waits for the update command, retries an install Windows still holds, swaps it, and starts the service', async () => {
    const { steps, ops } = machine({ parentRuns: 3, busy: 2 });
    expect(await finishWindowsUpdate(plan, ops)).toBe(true);
    expect(steps).toEqual([
      ...['wait', 'wait', 'wait'],
      'remove C:/pk.previous',
      ...['wait', 'wait'],
      'rename C:/pk -> C:/pk.previous',
      'rename C:/stage/pk-2 -> C:/pk',
      'log updated C',
      'run pi-kit',
    ]);
  });

  it('for an npm install, runs npm once the update command has exited, then starts the service', async () => {
    const { steps, ops } = machine({ parentRuns: 2, busy: 0 });
    const npm: FinishPlan = {
      parent: 42,
      staging: 'C:/stage',
      task: 'pi-kit',
      log: 'C:/update.log',
      npm: { prefix: 'C:/npm', spec: 'pi-kit@2.0.0' },
    };
    expect(await finishWindowsUpdate(npm, ops)).toBe(true);
    expect(steps).toEqual(['wait', 'wait', 'npm C:/npm pi-kit@2.0.0', 'log npm installed pi-kit@2.0.0', 'run pi-kit']);
  });

  it('puts the old install back when the new one cannot move in, and still starts the service', async () => {
    const { steps, ops } = machine({ parentRuns: 0, busy: 0, failMoveIn: true });
    expect(await finishWindowsUpdate(plan, ops)).toBe(false);
    expect(steps).toEqual([
      'remove C:/pk.previous',
      'rename C:/pk -> C:/pk.previous',
      'rename C:/pk.previous -> C:/pk',
      'log nothing changed',
      'run pi-kit',
    ]);
  });
});
