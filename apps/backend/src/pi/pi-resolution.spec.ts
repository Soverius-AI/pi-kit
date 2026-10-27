import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bundledPiDir, inRange, piMcpEntry, previousChoices, resolvePi, siblingPackageDir, withinMax } from './pi-resolution';

const RANGE = { min: '1.3.0', max: '1.x' };
let base: string;
let agentDir: string;
let bundledDir: string;

function packageIn(dir: string, version: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version }));
}

/** A managed install like pi's: marker, `current-version`, and releases that are intact unless said otherwise. */
function managedInstall(releases: { version: string; intact?: boolean }[], current?: string, marker = true): void {
  const root = join(agentDir, 'install');
  mkdirSync(join(root, 'releases'), { recursive: true });
  if (marker) writeFileSync(join(root, 'managed-install.json'), JSON.stringify({ kind: 'pi-managed-install', schemaVersion: 1, layout: 'releases-v1' }));
  if (current) writeFileSync(join(root, 'current-version'), `${current}\n`);
  for (const { version, intact = true } of releases) {
    const dir = join(root, 'releases', version);
    mkdirSync(dir, { recursive: true });
    if (!intact) continue;
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'install', version }));
    packageIn(join(dir, 'node_modules', '@earendil-works', 'pi-coding-agent'), version);
  }
}

const resolve = (extra: { env?: NodeJS.ProcessEnv; pinned?: string } = {}) => resolvePi({ env: extra.env ?? {}, agentDir, bundledDir, range: RANGE, ...(extra.pinned ? { pinned: extra.pinned } : {}) });

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'pk-resolve-'));
  agentDir = join(base, 'agent');
  bundledDir = join(base, 'app', 'node_modules', '@earendil-works', 'pi-coding-agent');
  mkdirSync(agentDir, { recursive: true });
  packageIn(bundledDir, '1.3.0');
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe('the SDK range', () => {
  it('reads x as "any", and the bounds as inclusive', () => {
    expect(withinMax('1.99.0', '1.x')).toBe(true);
    expect(withinMax('1.1000000.0', '1.x')).toBe(true);
    expect(withinMax('2.0.0', '1.x')).toBe(false);
    expect(withinMax('1.3.9', '1.3.x')).toBe(true);
    expect(withinMax('1.4.0', '1.3.x')).toBe(false);
    expect(withinMax('1.3.2', '1.3.2')).toBe(true);
    expect(withinMax('1.3.3', '1.3.2')).toBe(false);
    expect(inRange('1.3.0', RANGE)).toBe(true);
    expect(inRange('1.2.9', RANGE)).toBe(false);
    expect(inRange('2.0.0', RANGE)).toBe(false);
  });
});

it('finds the Nx-built SDK in assets before a development node_modules copy', () => {
  const backend = join(base, 'app');
  const sdk = join(backend, 'assets', 'pi');
  packageIn(sdk, '1.3.0');
  expect(bundledPiDir(backend)).toBe(sdk);
  rmSync(sdk, { recursive: true });
  expect(bundledPiDir(backend)).toBe(bundledDir);
});

