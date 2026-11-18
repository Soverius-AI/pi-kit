import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { stopHost, waitFor } from './cli-host';
import { desktopAsset, manifestSha512 } from './desktop-cli';
import { isNewerVersion, type HostDiscovery } from './discovery';
import type { HostStatus } from './host-protocol';
import { download, getRelease, getText } from './release-feed';
import type { CliContext, CliIo } from './service-cli';

export const FINISH_DESKTOP_UPDATE_FLAG = '--pi-kit-finish-desktop-update';

export interface DesktopUpdateOperations {
  version(): string | undefined;
  /** Fail before downloading or stopping anything if replacement needs privileges that are not available. */
  preflight?(): void | Promise<void>;
  stage(
    archive: string,
    version: string,
  ): Promise<{
    replace(): void;
    rollback?(): void;
    cleanup(): void;
  }>;
}

export interface DesktopUpdateInstall extends DesktopUpdateOperations {
  root: string;
  target: string;
  releases: string;
  /** The identity written into host discovery: macOS Resources, Windows resources, or the external AppImage path. */
  hostInstall?: string;
}

export interface DesktopUpdatePlan {
  archive: string;
  version: string;
  staging: string;
  log: string;
  /** Trusted digest from the release manifest, rechecked by external Windows finishers. */
  sha512?: string;
}

interface AppUpdateResult {
  available?: boolean;
  version?: string;
  downloaded?: boolean;
  unavailable?: string;
}

/** Do not replace a different install, a foreground host, or a service we cannot bring back. */
function checkHost(ctx: CliContext, install: DesktopUpdateInstall, host: HostDiscovery | undefined): void {
  if (!host) return;
  if (
    host.install &&
    resolve(host.install) !== resolve(install.hostInstall ?? join(install.root, 'Contents', 'Resources'))
  )
    throw new Error('another pi-kit install runs this profile; use its pi-kit command to update it.');
  if (host.level !== 'login')
    throw new Error('close the pi-kit app or stop "pi-kit serve", then run "pi-kit update" again.');
  if (!ctx.manager?.installed() && !ctx.bootManager?.installed())
    throw new Error('the running service has no registration to restart; nothing changed.');
}

/** The desktop already running has its native updater; use it without opening a window or stopping its backend early. */
async function attachedUpdate(check: boolean, io: CliIo, ctx: CliContext, host: HostDiscovery): Promise<boolean> {
  const peer = await ctx.connect(host);
  try {
    const status = await peer.call<HostStatus>('status');
    if (!status.desktopAttached) return false;
    const run = async (action: string) => {
      let result: AppUpdateResult;
      try {
        result = await peer.call<AppUpdateResult>('app-update', action);
      } catch (error) {
        if (error instanceof Error && /Unknown method.*app-update/.test(error.message))
          throw new Error(
            'The running app predates terminal updates. Close the desktop app and run "pi-kit update" again, or use "Check for updates" in Settings.',
            { cause: error },
          );
        throw error;
      }
      if (result.unavailable) throw new Error(result.unavailable);
      return result;
    };
    const result = await run('check');
    if (!result.available) io.out(`Up to date: ${ctx.desktopUpdate?.version() ?? ctx.version}.\n`);
    else if (check) io.out(`${result.version} is available; run "pi-kit update".\n`);
    else {
      await ctx.desktopUpdate?.preflight?.();
      io.out(`Downloading pi-kit ${result.version} through the desktop updater…\n`);
      if (!(await run('download')).downloaded) throw new Error('the desktop update did not finish downloading.');
      if (!(await run('install')).downloaded) throw new Error('the desktop update is not ready to install.');
      io.out('Restarting pi-kit to install the update. Remote access may disconnect briefly.\n');
    }
    return true;
  } finally {
    peer.close();
  }
}

