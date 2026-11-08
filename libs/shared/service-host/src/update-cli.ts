import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { stopHost, waitFor } from './cli-host';
import { isNewerVersion } from './discovery';
import { download, getRelease, getText } from './release-feed';
import type { CliContext, CliIo } from './service-cli';

export const UPDATE_USAGE = `  pi-kit update [--check]           Update this server install to the latest release (the desktop app updates itself)
`;

/** The CLI started as the Windows finisher, with the path of its plan (JSON) after the flag. */
export const FINISH_UPDATE_FLAG = '--pi-kit-finish-update';

/** An npm install's update: npm installs `spec` under the global prefix it installed pi-kit in. */
export interface NpmUpdate {
  prefix: string;
  spec: string;
}

/**
 * What the Windows finisher does once the `pi-kit update` that started it has exited: move the release in place of the
 * install, or run npm on it.
 */
export type FinishPlan = {
  parent: number;
  /** Holds the download and the finisher itself; removed after the finisher exits. */
  staging: string;
  /** The scheduled task to run again: the service ran before the update. */
  task?: string;
  log: string;
} & ({ install: string; unpacked: string; previous: string } | { npm: NpmUpdate });

export interface FinishOps {
  alive(pid: number): boolean;
  rename(from: string, to: string): void;
  remove(path: string): void;
  /** Runs npm for the update; false when it failed. */
  npm(update: NpmUpdate): boolean;
  runTask(name: string): void;
  log(line: string): void;
  sleep(ms: number): Promise<unknown>;
}

const PATIENCE = 120;

/**
 * Windows: the swap `pi-kit update` cannot make while it runs on the install's own node.exe, made from a copy outside the
 * install. It waits for that command to exit, moves the install aside (retrying while Windows still holds its files), moves
 * the new version in, puts the old one back when that fails, and starts the service again either way when it ran before.
 * For an npm install, npm replaces the install instead, once nothing runs from it.
 */
