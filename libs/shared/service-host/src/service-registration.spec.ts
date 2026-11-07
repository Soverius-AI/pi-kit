import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  launchAgentArguments,
  launchAgentPlist,
  type ServiceManager,
  type ServiceSpec,
  SystemdService,
  systemdExecStart,
  systemdUnit,
} from './service-registration';
import { otherInstall } from './service-spec';

const spec: ServiceSpec = {
  name: 'dev.pi-kit.app.service',
  description: 'pi-kit background service',
  program: '/home/ana lee/Apps/pi-kit & co/pi-kit',
  args: ['/opt/pi-kit/resources/backend/service-host.cjs'],
  env: { ELECTRON_RUN_AS_NODE: '1', PATH: '/usr/bin:$HOME/bin', PI_KIT_DATA_DIR: '/home/ana lee/.config/pi-kit 100%' },
  logDir: '/home/ana lee/.config/pi-kit/logs',
};

describe('service registration files', () => {
  it('keeps systemd from splitting paths with spaces or expanding % and $', () => {
    const unit = systemdUnit(spec);

    expect(unit).toContain(
      'ExecStart="/home/ana lee/Apps/pi-kit & co/pi-kit" "/opt/pi-kit/resources/backend/service-host.cjs"',
    );
    expect(unit).toContain('Environment="PATH=/usr/bin:$$HOME/bin"');
    expect(unit).toContain('Environment="PI_KIT_DATA_DIR=/home/ana lee/.config/pi-kit 100%%"');
  });

  it.skipIf(process.platform !== 'darwin')('writes a plist launchd reads back unchanged', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pk-plist-'));
    try {
      const path = join(dir, 'service.plist');
      await writeFile(path, launchAgentPlist(spec));
      execFileSync('plutil', ['-lint', path]);
      const parsed = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', path], { encoding: 'utf8' }));

      expect(parsed.ProgramArguments).toEqual([spec.program, ...spec.args]);
      expect(parsed.EnvironmentVariables).toEqual(spec.env);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('what a registration starts', () => {
  it('reads back the program and arguments it wrote, odd paths included', () => {
    expect(launchAgentArguments(launchAgentPlist(spec))).toEqual([spec.program, ...spec.args]);
    expect(systemdExecStart(systemdUnit(spec))).toEqual([spec.program, ...spec.args]);
    const odd = { ...spec, args: ['/srv/a "quoted" 100% $HOME\\x/service-host.cjs'] };
    expect(systemdExecStart(systemdUnit(odd))).toEqual([odd.program, ...odd.args]);
    expect(launchAgentArguments(launchAgentPlist(odd))).toEqual([odd.program, ...odd.args]);
  });

  it('names another install the registration starts, by its service host and version', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pk-installs-'));
    try {
      const theirs = join(root, 'server', 'backend', 'service-host.cjs');
      await mkdir(join(root, 'server', 'backend'), { recursive: true });
      await writeFile(theirs, '');
      await writeFile(join(root, 'server', 'package.json'), '{"version":"2.0.0"}');
      const starting = (args: string[]) => ({ registered: () => args }) as unknown as ServiceManager;
      const ours = join(root, 'app', 'backend', 'service-host.cjs');

      expect(otherInstall(starting(['/node', theirs]), ours)).toEqual({ entry: theirs, version: '2.0.0' });
      expect(otherInstall(starting(['/node', ours]), ours)).toBeUndefined();
      expect(otherInstall(starting(['/node', join(root, 'gone', 'backend', 'service-host.cjs')]), ours)).toMatchObject({
        version: 'unknown',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    ['yes', undefined],
    ['no', expect.stringContaining('loginctl enable-linger')],
  ])('notes how to start at boot when linger is %s', async (linger, note) => {
    const service = new SystemdService(spec, async () => ({ code: 0, output: `${linger}\n` }), tmpdir());
    expect(await service.bootNote()).toEqual(note);
  });
});
