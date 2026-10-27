import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, symlinkSync, unlinkSync, utimesSync, writeFileSync, lstatSync, readlinkSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { PI_PACKAGE, piPackageVersion, readManagedInstall } from './pi-resolution';
import { runProcess } from './process-runner';
import type { PiSdkRange } from '@pi-kit/protocol';

/**
 * pi's managed install, written the way pi's own installer and `pi update` write it: one pinned copy per version under
 * `<agent dir>/install/releases/<version>`, `current-version` naming the active one, `managed-install.json` marking the layout and a
 * launcher script (`<agent dir>/bin/pi`) that the `pi` command on PATH points at. pi's updater can only run from inside such an
 * install, so when there is none, pi-kit makes the first release itself: the same two files from pi.dev's installer API, `npm ci`,
 * a smoke test, then the rename and `current-version`. After that `pi update` (pi's own code) does every later update.
 */

export const DEFAULT_INSTALLER_API = 'https://pi.dev/api/installer/releases';
const LOCK_STALE_MS = 10_000;

/** Node and npm that the pi installer put on the machine (the launcher adds them to PATH), then the inherited PATH. */
export function piToolPath(env: NodeJS.ProcessEnv = process.env): string {
  const data = env['XDG_DATA_HOME'] || join(homedir(), '.local', 'share');
  const own = join(data, 'pi-node', 'current', 'bin');
  // Windows commonly supplies `Path`, not `PATH`; spreading process.env loses its case-insensitive lookup.
  const inherited = env['PATH'] ?? Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1];
  return [existsSync(join(own, process.platform === 'win32' ? 'node.exe' : 'node')) ? own : undefined, inherited].filter(Boolean).join(delimiter);
}

/** Keep exactly one PATH key: Node sorts duplicate environment keys case-insensitively on Windows. */
export function piToolEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = Object.fromEntries(Object.entries(env).filter(([key]) => key.toLowerCase() !== 'path'));
  return { ...next, PATH: piToolPath(env) };
}

const NPM_CI_ARGS = ['ci', '--ignore-scripts', '--min-release-age=0', '--omit=dev', '--include=optional', '--no-fund', '--no-audit', '--loglevel=error', '--progress=false'];

/** Windows npm is a batch launcher. Only these fixed arguments enter cmd.exe; no user input is interpolated. */
export function npmCiInvocation(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): { command: string; args: string[] } {
  if (platform === 'win32') return { command: env['ComSpec'] || env['COMSPEC'] || 'cmd.exe', args: ['/d', '/s', '/c', `npm.cmd ${NPM_CI_ARGS.join(' ')}`] };
  return { command: 'npm', args: [...NPM_CI_ARGS] };
}

/** The `update.lock` folder pi's updater takes (proper-lockfile convention), kept fresh while held. Returns the release function. */
async function acquireLock(root: string): Promise<() => void> {
  const lock = join(root, 'update.lock');
  mkdirSync(root, { recursive: true });
  for (let attempt = 0; ; attempt++) {
    try {
      mkdirSync(lock);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let stale: boolean;
      try {
        stale = Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS;
      } catch {
        stale = true;
      }
      if (stale && attempt < 2) {
        rmSync(lock, { recursive: true, force: true });
        continue;
      }
      throw new Error('Another pi update is already running.', { cause: error });
    }
  }
  const beat = setInterval(() => {
    try {
      const now = new Date();
      utimesSync(lock, now, now);
    } catch {
      // released
    }
  }, 5000);
  beat.unref();
  return () => {
    clearInterval(beat);
    try {
      rmdirSync(lock);
    } catch {
      // already gone
    }
  };
}

async function fetchText(url: string, signal?: AbortSignal): Promise<string> {
  const response = await fetch(url, { headers: { 'User-Agent': 'pi-kit' }, ...(signal ? { signal } : {}) });
  if (!response.ok) throw new Error(`Could not download ${url}: HTTP ${response.status}`);
  return response.text();
}

export interface InstallOptions {
  /** `<agent dir>/install`. */
  root: string;
  version: string;
  /** `PI_INSTALLER_API_BASE` of pi, default pi.dev. */
  apiBase?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  log: (line: string) => void;
}