describe('resolvePi: PI_KIT_PI_DIR, then pi’s managed install, then the bundled copy', () => {
  it('uses the bundled copy when there is no managed install', () => {
    expect(resolve()).toMatchObject({ source: 'bundled', version: '1.3.0', packageDir: bundledDir, notes: [] });
  });

  it('uses the release `current-version` names when it is intact, newer and in range', () => {
    managedInstall([{ version: '1.3.0' }, { version: '1.3.4' }], '1.3.4');
    const result = resolve();
    expect(result).toMatchObject({ source: 'managed', version: '1.3.4', notes: [] });
    expect(result.packageDir).toBe(join(agentDir, 'install', 'releases', '1.3.4', 'node_modules', '@earendil-works', 'pi-coding-agent'));
    expect(result.managed?.releases.map((r) => r.version)).toEqual(['1.3.0', '1.3.4']);
  });

  it('takes a release equal to the bundled one (the same version is fine)', () => {
    managedInstall([{ version: '1.3.0' }], '1.3.0');
    expect(resolve()).toMatchObject({ source: 'managed', version: '1.3.0' });
  });

  it('ignores a managed release older than the bundled copy, and says so', () => {
    managedInstall([{ version: '1.2.0' }], '1.2.0');
    // below `min` it is the range gate that says no; inside the range, the bundled copy is what is newer
    expect(resolve().notes.join(' ')).toMatch(/pi 1\.2\.0 is installed, this pi-kit needs 1\.3\.0 or newer/);
    const result = resolvePi({ env: {}, agentDir, bundledDir, range: { min: '1.0.0', max: '1.x' } });
    expect(result).toMatchObject({ source: 'bundled', version: '1.3.0' });
    expect(result.notes.join(' ')).toMatch(/pi 1\.2\.0 is installed, older than the bundled 1\.3\.0/);
  });

  it('the range gate: a release above `max` is listed and not loaded, with the line the plan asks for', () => {
    managedInstall([{ version: '2.0.0' }], '2.0.0');
    const result = resolve();
    expect(result).toMatchObject({ source: 'bundled', version: '1.3.0' });
    expect(result.notes).toEqual(['pi 2.0.0 is installed, this pi-kit supports up to 1.x; using the bundled 1.3.0.']);
    expect(result.managed?.releases).toEqual([expect.objectContaining({ version: '2.0.0', intact: true, inRange: false })]);
  });

  it('falls back to the newest eligible release when the current one is above the range', () => {
    managedInstall([{ version: '1.3.5' }, { version: '2.0.0' }], '2.0.0');
    const result = resolve();
    expect(result).toMatchObject({ source: 'managed', version: '1.3.5' });
    expect(result.notes[0]).toMatch(/pi 2\.0\.0 is installed, this pi-kit supports up to 1\.x; using pi 1\.3\.5/);
  });

  it('the range gate also refuses a release below `min`', () => {
    managedInstall([{ version: '1.2.9' }], '1.2.9');
    expect(resolve()).toMatchObject({ source: 'bundled' });
  });

  it('does not load a release whose folder is incomplete', () => {
    managedInstall([{ version: '1.3.4', intact: false }], '1.3.4');
    const result = resolve();
    expect(result).toMatchObject({ source: 'bundled' });
    expect(result.notes.join(' ')).toMatch(/pi 1\.3\.4 is installed .* but its folder is incomplete/);
    expect(result.managed?.releases[0]).toMatchObject({ version: '1.3.4', intact: false });
  });

  it('does not trust a folder that is not a managed install (no valid marker)', () => {
    managedInstall([{ version: '1.3.4' }], '1.3.4', false);
    expect(resolve()).toMatchObject({ source: 'bundled' });
    expect(resolve().managed).toBeUndefined();
  });

  it('PI_KIT_PI_DIR wins over everything, as a package folder or as a release folder', () => {
    managedInstall([{ version: '1.3.4' }], '1.3.4');
    const pkg = join(base, 'dev', 'pi');
    packageIn(pkg, '1.9.0');
    expect(resolve({ env: { PI_KIT_PI_DIR: pkg } })).toMatchObject({ source: 'env', version: '1.9.0', packageDir: pkg });
    const release = join(base, 'dev', 'release');
    packageIn(join(release, 'node_modules', '@earendil-works', 'pi-coding-agent'), '1.8.0');
    expect(resolve({ env: { PI_KIT_PI_DIR: release } })).toMatchObject({ source: 'env', version: '1.8.0' });
  });

  it('a PI_KIT_PI_DIR that is not pi is ignored with a note', () => {
    const result = resolve({ env: { PI_KIT_PI_DIR: join(base, 'nowhere') } });
    expect(result).toMatchObject({ source: 'bundled' });
    expect(result.notes[0]).toMatch(/PI_KIT_PI_DIR .* is not a pi package/);
  });
});

describe('"Use previous release"', () => {
  it('pins to a managed release (even an older eligible one) or to the bundled copy', () => {
    managedInstall([{ version: '1.3.1' }, { version: '1.3.4' }], '1.3.4');
    expect(resolve({ pinned: '1.3.1' })).toMatchObject({ source: 'managed', version: '1.3.1', pinned: '1.3.1' });
    expect(resolve({ pinned: 'bundled' })).toMatchObject({ source: 'bundled', version: '1.3.0', pinned: 'bundled' });
  });

  it('a pin that is gone follows the newest and says so', () => {
    managedInstall([{ version: '1.3.4' }], '1.3.4');
    const result = resolve({ pinned: '1.3.1' });
    expect(result).toMatchObject({ source: 'managed', version: '1.3.4' });
    expect(result.notes[0]).toMatch(/pinned release pi 1\.3\.1 is not available/);
  });

  it('lists what can be switched to: other intact in-range releases, newest first, then the bundled copy', () => {
    managedInstall([{ version: '1.3.1' }, { version: '1.3.4' }, { version: '1.3.2', intact: false }, { version: '2.0.0' }], '1.3.4');
    expect(previousChoices(resolve()).map((c) => c.release)).toEqual(['1.3.1', 'bundled']);
    expect(previousChoices(resolve({ pinned: 'bundled' })).map((c) => c.release)).toEqual(['1.3.4', '1.3.1']);
  });
});

describe('siblingPackageDir', () => {
  it('uses managed MCP when available, otherwise the Nx-built bundled client', () => {
    managedInstall([{ version: '1.3.4' }], '1.3.4');
    const bundledMcp = join(bundledDir, 'dist', 'mcp.js');
    mkdirSync(dirname(bundledMcp), { recursive: true });
    writeFileSync(bundledMcp, '');
    expect(piMcpEntry(resolve())).toBe(bundledMcp);
    const managedMcp = join(agentDir, 'install/releases/1.3.4/node_modules/@earendil-works/pi-mcp');
    mkdirSync(join(managedMcp, 'dist'), { recursive: true });
    writeFileSync(join(managedMcp, 'package.json'), '{}');
    writeFileSync(join(managedMcp, 'dist/index.js'), '');
    expect(piMcpEntry(resolve())).toBe(join(managedMcp, 'dist/index.js'));
  });
  it('finds pi-mcp next to the pi package of the chosen release, else next to the bundled one', () => {
    managedInstall([{ version: '1.3.4' }], '1.3.4');
    const mcp = join(agentDir, 'install', 'releases', '1.3.4', 'node_modules', '@earendil-works', 'pi-mcp');
    mkdirSync(mcp, { recursive: true });
    writeFileSync(join(mcp, 'package.json'), '{}');
    expect(siblingPackageDir(resolve(), 'pi-mcp')).toBe(mcp);
    rmSync(mcp, { recursive: true });
    expect(siblingPackageDir(resolve(), 'pi-mcp')).toBe(join(base, 'app', 'node_modules', '@earendil-works', 'pi-mcp'));
  });
});
