import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LAUNCHER, activate, installPiCommand, piCommandState, npmCiInvocation, piToolEnvironment, piToolPath } from './managed-install';

let home: string;
let agentDir: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'pk-install-'));
  agentDir = join(home, '.pi', 'agent');
  mkdirSync(join(agentDir, 'install'), { recursive: true });
  writeFileSync(join(agentDir, 'install', 'managed-install.json'), JSON.stringify({ kind: 'pi-managed-install', schemaVersion: 1, layout: 'releases-v1', entrypoint: { type: 'symlink', path: join(home, '.local', 'bin', 'pi') } }));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('npm bootstrap on Windows', () => {
  it('launches the npm.cmd batch file through cmd.exe with fixed arguments and AutoRun disabled', () => {
    const env = { ComSpec: 'C:\\Windows\\System32\\cmd.exe' };
    const windows = npmCiInvocation(env, 'win32');
    expect(windows.command).toBe(env.ComSpec);
    expect(windows.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    expect(windows.args[3]).toMatch(/^npm\.cmd ci --ignore-scripts /);
    expect(windows.args[3]).toContain('--include=optional');
    expect(npmCiInvocation({}, 'win32').command).toBe('cmd.exe');
    expect(npmCiInvocation({}, 'darwin')).toMatchObject({ command: 'npm', args: expect.arrayContaining(['ci', '--ignore-scripts']) });
  });

  it('preserves Windows mixed-case Path and forwards only one PATH entry', () => {
    const path = 'C:\\Program Files\\nodejs;C:\\Windows\\System32';
    const env = { Path: path, XDG_DATA_HOME: home, KEEP: 'yes' };
    expect(piToolPath(env)).toBe(path);
    expect(piToolEnvironment(env)).toEqual({ PATH: path, XDG_DATA_HOME: home, KEEP: 'yes' });
    const mixed = piToolEnvironment({ ...env, PATH: 'explicit-path', path: 'duplicate' });
    expect(Object.keys(mixed).filter((key) => key.toLowerCase() === 'path')).toEqual(['PATH']);
    expect(mixed['PATH']).toBe('explicit-path');
  });
});

describe('the pi command', () => {
  it('is not on PATH until the launcher and the symlink exist, then is', () => {
    expect(piCommandState(agentDir, home)).toMatchObject({ launcherInstalled: false, onPath: false, entrypoint: join(home, '.local', 'bin', 'pi') });
    const state = installPiCommand(agentDir, home);
    expect(state).toMatchObject({ launcherInstalled: true, onPath: true });
    expect(statSync(join(agentDir, 'bin', 'pi')).mode & 0o111).not.toBe(0);
    expect(readFileSync(join(agentDir, 'bin', 'pi'), 'utf8')).toBe(LAUNCHER);
    expect(lstatSync(state.entrypoint).isSymbolicLink()).toBe(true);
  });

  it('recognises a relative link to the launcher, as pi’s installer writes it', () => {
    mkdirSync(join(agentDir, 'bin'), { recursive: true });
    writeFileSync(join(agentDir, 'bin', 'pi'), LAUNCHER);
    mkdirSync(join(home, '.local', 'bin'), { recursive: true });
    symlinkSync('../../.pi/agent/bin/pi', join(home, '.local', 'bin', 'pi'));
    expect(piCommandState(agentDir, home).onPath).toBe(true);
  });

  it('replaces a link that leads nowhere, and leaves a working pi (a link or a file) alone', () => {
    mkdirSync(join(home, '.local', 'bin'), { recursive: true });
    symlinkSync('/somewhere/gone/pi', join(home, '.local', 'bin', 'pi'));
    expect(installPiCommand(agentDir, home).onPath).toBe(true);
    expect(readlinkSync(join(home, '.local', 'bin', 'pi'))).toBe(join(agentDir, 'bin', 'pi'));
    // a different, working pi
    rmSync(join(home, '.local', 'bin', 'pi'));
    mkdirSync(join(home, 'other'), { recursive: true });
    writeFileSync(join(home, 'other', 'pi'), '#!/bin/sh\n');
    symlinkSync(join(home, 'other', 'pi'), join(home, '.local', 'bin', 'pi'));
    expect(() => installPiCommand(agentDir, home)).toThrow(/already exists \(it points to/);
    rmSync(join(home, '.local', 'bin', 'pi'));
    writeFileSync(join(home, '.local', 'bin', 'pi'), '#!/bin/sh\n');
    expect(() => installPiCommand(agentDir, home)).toThrow(/not a link/);
  });

  it('writes current-version the way pi does (a line with the version)', () => {
    activate(join(agentDir, 'install'), '1.3.4');
    expect(readFileSync(join(agentDir, 'install', 'current-version'), 'utf8')).toBe('1.3.4\n');
  });
});
