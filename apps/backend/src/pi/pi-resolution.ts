import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ManagedRelease, PiResolution, PiSdkRange } from '@pi-kit/protocol';
import { compareVersions } from './version';
import { satisfies } from 'semver';

/**
 * Which pi the backend loads, in order:
 *
 *  1. `PI_KIT_PI_DIR` (developer override: a package folder or a folder that has `node_modules/@earendil-works/pi-coding-agent`);
 *  2. pi's managed install (`<agent dir>/install`, `managed-install.json` with `layout: releases-v1`): the release `current-version`
 *     names (what the `pi` command runs), when it is intact (`package.json`, `node_modules`, and the package names the release's
 *     own version), not older than the bundled copy and inside the SDK range pi-kit declares (`piSdk` in the root `package.json`);
 *  3. the copy bundled with pi-kit.
 *
 * "Use previous release" pins the choice to a named managed release (or `bundled`). Everything that exists and was not used leaves a
 * line in `notes`, which Settings shows. This is pure: folders in, a resolution out, so the unit tests run on fixture folders.
 */

export const PI_PACKAGE = '@earendil-works/pi-coding-agent';
const MANAGED_MARKER = 'managed-install.json';
const RELEASE_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export interface ResolveInput {
  env: NodeJS.ProcessEnv;
  agentDir: string;
  /** The package folder of the copy bundled with pi-kit. */
  bundledDir: string;
  range: PiSdkRange;
  /** A version of a managed release, or `bundled`, chosen in Settings › Advanced. */
  pinned?: string;
}

/** pi's own rule for its agent folder (`getAgentDir`): `PI_CODING_AGENT_DIR` with `~` expanded, else `~/.pi/agent`. */
export function agentDirOf(env: NodeJS.ProcessEnv): string {
  const configured = env['PI_CODING_AGENT_DIR'];
  if (configured) return configured === '~' ? homedir() : configured.startsWith('~/') ? join(homedir(), configured.slice(2)) : configured;
  return join(homedir(), '.pi', 'agent');
}

/** The `version` of the package.json in `dir`, if it is the pi package. */
export function piPackageVersion(dir: string): string | undefined {
  try {
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: string; version?: string };
    return manifest.name === PI_PACKAGE && typeof manifest.version === 'string' ? manifest.version : undefined;
  } catch {
    return undefined;
  }
}

/** The folder of the bundled pi: found the way Node finds a package (`node_modules` upwards from this file), without loading it. */
export function bundledPiDir(from: string = __dirname): string | undefined {
  for (let dir = from; ; dir = dirname(dir)) {
    // Nx's ESM SDK bundle and its runtime assets. Development may still load
    // the installed npm SDK; release packaging uses only this dist artifact.
    const built = join(dir, 'assets', 'pi');
    if (piPackageVersion(built) !== undefined) return built;
    const candidate = join(dir, 'node_modules', PI_PACKAGE);
    if (piPackageVersion(candidate) !== undefined) return candidate;
    if (dirname(dir) === dir) return undefined;
  }
}

/** `1.x`, `1.3.x` and `1.3.9` as an inclusive upper bound. */
export function withinMax(version: string, max: string): boolean {
  return satisfies(version.trim(), `<=${max.trim()}`, { includePrerelease: true });
}

export function inRange(version: string, range: PiSdkRange): boolean {
  const low = compareVersions(version, range.min);
  return low !== undefined && low >= 0 && withinMax(version, range.max);
}

/** The pi package folder inside a release or install folder, or the folder itself when it is the package. */
function packageDirIn(dir: string): string | undefined {
  if (piPackageVersion(dir)) return dir;
  const nested = join(dir, 'node_modules', PI_PACKAGE);
  return piPackageVersion(nested) ? nested : undefined;
}

function readMarker(root: string): boolean {
  try {
    const marker = JSON.parse(readFileSync(join(root, MANAGED_MARKER), 'utf8')) as { kind?: string; schemaVersion?: number; layout?: string };
    return marker.kind === 'pi-managed-install' && marker.schemaVersion === 1 && marker.layout === 'releases-v1';
  } catch {
    return false;
  }
}

/** The releases of pi's managed install, oldest first by name; `undefined` when there is no valid install. */
export function readManagedInstall(agentDir: string, range: PiSdkRange): NonNullable<PiResolution['managed']> | undefined {
  const root = join(agentDir, 'install');
  if (!existsSync(root) || !readMarker(root)) return undefined;
  let current: string | undefined;
  try {
    current = readFileSync(join(root, 'current-version'), 'utf8').split('\n')[0]?.trim() || undefined;
  } catch {
    current = undefined;
  }
  let names: string[];
  try {
    names = readdirSync(join(root, 'releases')).filter((name) => RELEASE_RE.test(name));
  } catch {
    names = [];
  }
  const releases: ManagedRelease[] = names
    .sort((a, b) => compareVersions(a, b) ?? 0)
    .map((version) => {
      const dir = join(root, 'releases', version);
      const intact = existsSync(join(dir, 'package.json')) && piPackageVersion(join(dir, 'node_modules', PI_PACKAGE)) === version;
      return { version, dir, intact, inRange: inRange(version, range) };
    });
  return { root, ...(current ? { current } : {}), releases };
}

