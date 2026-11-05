import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { launchAgentPlist, type ServiceSpec, systemdUnit } from './service-registration';

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