/** An installed desktop app can update silently even when only its background service is running. */
export async function runDesktopUpdateCli(check: boolean, io: CliIo, ctx: CliContext): Promise<number> {
  const install = ctx.desktopUpdate;
  if (!install) throw new Error('this is not a supported desktop install.');
  const host = ctx.discover();
  if (
    host?.install &&
    resolve(host.install) !== resolve(install.hostInstall ?? join(install.root, 'Contents', 'Resources'))
  )
    throw new Error('another pi-kit install runs this profile; use its pi-kit command to update it.');
  if (host && (await attachedUpdate(check, io, ctx, host))) return 0;
  const current = install.version();
  if (!current) throw new Error('cannot read the installed app version; nothing changed.');
  const release = await getRelease(install.releases);
  const version = release.tag_name.replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('the release feed returned an invalid version.');
  if (!isNewerVersion(version, current)) {
    io.out(`Up to date: ${current}.\n`);
    return 0;
  }
  if (check) {
    io.out(`${version} is available; run "pi-kit update".\n`);
    return 0;
  }
  checkHost(ctx, install, host);
  await install.preflight?.();
  if (!ctx.startDesktopFinisher) throw new Error('this build has no detached desktop updater; nothing changed.');
  const asset = desktopAsset(install.target, version);
  if (!asset) throw new Error(`the releases have no desktop app for ${install.target}.`);
  const archive = release.assets.find((file) => file.name === asset.file);
  const manifest = release.assets.find((file) => file.name === asset.manifest);
  if (!archive || !manifest) throw new Error(`the ${version} release has no ${asset.file} or ${asset.manifest}.`);
  const staging = mkdtempSync(join(tmpdir(), 'pi-kit-desktop-update-'));
  let handedOver = false;
  try {
    io.out(`Downloading ${asset.file}…\n`);
    const file = join(staging, asset.file);
    await download(archive.browser_download_url, file);
    const expected = manifestSha512(await getText(manifest.browser_download_url), asset.file);
    if (!expected || createHash('sha512').update(readFileSync(file)).digest('base64') !== expected)
      throw new Error(`${asset.file} does not match ${asset.manifest}; nothing changed.`);
    const log = join(ctx.logDir, 'desktop-update.log');
    await ctx.startDesktopFinisher({ archive: file, version, staging, log, sha512: expected });
    handedOver = true;
    io.out(
      `Updating pi-kit ${current} to ${version} silently in the background. The download is verified before installation.\n` +
        `Remote access may disconnect briefly while the service restarts. See ${log}.\n`,
    );
    return 0;
  } finally {
    if (!handedOver) rmSync(staging, { recursive: true, force: true });
  }
}

/** Runs detached: stopping the service must not kill the updater along with a remote terminal. */
export async function finishDesktopUpdate(plan: DesktopUpdatePlan, io: CliIo, ctx: CliContext): Promise<number> {
  let staged: Awaited<ReturnType<DesktopUpdateOperations['stage']>> | undefined;
  let stopped = false;
  let host: HostDiscovery | undefined;
  const manager = ctx.bootManager?.installed() ? ctx.bootManager : ctx.manager;
  try {
    const install = ctx.desktopUpdate;
    if (!install) throw new Error('this is not a supported desktop install.');
    const current = install.version();
    if (!current) throw new Error('cannot read the installed app version; nothing changed.');
    if (!isNewerVersion(plan.version, current)) {
      io.out(`Up to date: ${current}; the scheduled update is no longer needed.\n`);
      return 0;
    }
    if (plan.sha512 && createHash('sha512').update(readFileSync(plan.archive)).digest('base64') !== plan.sha512)
      throw new Error('the downloaded update changed after verification; nothing changed.');
    staged = await install.stage(plan.archive, plan.version);
    host = ctx.discover();
    checkHost(ctx, install, host);
    if (host) {
      const peer = await ctx.connect(host);
      try {
        if ((await peer.call<HostStatus>('status')).desktopAttached)
          throw new Error('the desktop app opened during the download; close it and try again.');
      } finally {
        peer.close();
      }
      await ctx.prepareDesktopServiceRestart?.();
      if (!(await stopHost(ctx, host))) throw new Error('the service did not stop; nothing changed.');
      stopped = true;
    }
    let replacementError: unknown;
    try {
      staged.replace();
      io.out(`Updated pi-kit to ${plan.version}. The previous app is retained beside ${install.root}.\n`);
    } catch (error) {
      replacementError = error;
    }
    // Restore service availability after either a successful swap or rollback.
    if (stopped && manager) {
      try {
        await (ctx.restartDesktopService ? ctx.restartDesktopService() : manager.start());
        const expected = replacementError ? current : plan.version;
        const running = await waitFor(ctx, () => {
          const found = ctx.discover();
          return found?.version === expected ? found : undefined;
        });
        if (!running) throw new Error('the service did not start in time; see "pi-kit service logs".');
        io.out(`Running ${running.version}, pid ${running.pid}.\n`);
      } catch (error) {
        if (replacementError)
          throw new AggregateError([replacementError, error], 'App replacement and service restart failed.', {
            cause: error,
          });
        if (staged.rollback) {
          try {
            const failedHost = ctx.discover();
            if (failedHost && !(await stopHost(ctx, failedHost)))
              throw new Error('the failed service could not stop for rollback.', { cause: error });
            staged.rollback();
            io.err('The updated service could not start; restored the previous app. Restarting it…\n');
            await (ctx.restartDesktopService ? ctx.restartDesktopService() : manager.start());
            if (
              !(await waitFor(ctx, () => {
                const found = ctx.discover();
                return found?.version === current ? found : undefined;
              }))
            )
              throw new Error('the previous service did not start.', { cause: error });
          } catch (rollback) {
            throw new AggregateError(
              [error, rollback],
              `Service restart failed (${String(error)}); recovery failed (${String(rollback)}). See retained app backups.`,
              { cause: rollback },
            );
          }
        }
        throw error;
      }
    }
    if (replacementError) throw replacementError;
    return 0;
  } catch (error) {
    io.err(`pi-kit update: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    ctx.closeDesktopServiceRestart?.();
    staged?.cleanup();
    rmSync(plan.staging, { recursive: true, force: true });
  }
}
