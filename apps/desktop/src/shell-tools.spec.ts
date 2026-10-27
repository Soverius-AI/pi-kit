import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loginShellPath } from './shell-env';

describe.skipIf(process.platform === 'win32')('desktop tool discovery', () => {
  let home: string;
  const shell = (source: string): string => {
    const file = join(home, 'shell');
    writeFileSync(file, `#!/bin/sh\n${source}\n`);
    chmodSync(file, 0o755);
    return file;
  };
  const toolchain = (dir: string): void => {
    mkdirSync(dir, { recursive: true });
    symlinkSync(process.execPath, join(dir, 'node'));
    writeFileSync(join(dir, 'npm'), '#!/usr/bin/env node\nconsole.log("fixture-npm");\n', { mode: 0o755 });
  };
  const npm = (path: string | undefined) => spawnSync('npm', ['--version'], { env: { ...process.env, PATH: path }, encoding: 'utf8' });

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'pk-desktop-path-'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('PATH', '/usr/bin:/bin');
    vi.stubEnv('NVM_DIR', join(home, '.nvm'));
    vi.stubEnv('NVM_BIN', '');
    vi.stubEnv('VOLTA_HOME', join(home, '.volta'));
    vi.stubEnv('XDG_DATA_HOME', join(home, 'data'));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  it('can spawn npm and its node interpreter after login-shell startup times out', () => {
    const bin = join(home, '.nvm', 'versions', 'node', 'v24.1.0', 'bin');
    toolchain(bin);
    vi.stubEnv('NVM_BIN', bin);
    vi.stubEnv('SHELL', shell('exec /bin/sleep 1'));
    const result = npm(loginShellPath(20));
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('fixture-npm');
  });

  it('finds pi’s managed node and npm when the GUI environment has no version-manager variables', () => {
    toolchain(join(home, 'data', 'pi-node', 'current', 'bin'));
    vi.stubEnv('SHELL', shell('exit 1'));
    expect(npm(loginShellPath()).stdout.trim()).toBe('fixture-npm');
  });

  it('discovers nvm installations without NVM_BIN and preserves the shell’s selected version first', () => {
    const selected = join(home, '.nvm', 'versions', 'node', 'v22.1.0', 'bin');
    const newer = join(home, '.nvm', 'versions', 'node', 'v24.1.0', 'bin');
    toolchain(selected);
    toolchain(newer);
    vi.stubEnv('SHELL', shell(`printf '%s' '__PI_KIT_PATH__${selected}:/usr/bin:/bin__PI_KIT_PATH__'`));
    const paths = loginShellPath()!.split(delimiter);
    expect(paths[0]).toBe(selected);
    expect(paths).toContain(newer);
    expect(paths.filter((path) => path === selected)).toHaveLength(1);
  });

  it('keeps inherited tools available when the shell cannot start', () => {
    vi.stubEnv('SHELL', join(home, 'missing-shell'));
    expect(loginShellPath()!.split(delimiter).slice(0, 2)).toEqual(['/usr/bin', '/bin']);
  });
});
