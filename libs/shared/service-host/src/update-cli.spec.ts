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

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

const TARGET = 'linux-x64';

/** A server install of 1.0.0, and a release feed whose 2.0.0 tarball for the target is real; `sums` overrides its SHA256SUMS. */
async function world(sums?: string) {
  const dir = await mkdtemp(join(tmpdir(), 'pk-update-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, 'pi-kit-server');
  await mkdir(join(root, 'backend'), { recursive: true });
  await writeFile(join(root, 'package.json'), '{"version":"1.0.0"}');

  const name = `pi-kit-server-2.0.0-${TARGET}`;
  await mkdir(join(dir, 'release', name, 'backend'), { recursive: true });
  await writeFile(join(dir, 'release', name, 'backend', 'service-host.cjs'), '');
  await writeFile(join(dir, 'release', name, 'package.json'), '{"version":"2.0.0"}');
  execFileSync('tar', ['-czf', join(dir, `${name}.tar.gz`), '-C', join(dir, 'release'), name]);
  const archive = await readFile(join(dir, `${name}.tar.gz`));
  const hash = createHash('sha256').update(archive).digest('hex');

  const server = createServer((req, res) => {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    if (req.url === '/latest')
      return res.end(
        JSON.stringify({
          tag_name: 'v2.0.0',
          assets: [
            { name: `${name}.tar.gz`, browser_download_url: `${base}/archive` },
            { name: 'SHA256SUMS', browser_download_url: `${base}/sums` },
          ],
        }),
      );
    if (req.url === '/archive') return res.end(archive);
    if (req.url === '/sums') return res.end(sums ?? `${hash}  ${name}.tar.gz\n`);
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise((resolve) => server.close(resolve)));
  const releases = `http://127.0.0.1:${(server.address() as AddressInfo).port}/latest`;
  return { root, install: { root, version: '1.0.0', target: TARGET, releases } };
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

  it('leaves an npm install to npm, and names its command when a release is newer', async () => {
    const { root, install } = await world();
    const printed: string[] = [];
    const npm = context({ ...install, npm: '@soverius-ai/pi-kit' });
    const say = { out: (text: string) => void printed.push(text), err: (text: string) => void printed.push(text) };
    expect(await runCli(['update'], say, npm)).toBe(2);
    expect(await versionAt(root)).toBe('1.0.0');
    expect(await runCli(['update', '--check'], say, npm)).toBe(0);
    expect(printed.join('')).toContain('npm install -g @soverius-ai/pi-kit@latest');
    expect(printed[printed.length - 1]).toBe('2.0.0 is available; run "npm install -g @soverius-ai/pi-kit@latest".\n');
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
