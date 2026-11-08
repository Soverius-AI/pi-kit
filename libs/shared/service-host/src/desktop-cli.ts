import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { download, getRelease, getText } from './release-feed';
import type { CliContext, CliIo } from './service-cli';

export const DESKTOP_USAGE = `Desktop app:
  pi-kit desktop install            Download the pi-kit app of this server's version from its release, check it, install
                                    it for you and start it; it attaches to this server's service
`;

/** The installed pi-kit app on this computer, and how to install and start it there. */
export interface DesktopApp {
  /** Where the app is installed, when it is. */
  installed(): string | undefined;
  /** Installs the downloaded release file for this user only; returns where the app is. */
  install(file: string): Promise<string>;
  /** Starts the app, or brings its window forward; false where no window can open (SSH, no display). */
  start(app: string): boolean;
}

/** A target's app in a release, and the update manifest that lists its sha512 (the files the app's updater reads). */
export function desktopAsset(target: string, version: string): { file: string; manifest: string } | undefined {
  switch (target) {
    case 'darwin-arm64':
      return { file: `pi-kit-${version}-mac-arm64.zip`, manifest: 'latest-mac.yml' };
    case 'win32-x64':
    case 'win32-arm64':
      return { file: `pi-kit-${version}-win-${target.slice(6)}.exe`, manifest: 'latest.yml' };
    case 'linux-x64':
      return { file: `pi-kit-${version}-linux-x86_64.AppImage`, manifest: 'latest-linux.yml' };
    case 'linux-arm64':
      return { file: `pi-kit-${version}-linux-arm64.AppImage`, manifest: 'latest-linux-arm64.yml' };
    default:
      return undefined;
  }
}

/** The sha512 (base64) electron-builder's update manifest gives `file`, under its `- url:` entry. */
function manifestSha512(manifest: string, file: string): string | undefined {
  const lines = manifest.split(/\r?\n/);
  const at = lines.findIndex((line) => line.trim() === `- url: ${file}`);
  for (const line of at < 0 ? [] : lines.slice(at + 1)) {
    if (/^\s*- url:/.test(line) || /^\S/.test(line)) break;
    const sha512 = /^\s+sha512:\s*(\S+)/.exec(line)?.[1];
    if (sha512) return sha512;
  }
  return undefined;
}

/**
 * `pi-kit desktop install`: the release's app of this server's own version (so it attaches to this service rather than
 * taking it over), checked against the sha512 its updater trusts, installed for this user and started.
 */
export async function runDesktopCli(args: string[], io: CliIo, ctx: CliContext): Promise<number> {
  if (args.length !== 1 || args[0] !== 'install') {
    io.err(DESKTOP_USAGE);
    return 2;
  }
  const desktop = ctx.desktop;
  const installed = desktop?.installed();
  if (desktop && installed) {
    io.out(`The pi-kit app is already installed: ${installed}\n`);
    if (desktop.start(installed)) io.out('Started it.\n');
    return 0;
  }
  const install = ctx.serverInstall;
  const asset = install && desktopAsset(install.target, install.version);
  if (!desktop || !install) {
    io.err('pi-kit: "pi-kit desktop install" runs from a server install (npm, or a server archive).\n');
    return 2;
  }
  if (!asset) {
    io.err(`pi-kit: the releases have no pi-kit app for ${install.target}.\n`);
    return 1;
  }
  const release = await getRelease(install.releases.replace(/\/latest$/, `/tags/v${install.version}`));
  const file = release.assets.find((each) => each.name === asset.file);
  const manifest = release.assets.find((each) => each.name === asset.manifest);
  if (!file || !manifest) {
    io.err(`pi-kit: the ${install.version} release has no ${asset.file}.\n`);
    return 1;
  }
  const staging = mkdtempSync(join(tmpdir(), 'pi-kit-desktop-'));
  try {
    io.out(`Downloading ${asset.file}…\n`);
    const downloaded = join(staging, asset.file);
    await download(file.browser_download_url, downloaded);
    const expected = manifestSha512(await getText(manifest.browser_download_url), asset.file);
    if (!expected || createHash('sha512').update(readFileSync(downloaded)).digest('base64') !== expected) {
      io.err(`pi-kit: ${asset.file} does not match the release's ${asset.manifest}; nothing was installed.\n`);
      return 1;
    }
    const app = await desktop.install(downloaded);
    io.out(`Installed the pi-kit app ${install.version}: ${app}\n`);
    io.out(
      desktop.start(app)
        ? "Started it; it attaches to this server's service.\n"
        : 'Open it from your desktop, or run "pi-kit open" there.\n',
    );
    return 0;
  } finally {
    // Windows can hold the installer a moment after it exits (an antivirus scan): a leftover temp folder fails nothing.
    try {
      rmSync(staging, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    } catch {
      // The system's temp cleanup takes it.
    }
  }
}