export async function finishWindowsUpdate(plan: FinishPlan, ops: FinishOps): Promise<boolean> {
  for (let i = 0; i < PATIENCE && ops.alive(plan.parent); i++) await ops.sleep(500);
  if ('npm' in plan) {
    const updated = ops.npm(plan.npm);
    ops.log(updated ? `npm installed ${plan.npm.spec}` : `npm could not install ${plan.npm.spec}`);
    if (plan.task) ops.runTask(plan.task);
    return updated;
  }
  let updated = false;
  try {
    ops.remove(plan.previous);
    for (let i = 0; ; i++) {
      try {
        ops.rename(plan.install, plan.previous);
        break;
      } catch (error) {
        if (i >= PATIENCE) throw error;
        await ops.sleep(500);
      }
    }
    try {
      ops.rename(plan.unpacked, plan.install);
      updated = true;
      ops.log(`updated ${plan.install}; the previous install is in ${plan.previous}`);
    } catch (error) {
      ops.rename(plan.previous, plan.install);
      throw error;
    }
  } catch (error) {
    ops.log(`nothing changed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (plan.task) ops.runTask(plan.task);
  return updated;
}

/** What the finisher does on a real Windows machine, logging to the plan's file. */
export function windowsFinishOps(plan: FinishPlan): FinishOps {
  mkdirSync(dirname(plan.log), { recursive: true });
  return {
    alive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    },
    rename: renameSync,
    remove: (path) => rmSync(path, { recursive: true, force: true }),
    npm: ({ prefix, spec }) => {
      // Verbatim, as removeStagingAfterExit explains; cmd runs npm's .cmd from PATH.
      const run = spawnSync('cmd.exe', ['/d', '/s', '/c', `"npm install -g --prefix "${prefix}" ${spec}"`], {
        encoding: 'utf8',
        windowsVerbatimArguments: true,
      });
      appendFileSync(plan.log, `${run.stdout ?? ''}${run.stderr ?? ''}`);
      return run.status === 0;
    },
    runTask: (name) => void execFileSync('schtasks', ['/Run', '/TN', name], { stdio: 'ignore' }),
    log: (line) => appendFileSync(plan.log, `${new Date().toISOString()} ${line}\n`),
    sleep: (ms) => delay(ms),
  };
}

/**
 * The finisher runs from the staging folder, so a short-lived cmd removes that folder once the finisher has exited. Verbatim:
 * Node would escape the path's quotes as \", which cmd does not read; /s strips only the outer pair.
 */
export function removeStagingAfterExit(plan: FinishPlan): void {
  spawn('cmd.exe', ['/d', '/s', '/c', `"ping -n 3 127.0.0.1 >nul & rmdir /s /q "${plan.staging}""`], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    windowsVerbatimArguments: true,
  }).unref();
}

/**
 * `pi-kit update`: the release's server tarball for this target, checked against the release's SHA256SUMS, unpacked beside the
 * install and swapped in while the service is stopped. The install's path stays the same, so its registration does too; the
 * install it replaces stays beside it as `<install>.previous`.
 */
export async function runUpdateCli(args: string[], io: CliIo, ctx: CliContext): Promise<number> {
  const check = args.length === 1 && args[0] === '--check';
  if (args.length > 0 && !check) {
    io.err(UPDATE_USAGE);
    return 2;
  }
  const install = ctx.serverInstall;
  if (!install) {
    io.err('pi-kit: the desktop app updates itself; use "Check for updates" in it.\n');
    return 2;
  }
  if (install.npm) return updateWithNpm(check, io, ctx, { ...install, npm: install.npm });
  const release = await getRelease(install.releases);
  const version = release.tag_name.replace(/^v/, '');
  if (!isNewerVersion(version, install.version)) {
    io.out(`Up to date: ${install.version}.\n`);
    return 0;
  }
  if (check) {
    io.out(`${version} is available; run "pi-kit update".\n`);
    return 0;
  }
  const windows = install.target.startsWith('win32-');
  const name = `pi-kit-server-${version}-${install.target}${windows ? '.zip' : '.tar.gz'}`;
  const archive = release.assets.find((asset) => asset.name === name);
  const sums = release.assets.find((asset) => asset.name === 'SHA256SUMS');
  if (!archive || !sums) {
    io.err(`pi-kit: the ${version} release has no ${name}.\n`);
    return 1;
  }
  const host = ctx.discover();
  if (host && host.level !== 'login') {
    io.err(
      `pi-kit: ${host.level === 'serve' ? '"pi-kit serve"' : 'the pi-kit app'} runs this profile; stop it, then update.\n`,
    );
    return 1;
  }

  const staging = mkdtempSync(join(dirname(install.root), '.pi-kit-update-'));
  let handedOver = false;
  try {
    const file = join(staging, name);
    await download(archive.browser_download_url, file);
    const expected = (await getText(sums.browser_download_url))
      .split('\n')
      .map((line) => line.trim().split(/\s+/))
      .find(([, entry]) => entry === name)?.[0];
    if (!expected || createHash('sha256').update(readFileSync(file)).digest('hex') !== expected) {
      io.err(`pi-kit: ${name} does not match the release's SHA256SUMS; nothing changed.\n`);
      return 1;
    }
    // Windows' own tar.exe is bsdtar, which reads zips; a Git Bash tar earlier on PATH does not.
    const tar =
      process.platform === 'win32' ? join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
    execFileSync(tar, ['-xf', file, '-C', staging]);
    const unpacked = join(staging, name.replace(/\.(tar\.gz|zip)$/, ''));
    if (!existsSync(join(unpacked, 'backend', 'service-host.cjs'))) {
      io.err(`pi-kit: ${name} holds no pi-kit server; nothing changed.\n`);
      return 1;
    }
    if (host && !(await stopHost(ctx, host))) {
      io.err('pi-kit: the service did not stop; nothing changed.\n');
      return 1;
    }
    const previous = `${install.root}.previous`;
    // A running node.exe cannot be renamed, and this command runs on the install's own: a finisher swaps after it exits.
    if (windows && ctx.startFinisher) {
      const log = join(ctx.logDir, 'update.log');
      ctx.startFinisher({
        parent: process.pid,
        install: install.root,
        unpacked,
        previous,
        staging,
        log,
        ...(host ? { task: ctx.serviceName } : {}),
      });
      handedOver = true;
      io.out(
        `Updating ${install.version} to ${version} as soon as this command exits; the previous install stays in ${previous}.` +
          `${host ? ' The service starts again by itself.' : ''} See ${log}.\n`,
      );
      return 0;
    }
    rmSync(previous, { recursive: true, force: true });
    renameSync(install.root, previous);
    renameSync(unpacked, install.root);
    io.out(`Updated ${install.version} to ${version}; the previous install is in ${previous}.\n`);
    if (!host || !ctx.manager) return 0;
    await ctx.manager.start();
    const started = await waitFor(ctx, () => ctx.discover());
    io.out(
      started
        ? `Running ${started.version}, pid ${started.pid}.\n`
        : 'The service did not start in time; see "pi-kit service logs".\n',
    );
    return started ? 0 : 1;
  } finally {
    if (!handedOver) rmSync(staging, { recursive: true, force: true });
  }
}

