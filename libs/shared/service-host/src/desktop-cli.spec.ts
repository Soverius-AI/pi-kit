import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import type { DesktopApp } from './desktop-cli';
import { type CliContext, runCli } from './service-cli';

const servers: Server[] = [];
afterEach(() => servers.splice(0).forEach((server) => server.close()));

/** Release v1.2.3 as GitHub serves it: only by its tag, so a CLI that asked for "latest" would find nothing. */
async function release(files: Record<string, string>): Promise<string> {
  const server = createServer((req, res) => {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    if (req.url === '/releases/tags/v1.2.3')
      return res.end(
        JSON.stringify({
          tag_name: 'v1.2.3',
          assets: Object.keys(files).map((name) => ({ name, browser_download_url: `${base}/files/${name}` })),
        }),
      );
    const name = req.url?.replace('/files/', '') ?? '';
    if (name in files) return res.end(files[name]);
    res.writeHead(404).end();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/releases/latest`;
}

const sha512 = (text: string) => createHash('sha512').update(text).digest('base64');

// electron-builder's latest.yml lists both Windows installers.
const manifest = (arm64: string) => `version: 1.2.3
files:
  - url: pi-kit-1.2.3-win-x64.exe
    sha512: ${sha512('the x64 installer')}
    size: 17
  - url: pi-kit-1.2.3-win-arm64.exe
    sha512: ${arm64}
    size: 19
path: pi-kit-1.2.3-win-x64.exe
sha512: ${sha512('the x64 installer')}
`;

function context(releases: string, target = 'win32-arm64') {
  const done = { installed: '', started: 0 };
  const desktop: DesktopApp = {
    installed: () => undefined,
    install: async (file) => {
      done.installed = await readFile(file, 'utf8');
      return 'C:\\Users\\ana\\AppData\\Local\\Programs\\pi-kit\\pi-kit.exe';
    },
    start: () => (done.started++, true),
  };
  const ctx: CliContext = {
    version: '1.2.3',
    serviceName: 'test',
    dataDir: tmpdir(),
    logDir: tmpdir(),
    manager: undefined,
    discover: () => undefined,
    connect: async () => ({}) as never,
    tail: () => undefined,
    sleep: async () => undefined,
    serverInstall: { root: 'C:\\pi-kit-server', version: '1.2.3', target, releases },
    desktop,
  };
  return { ctx, done };
}

const io = (printed: string[]) => ({
  out: (text: string) => void printed.push(text),
  err: (text: string) => void printed.push(text),
});

describe('pi-kit desktop install', () => {
  it("installs and starts the app of the server's own version once it matches the release's manifest", async () => {
    const releases = await release({
      'pi-kit-1.2.3-win-arm64.exe': 'the arm64 installer',
      'latest.yml': manifest(sha512('the arm64 installer')),
    });
    const { ctx, done } = context(releases);
    const printed: string[] = [];
    expect(await runCli(['desktop', 'install'], io(printed), ctx)).toBe(0);
    expect(done).toEqual({ installed: 'the arm64 installer', started: 1 });
    expect(printed.join('')).toContain('Installed the pi-kit app 1.2.3');
  });

  it('installs nothing when the download is not what the manifest lists', async () => {
    const releases = await release({
      'pi-kit-1.2.3-win-arm64.exe': 'something else',
      'latest.yml': manifest(sha512('the arm64 installer')),
    });
    const { ctx, done } = context(releases);
    const printed: string[] = [];
    expect(await runCli(['desktop', 'install'], io(printed), ctx)).toBe(1);
    expect(done.installed).toBe('');
    expect(printed.join('')).toContain('does not match');
  });

  it('says so on a Mac with an Intel processor, which the releases have no app for', async () => {
    const { ctx, done } = context('http://127.0.0.1:9/releases/latest', 'darwin-x64');
    const printed: string[] = [];
    expect(await runCli(['desktop', 'install'], io(printed), ctx)).toBe(1);
    expect(done.installed).toBe('');
    expect(printed.join('')).toContain('no pi-kit app for darwin-x64');
  });
});

describe('pi-kit open', () => {
  it('starts the installed app rather than making a browser link, unless asked for the browser', async () => {
    const { ctx, done } = context('http://127.0.0.1:9/releases/latest');
    ctx.desktop = { ...ctx.desktop!, installed: () => '/Applications/pi-kit.app' };
    const printed: string[] = [];
    expect(await runCli(['open'], io(printed), ctx)).toBe(0);
    expect(done.started).toBe(1);
    // No host runs here, so the browser's link, which only a host makes, fails.
    expect(await runCli(['open', '--browser'], io(printed), ctx)).toBe(1);
    expect(done.started).toBe(1);
  });
});