/** Installs `version` as a managed release and makes it current: pi's `runManagedSelfUpdate`, which the package does not export. */
export async function installManagedRelease(options: InstallOptions): Promise<void> {
  const { root, version, log } = options;
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`Invalid release version: ${version}`);
  const env = { ...(options.env ?? process.env) };
  const api = (options.apiBase ?? env['PI_INSTALLER_API_BASE']?.trim() ?? DEFAULT_INSTALLER_API).replace(/\/+$/, '');
  mkdirSync(join(root, 'releases'), { recursive: true });
  ensureMarker(root);
  const release = await acquireLock(root);
  let stage: string | undefined;
  try {
    const target = join(root, 'releases', version);
    if (existsSync(target)) {
      log(`pi ${version} is already installed; making it current.`);
      activate(root, version);
      return;
    }
    mkdirSync(join(root, 'staging'), { recursive: true });
    stage = mkdtempSync(join(root, 'staging', 'update-'));
    log(`Downloading the pi ${version} release files…`);
    const [manifest, lock] = await Promise.all([fetchText(`${api}/${encodeURIComponent(version)}/package.json`, options.signal), fetchText(`${api}/${encodeURIComponent(version)}/package-lock.json`, options.signal)]);
    writeFileSync(join(stage, 'package.json'), manifest);
    writeFileSync(join(stage, 'package-lock.json'), lock);
    await fetchText(`${api}/${encodeURIComponent(version)}/metadata.json`, options.signal)
      .then((text) => writeFileSync(join(stage as string, 'metadata.json'), text))
      .catch(() => undefined);
    log('Installing the pinned dependencies (npm ci)…');
    const toolEnv = piToolEnvironment(env);
    const result = await runProcess({
      ...npmCiInvocation(toolEnv),
      cwd: stage,
      env: toolEnv,
      ...(options.signal ? { signal: options.signal } : {}),
      onLine: (line) => log(line),
    });
    if (result.cancelled) throw new Error('Cancelled.');
    if (result.code === 9009) throw new Error('npm.cmd was not found. Install Node.js LTS with npm, ensure its folder is on your Windows PATH, then fully quit and reopen pi-kit.');
    if (result.code !== 0) throw new Error(`npm ci exited with code ${result.code ?? 'unknown'}`);
    const installed = piPackageVersion(join(stage, 'node_modules', PI_PACKAGE));
    if (installed !== version) throw new Error(`The installed pi reports ${installed ?? 'no version'}; expected ${version}.`);
    log(`Verified pi ${version}.`);
    renameSync(stage, target);
    stage = undefined;
    activate(root, version);
    prune(root, version);
  } finally {
    if (stage) rmSync(stage, { recursive: true, force: true });
    release();
  }
}

function ensureMarker(root: string): void {
  const marker = join(root, 'managed-install.json');
  if (existsSync(marker)) return;
  const agentDir = dirname(root);
  writeFileSync(marker, `${JSON.stringify({ kind: 'pi-managed-install', schemaVersion: 1, layout: 'releases-v1', entrypoint: { type: 'symlink', path: join(homedir(), '.local', 'bin', 'pi') } }, null, 2)}\n`);
  mkdirSync(join(agentDir, 'bin'), { recursive: true });
}