type NpmInstall = NonNullable<CliContext['serverInstall']> & { npm: string };

/**
 * An npm install: npm's latest of the package, once npm also serves this machine's package of it (it can hold a new
 * version for a maintainer's approval, and the package without it would not run), installed by npm under the prefix it
 * installed pi-kit in, with the service stopped meanwhile. npm replaces the folder in place, so the registration stays.
 */
async function updateWithNpm(check: boolean, io: CliIo, ctx: CliContext, install: NpmInstall): Promise<number> {
  const manual = `  pi-kit service stop\n  npm install -g ${install.npm}@latest\n  pi-kit service start\n`;
  const npm = ctx.npm;
  const latest = npm?.view(install.npm);
  const prefix = npmPrefix(install.root, install.target.startsWith('win32-'));
  if (!npm || !latest || !prefix) {
    io.err(`pi-kit: npm does not answer here; update with npm:\n${manual}`);
    return 1;
  }
  if (!isNewerVersion(latest, install.version)) {
    io.out(`Up to date: ${install.version}.\n`);
    return 0;
  }
  const own = `${install.npm}-${install.target}`;
  if (npm.view(`${own}@${latest}`) !== latest) {
    io.err(`pi-kit: npm has ${install.npm} ${latest}, but not yet ${own} ${latest}; try again later.\n`);
    return 1;
  }
  if (check) {
    io.out(`${latest} is available; run "pi-kit update".\n`);
    return 0;
  }
  const host = ctx.discover();
  if (host && host.level !== 'login') {
    io.err(
      `pi-kit: ${host.level === 'serve' ? '"pi-kit serve"' : 'the pi-kit app'} runs this profile; stop it, then update.\n`,
    );
    return 1;
  }
  if (host && !(await stopHost(ctx, host))) {
    io.err('pi-kit: the service did not stop; nothing changed.\n');
    return 1;
  }
  const spec = `${install.npm}@${latest}`;
  // Windows: npm cannot replace the node.exe this command runs on; the finisher runs it once this command has exited.
  if (install.target.startsWith('win32-') && ctx.startFinisher) {
    const log = join(ctx.logDir, 'update.log');
    ctx.startFinisher({
      parent: process.pid,
      staging: mkdtempSync(join(tmpdir(), 'pi-kit-update-')),
      npm: { prefix, spec },
      log,
      ...(host ? { task: ctx.serviceName } : {}),
    });
    io.out(
      `Updating ${install.version} to ${latest} with npm as soon as this command exits.` +
        `${host ? ' The service starts again by itself.' : ''} See ${log}.\n`,
    );
    return 0;
  }
  const updated = npm.install(prefix, spec);
  if (updated) io.out(`Updated ${install.version} to ${latest}.\n`);
  else io.err(`pi-kit: npm could not install ${spec}; see its output above.\n`);
  if (!host || !ctx.manager) return updated ? 0 : 1;
  await ctx.manager.start();
  const started = await waitFor(ctx, () => ctx.discover());
  io.out(
    started
      ? `Running ${started.version}, pid ${started.pid}.\n`
      : 'The service did not start in time; see "pi-kit service logs".\n',
  );
  return updated && started ? 0 : 1;
}

/** The global prefix npm installed `root` under: the folder above its first node_modules (and above lib, off Windows). */
export function npmPrefix(root: string, windows: boolean): string | undefined {
  const parts = root.split(/[\\/]/);
  const at = parts.indexOf('node_modules');
  if (at < 1) return undefined;
  return parts.slice(0, !windows && parts[at - 1] === 'lib' ? at - 1 : at).join(windows ? '\\' : '/') || '/';
}
