import { execFile, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { findPathPi } from './detect';

vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  return { ...actual, execFile: vi.fn(actual.execFile) };
});

const folders: string[] = [];
afterEach(() => {
  vi.mocked(execFile).mockRestore();
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function launcher(name: string) {
  const root = mkdtempSync(join(tmpdir(), 'pk-path-pi-'));
  folders.push(root);
  const dir = join(root, 'Pi tools & spaces %unexpanded% !delayed!');
  mkdirSync(dir);
  const path = join(dir, name);
  writeFileSync(path, '@echo off\r\necho pi 1.5.2\r\n');
  return { root, dir, path };
}

function versionOutput(error: Error | null = null, stdout = 'pi 1.5.2\n') {
  vi.mocked(execFile).mockImplementation(((...args: unknown[]) => {
    const callback = args.at(-1) as (error: Error | null, stdout: string, stderr: string) => void;
    callback(error, stdout, '');
    return {} as ChildProcess;
  }) as typeof execFile);
}

describe('pi command detection', () => {
  it.each(['pi.cmd', 'pi.bat'])(
    'runs Windows %s launchers through cmd without interpolating the path',
    async (name) => {
      const { root, dir, path } = launcher(name);
      const own = join(root, 'node_modules', '.bin');
      mkdirSync(own, { recursive: true });
      writeFileSync(join(own, name), 'not the user launcher');
      versionOutput();
      const env = { Path: `${own};"${dir}"`, ComSpec: 'C:\\Windows\\System32\\cmd.exe', KEEP: 'yes' };
      expect(await findPathPi(env, 'win32')).toEqual({ found: true, path, version: '1.5.2' });
      expect(execFile).toHaveBeenCalledExactlyOnceWith(
        env.ComSpec,
        ['/d', '/v:off', '/s', '/c', '""%PI_KIT_PI_VERSION_PROBE%" --version"'],
        expect.objectContaining({
          windowsHide: true,
          windowsVerbatimArguments: true,
          timeout: 3000,
          env: expect.objectContaining({
            KEEP: 'yes',
            PATH: env.Path,
            PI_KIT_PI_VERSION_PROBE: path,
            PI_OFFLINE: '1',
            PI_SKIP_VERSION_CHECK: '1',
            NO_COLOR: '1',
          }),
        }),
        expect.any(Function),
      );
      const options = vi.mocked(execFile).mock.calls[0][2] as { env: NodeJS.ProcessEnv };
      expect(Object.keys(options.env).filter((key) => key.toLowerCase() === 'path')).toEqual(['PATH']);
    },
  );

  it('executes Windows native binaries directly without a shell', async () => {
    const { dir, path } = launcher('pi.exe');
    versionOutput();
    expect(await findPathPi({ PATH: dir }, 'win32')).toEqual({ found: true, path, version: '1.5.2' });
    expect(execFile).toHaveBeenCalledExactlyOnceWith(
      path,
      ['--version'],
      expect.not.objectContaining({ windowsVerbatimArguments: true }),
      expect.any(Function),
    );
  });

  it('contains synchronous spawn errors instead of failing setup detection', async () => {
    const name = process.platform === 'win32' ? 'pi.cmd' : 'pi';
    const { dir, path } = launcher(name);
    vi.mocked(execFile).mockImplementation(() => {
      throw Object.assign(new Error('spawn EINVAL'), { code: 'EINVAL', syscall: 'spawn' });
    });
    await expect(findPathPi({ PATH: dir })).resolves.toEqual({ found: true, path });
  });

  it('contains callback errors and timeouts without inventing a version', async () => {
    const name = process.platform === 'win32' ? 'pi.cmd' : 'pi';
    const { dir, path } = launcher(name);
    versionOutput(Object.assign(new Error('probe timed out'), { killed: true }), '');
    await expect(findPathPi({ PATH: dir })).resolves.toEqual({ found: true, path });
  });

  it('does not start a process when no pi launcher exists', async () => {
    versionOutput();
    await expect(findPathPi({ PATH: '' })).resolves.toEqual({ found: false });
    expect(execFile).not.toHaveBeenCalled();
  });

  it.runIf(process.platform === 'win32').each(['pi.cmd', 'pi.bat'])(
    'reads the version from a real Windows %s launcher in a metacharacter-containing path',
    async (name) => {
      const { dir, path } = launcher(name);
      // Keep the real Windows cmd.exe and filesystem; no mock of process creation in this regression.
      const original = await vi.importActual<typeof import('node:child_process')>('node:child_process');
      vi.mocked(execFile).mockImplementation(original.execFile);
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
      await expect(
        findPathPi({ ...env, Path: dir, unexpanded: 'must-not-expand', delayed: 'must-not-expand' }, 'win32'),
      ).resolves.toEqual({ found: true, path, version: '1.5.2' });
    },
  );
});