/** `current-version`, written the way pi writes it: to a temporary file, then renamed. */
export function activate(root: string, version: string): void {
  const current = join(root, 'current-version');
  const temporary = join(root, `current-version.tmp.${process.pid}-${Date.now()}`);
  try {
    writeFileSync(temporary, `${version}\n`);
    renameSync(temporary, current);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** Keeps the active release and the one before it (the rollback); pi's own prune keeps the active and the running one. */
function prune(root: string, active: string): void {
  const keep = new Set([active]);
  const releases = readManagedInstall(dirname(root), { min: '0.0.0', max: '999.x' })?.releases ?? [];
  const previous = releases.filter((r) => r.version !== active).at(-1);
  if (previous) keep.add(previous.version);
  for (const release of releases) if (!keep.has(release.version)) rmSync(release.dir, { recursive: true, force: true });
}

// ---- the `pi` command

/** The launcher pi's installer writes: resolves `current-version` and starts that release's `pi` with `PI_MANAGED_INSTALL_ROOT` set. */
export const LAUNCHER = `#!/bin/sh
case "$0" in
  */*) pi_launcher="$0" ;;
  *) pi_launcher=$(command -v "$0") || exit 127 ;;
esac
while [ -L "$pi_launcher" ]; do
  pi_link=$(readlink "$pi_launcher") || exit 1
  case "$pi_link" in
    /*) pi_launcher="$pi_link" ;;
    *) pi_launcher=\${pi_launcher%/*}/$pi_link ;;
  esac
done
pi_bin_dir=\${pi_launcher%/*}
pi_agent_dir=\${pi_bin_dir%/*}
pi_current_file=$pi_agent_dir/install/current-version
if ! IFS= read -r pi_current_version < "$pi_current_file"; then
  printf 'Could not read managed Pi version from %s.\\n' "$pi_current_file" >&2
  exit 1
fi
case "$pi_current_version" in
  ""|.|..|*[!0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz._+-]*)
    printf 'Managed Pi version file is invalid: %s\\n' "$pi_current_file" >&2
    exit 1
    ;;
esac
pi_release_dir=$pi_agent_dir/install/releases/$pi_current_version
pi_release_bin=$pi_release_dir/node_modules/.bin/pi
if [ ! -x "$pi_release_bin" ]; then
  printf 'Managed Pi executable is missing: %s\\n' "$pi_release_bin" >&2
  exit 1
fi
pi_node_bin=\${XDG_DATA_HOME:-$HOME/.local/share}/pi-node/current/bin
if [ -x "$pi_node_bin/node" ]; then
  PATH=$pi_node_bin:$PATH
  export PATH
fi
PI_MANAGED_INSTALL_ROOT=$pi_agent_dir/install
export PI_MANAGED_INSTALL_ROOT
exec "$pi_release_bin" "$@"
`;

export interface PiCommandState {
  /** `<agent dir>/bin/pi` exists and is executable. */
  launcherInstalled: boolean;
  /** A `pi` entry point (the marker's `entrypoint.path`, else `~/.local/bin/pi`) resolves to that launcher. */
  onPath: boolean;
  entrypoint: string;
}

export function piCommandState(agentDir: string, home: string = homedir()): PiCommandState {
  const launcher = join(agentDir, 'bin', 'pi');
  let entrypoint = join(home, '.local', 'bin', 'pi');
  try {
    const marker = JSON.parse(readFileSync(join(agentDir, 'install', 'managed-install.json'), 'utf8')) as { entrypoint?: { path?: string } };
    if (marker.entrypoint?.path) entrypoint = marker.entrypoint.path;
  } catch {
    // no marker yet: the default entry point
  }
  let onPath: boolean;
  try {
    const link = readlinkSync(entrypoint);
    onPath = resolve(isAbsolute(link) ? link : join(dirname(entrypoint), link)) === resolve(launcher);
  } catch {
    onPath = false;
  }
  return { launcherInstalled: existsSync(launcher), onPath, entrypoint };
}

/** "Install the `pi` command": the launcher in the agent folder and the symlink `~/.local/bin/pi` to it. Never replaces a pi that works. */
export function installPiCommand(agentDir: string, home: string = homedir()): PiCommandState {
  const launcher = join(agentDir, 'bin', 'pi');
  mkdirSync(dirname(launcher), { recursive: true });
  writeFileSync(launcher, LAUNCHER);
  chmodSync(launcher, 0o755);
  const state = piCommandState(agentDir, home);
  if (!state.onPath) {
    mkdirSync(dirname(state.entrypoint), { recursive: true });
    if (existsSync(state.entrypoint) || isLink(state.entrypoint)) {
      // Only a link that leads nowhere is ours to replace; a working link or a real file is somebody's pi and stays.
      if (isLink(state.entrypoint) && !existsSync(state.entrypoint)) unlinkSync(state.entrypoint);
      else throw new Error(`${state.entrypoint} already exists${isLink(state.entrypoint) ? ` (it points to ${readlinkSync(state.entrypoint)})` : ' and is not a link'}; remove it to use pi-kit's launcher.`);
    }
    symlinkSync(launcher, state.entrypoint);
  }
  return piCommandState(agentDir, home);
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Releases on disk, for tests and diagnostics. */
export function releaseNames(root: string): string[] {
  try {
    return readdirSync(join(root, 'releases'));
  } catch {
    return [];
  }
}

export type { PiSdkRange };