export function resolvePi(input: ResolveInput): PiResolution {
  const { env, agentDir, bundledDir, range } = input;
  const bundledVersion = piPackageVersion(bundledDir) ?? '0.0.0';
  const notes: string[] = [];
  const base = { bundled: { version: bundledVersion, packageDir: bundledDir }, range, notes };
  const managed = readManagedInstall(agentDir, range);
  const withManaged = { ...base, ...(managed ? { managed } : {}), ...(input.pinned ? { pinned: input.pinned } : {}) };
  const use = (source: PiResolution['source'], version: string, packageDir: string): PiResolution => ({ source, version, packageDir, ...withManaged });

  // 1. the developer override
  const override = env['PI_KIT_PI_DIR']?.trim();
  if (override) {
    const dir = packageDirIn(override);
    const version = dir ? piPackageVersion(dir) : undefined;
    if (dir && version) return use('env', version, dir);
    notes.push(`PI_KIT_PI_DIR (${override}) is not a pi package or release folder; ignored.`);
  }

  // The pinned choice ("Use previous release").
  if (input.pinned === 'bundled') {
    notes.push(`Pinned to the bundled pi ${bundledVersion} in Settings › Advanced.`);
    return use('bundled', bundledVersion, bundledDir);
  }
  if (input.pinned) {
    const release = managed?.releases.find((r) => r.version === input.pinned);
    if (release?.intact && release.inRange) {
      notes.push(`Pinned to pi ${release.version} in Settings › Advanced.`);
      return use('managed', release.version, join(release.dir, 'node_modules', PI_PACKAGE));
    }
    notes.push(`The pinned release pi ${input.pinned} is not available${release && !release.intact ? ' (its folder is incomplete)' : ''}; following the newest.`);
  }

  // 2. pi's managed install
  if (managed) {
    const eligible = (r: ManagedRelease): boolean => r.intact && r.inRange && (compareVersions(r.version, bundledVersion) ?? -1) >= 0;
    const currentRelease = managed.current ? managed.releases.find((r) => r.version === managed.current) : undefined;
    const chosen = currentRelease && eligible(currentRelease) ? currentRelease : [...managed.releases].reverse().find(eligible);
    if (currentRelease && !currentRelease.intact) notes.push(`pi ${currentRelease.version} is installed (the pi command runs it) but its folder is incomplete.`);
    else if (currentRelease && !currentRelease.inRange) {
      const above = (compareVersions(currentRelease.version, range.min) ?? 0) > 0;
      notes.push(
        above
          ? `pi ${currentRelease.version} is installed, this pi-kit supports up to ${range.max}; using ${chosen ? `pi ${chosen.version}` : `the bundled ${bundledVersion}`}.`
          : `pi ${currentRelease.version} is installed, this pi-kit needs ${range.min} or newer; using ${chosen ? `pi ${chosen.version}` : `the bundled ${bundledVersion}`}.`,
      );
    } else if (currentRelease && (compareVersions(currentRelease.version, bundledVersion) ?? 0) < 0) {
      notes.push(`pi ${currentRelease.version} is installed, older than the bundled ${bundledVersion}; using the bundled copy.`);
    }
    if (chosen) return use('managed', chosen.version, join(chosen.dir, 'node_modules', PI_PACKAGE));
  }

  // 3. the bundled copy
  return use('bundled', bundledVersion, bundledDir);
}

/** The releases the user can switch to with "Use previous release": intact, in range, other than the one running, newest first (the bundled copy last). */
export function previousChoices(resolution: PiResolution): { release: string; label: string }[] {
  const choices = (resolution.managed?.releases ?? [])
    .filter((r) => r.intact && r.inRange && !(resolution.source === 'managed' && r.version === resolution.version))
    .sort((a, b) => compareVersions(b.version, a.version) ?? 0)
    .map((r) => ({ release: r.version, label: `pi ${r.version} (managed install)` }));
  if (resolution.source !== 'bundled') choices.push({ release: 'bundled', label: `pi ${resolution.bundled.version} (bundled with pi-kit)` });
  return choices;
}

/** The sibling package of the pi package (`pi-mcp` lives next to it in every layout), falling back to the bundled one. */
export function siblingPackageDir(resolution: PiResolution, name: string): string {
  const next = join(dirname(resolution.packageDir), name);
  return existsSync(join(next, 'package.json')) ? next : join(dirname(resolution.bundled.packageDir), name);
}

/** MCP from the selected SDK, with the app's bundled client as the fallback. */
export function piMcpEntry(resolution: PiResolution): string {
  const installed = join(siblingPackageDir(resolution, 'pi-mcp'), 'dist', 'index.js');
  return [join(resolution.packageDir, 'dist', 'mcp.js'), installed, join(resolution.bundled.packageDir, 'dist', 'mcp.js')].find((file) => existsSync(file)) ?? installed;
}
