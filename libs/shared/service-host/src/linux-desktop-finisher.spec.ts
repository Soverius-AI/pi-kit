import { describe, expect, it, vi } from 'vitest';
import { startLinuxDesktopFinisher } from './linux-desktop-finisher';

const options = {
  program: '/home/user/My $desktop.AppImage',
  args: ['-e', "require('/path with spaces/$backend')", '--', '--finish-desktop-update', '/stage/plan.json'],
  env: {
    ELECTRON_RUN_AS_NODE: '1',
    PI_KIT_DATA_DIR: '/profile with spaces',
    DISPLAY: ':0',
    MISSING: undefined,
  },
};

describe('Linux desktop finisher isolation', () => {
  it('launches an independent user service and waits for exec startup, not just fork/spawn', () => {
    const run = vi.fn();
    startLinuxDesktopFinisher(options, { run });
    expect(run).toHaveBeenCalledTimes(1);
    const [program, args] = run.mock.calls[0] as [string, string[]];
    expect(program).toBe('systemd-run');
    expect(args).toEqual([
      '--user',
      '--quiet',
      '--collect',
      expect.stringMatching(/^--unit=pi-kit-desktop-update-[a-f0-9-]+\.service$/),
      '--service-type=exec',
      '--expand-environment=no',
      '--property=Restart=no',
      '--property=StandardInput=null',
      '--property=StandardOutput=null',
      '--property=StandardError=journal',
      '--setenv=ELECTRON_RUN_AS_NODE=1',
      '--setenv=PI_KIT_DATA_DIR=/profile with spaces',
      '--setenv=DISPLAY=:0',
      '--',
      options.program,
      ...options.args,
    ]);
    expect(args).not.toContain('--scope');
    expect(args).not.toContain('--no-block');
    expect(args).not.toContain('--wait');
  });

  it('uses distinct transient units for concurrent update attempts', () => {
    const run = vi.fn();
    startLinuxDesktopFinisher(options, { run });
    startLinuxDesktopFinisher(options, { run });
    const units = run.mock.calls.map((call) => (call[1] as string[]).find((arg) => arg.startsWith('--unit=')));
    expect(units[0]).not.toBe(units[1]);
  });

  it.each(['systemd-run missing', 'user bus unavailable', 'exec failed', 'unsupported systemd option'])(
    'fails closed without fallback when %s',
    (message) => {
      const cause = new Error(message);
      const run = vi.fn(() => {
        throw cause;
      });
      expect(() => startLinuxDesktopFinisher(options, { run })).toThrow('Refusing an unsafe detached-process fallback');
      expect(run).toHaveBeenCalledTimes(1);
      try {
        startLinuxDesktopFinisher(options, { run });
      } catch (error) {
        expect((error as Error).cause).toBe(cause);
      }
    },
  );
});
