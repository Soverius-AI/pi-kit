import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  LaunchDaemonService,
  LaunchdService,
  launchAgentArguments,
  launchAgentPlist,
  type ServiceManager,
  type ServiceSpec,
  SystemdService,
  systemdExecStart,
  systemdUnit,
} from './service-registration';
import {
  otherCommand,
  otherInstall,
  scheduledTaskXml,
  serviceBatch,
  serviceHandover,
  WindowsTaskService,
} from './service-spec';

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
      await writeFile(path, launchAgentPlist(spec, 'ana'));
      execFileSync('plutil', ['-lint', path]);
      const parsed = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', path], { encoding: 'utf8' }));

      expect(parsed.ProgramArguments).toEqual([spec.program, ...spec.args]);
      expect(parsed.EnvironmentVariables).toEqual(spec.env);
      expect(parsed.UserName).toBe('ana');
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
      const supervisor = join(root, 'server', 'backend', 'pi-kit.cjs');
      expect(otherInstall(starting(['/node', supervisor, '--pi-kit-service']), ours)).toEqual({
        entry: theirs,
        version: '2.0.0',
      });
      expect(otherInstall(starting(['/node', ours]), ours)).toBeUndefined();

      // A Windows desktop registers its .exe; a server's plain Node reads its version beside its resources.
      await mkdir(join(root, 'desktop', 'resources', 'backend'), { recursive: true });
      await writeFile(join(root, 'desktop', 'resources', 'backend', 'service-host.cjs'), '');
      await writeFile(join(root, 'desktop', 'resources', 'package.json'), '{"version":"3.0.0"}');
      const desktop = join(root, 'desktop', 'pi-kit.exe');
      expect(otherInstall(starting([desktop, '--pi-kit-service']), ours)).toEqual({
        entry: join(root, 'desktop', 'resources', 'backend', 'service-host.cjs'),
        version: '3.0.0',
      });
      // A server's task sees the desktop's sign-in entry, the other kind of registration for the profile.
      const task = { registered: () => undefined, otherRegistration: () => [desktop] } as unknown as ServiceManager;
      expect(otherInstall(task, ours)?.version).toBe('3.0.0');
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

describe('starting at boot', () => {
  it('macOS: installs a root-owned LaunchDaemon that runs the host as its owner, through sudo', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pk-daemons-'));
    try {
      const commands: string[][] = [];
      let staged = '';
      const sudo = async (file: string, args: string[]) => {
        commands.push([file, ...args]);
        if (file === 'install') {
          staged = await readFile(args[args.length - 2], 'utf8');
          await copyFile(args[args.length - 2], args[args.length - 1]);
        }
        if (file === 'rm') await rm(args[args.length - 1], { force: true });
        return { code: 0, output: '' };
      };
      const daemon = new LaunchDaemonService(spec, sudo, 'ana', '/Users/ana', root);
      const plist = join(root, `${spec.name}.plist`);

      // Nothing to boot out yet: launchctl would print "Boot-out failed: 3: No such process" into the terminal.
      expect(await daemon.install()).toBe(true);
      expect(commands).toEqual([
        ['install', '-m', '644', '-o', 'root', '-g', 'wheel', expect.stringContaining(spec.name), plist],
        ['launchctl', 'bootstrap', 'system', plist],
      ]);
      expect(staged).toContain('<key>UserName</key>\n  <string>ana</string>');
      expect(staged).toContain('<key>HOME</key>\n    <string>/Users/ana</string>');
      expect(daemon.registered()).toEqual([spec.program, ...spec.args]);

      commands.length = 0;
      await daemon.uninstall();
      await daemon.uninstall();
      expect(commands).toEqual([
        ['launchctl', 'bootout', `system/${spec.name}`],
        ['rm', '-f', plist],
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    ['running', []],
    ['not running', [['launchctl', 'kickstart', `system/${spec.name}`]]],
  ])(
    'macOS: re-installing an unchanged LaunchDaemon that is %s asks sudo only to start it',
    async (state, expected) => {
      const root = await mkdtemp(join(tmpdir(), 'pk-daemons-'));
      try {
        const commands: string[][] = [];
        const sudo = async (file: string, args: string[]) => {
          commands.push([file, ...args]);
          if (file === 'install') await copyFile(args[args.length - 2], args[args.length - 1]);
          return { code: 0, output: '' };
        };
        const print = async () => ({ code: 0, output: `system/${spec.name} = {\n\tstate = ${state}\n}` });
        const daemon = new LaunchDaemonService(spec, sudo, 'ana', '/Users/ana', root, print);
        await daemon.install();
        commands.length = 0;
        expect(await daemon.install()).toBe(false);
        expect(commands).toEqual(expected);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it('macOS: a LaunchAgent is refused while the LaunchDaemon of the same name is installed', async () => {
    const home = await mkdtemp(join(tmpdir(), 'pk-home-'));
    const daemons = await mkdtemp(join(tmpdir(), 'pk-daemons-'));
    try {
      const agent = new LaunchdService(spec, async () => ({ code: 0, output: '' }), home, 501, daemons);
      expect(await agent.unsupported()).toBeUndefined();
      await writeFile(join(daemons, `${spec.name}.plist`), '');
      expect(await agent.unsupported()).toContain('pi-kit service uninstall --level boot');
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(daemons, { recursive: true, force: true });
    }
  });

  it('Windows: a batch file sets the service environment that a task action cannot carry', () => {
    const batch = serviceBatch({
      ...spec,
      env: { PI_KIT_DATA_DIR: 'C:\\Users\\ana\\pi-kit', PATH: 'C:\\bin;%SystemRoot%' },
    });
    expect(batch.split('\r\n')).toEqual([
      '@echo off',
      'set "PI_KIT_DATA_DIR=C:\\Users\\ana\\pi-kit"',
      'set "PATH=C:\\bin;%%SystemRoot%%"',
      `"${spec.program}" "${spec.args[0]}"`,
      '',
    ]);
  });

  it('Windows: registers a boot task with a stored password that restarts after a failure, then runs it', async () => {
    const data = await mkdtemp(join(tmpdir(), 'pk-task-'));
    try {
      const calls: string[][] = [];
      let xml = '';
      const terminal = async (file: string, args: string[]) => {
        calls.push([file, ...args]);
        if (args[0] === '/Create') xml = (await readFile(args[args.indexOf('/XML') + 1])).toString('utf16le');
        return { code: 0, output: '' };
      };
      const task = new WindowsTaskService(
        { ...spec, env: { ...spec.env, PI_KIT_DATA_DIR: data } },
        async () => undefined,
        terminal,
        { account: 'BOX\\ana', sid: 'S-1-5-21-1-2-3-1001' },
      );

      expect(await task.install()).toBe(true);
      expect(calls).toEqual([
        ['schtasks', '/Create', '/TN', spec.name, '/XML', expect.any(String), '/RU', 'BOX\\ana', '/RP', '*', '/F'],
        ['schtasks', '/Run', '/TN', spec.name],
      ]);
      expect(xml.startsWith('\ufeff<?xml version="1.0" encoding="UTF-16"?>')).toBe(true);
      expect(xml).toBe(
        `\ufeff${scheduledTaskXml(join(data, 'service.cmd'), 'BOX\\ana', spec.description, 'S-1-5-21-1-2-3-1001')}`,
      );
      // An unelevated desktop that takes the service over must be able to remove a task an elevated prompt made.
      expect(xml).toContain(
        '<SecurityDescriptor>D:(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;S-1-5-21-1-2-3-1001)</SecurityDescriptor>',
      );
      expect(xml).toContain('<BootTrigger><Enabled>true</Enabled></BootTrigger>');
      expect(xml).toContain('<LogonType>Password</LogonType>');
      expect(xml).toContain('<RestartOnFailure>');
      expect(task.registered()).toEqual([spec.program, ...spec.args]);
    } finally {
      await rm(data, { recursive: true, force: true });
    }
  });

  it('Windows: an existing task only gets its new batch, so no password is asked again', async () => {
    const data = await mkdtemp(join(tmpdir(), 'pk-task-'));
    try {
      const calls: string[][] = [];
      const terminal = async (file: string, args: string[]) => (calls.push([file, ...args]), { code: 0, output: '' });
      let stops = 0;
      const task = (args: string[]) =>
        new WindowsTaskService(
          { ...spec, args, env: { ...spec.env, PI_KIT_DATA_DIR: data } },
          async () => void stops++,
          terminal,
          { account: 'BOX\\ana', sid: 'S-1-5-21-1-2-3-1001' },
          () => true,
        );
      await writeFile(join(data, 'service.cmd'), 'an older batch');

      expect(await task(['C:\\pi-kit\\backend\\pi-kit.cjs', '--pi-kit-service']).install()).toBe(true);
      expect(calls).toEqual([['schtasks', '/Run', '/TN', spec.name]]);
      expect(stops).toBe(1);
      expect(task([]).registered()).toEqual([spec.program, 'C:\\pi-kit\\backend\\pi-kit.cjs', '--pi-kit-service']);

      calls.length = 0;
      expect(await task(['C:\\pi-kit\\backend\\pi-kit.cjs', '--pi-kit-service']).install()).toBe(false);
      expect(calls).toEqual([['schtasks', '/Run', '/TN', spec.name]]);
      expect(stops).toBe(1);
    } finally {
      await rm(data, { recursive: true, force: true });
    }
  });
});

describe('two installs on one profile', () => {
  it.each([
    ['a newer host runs', '1.0.0', '2.0.0', undefined, { action: 'update-first', version: '2.0.0' }],
    ['a newer install is registered', '1.0.0', undefined, '2.0.0', { action: 'update-first', version: '2.0.0' }],
    ['an install of its own version is registered', '1.0.0', '1.0.0', '1.0.0', { action: 'attach' }],
    ['an older install is registered', '2.0.0', '1.0.0', '1.0.0', { action: 'register' }],
    ['the registered install is gone', '1.0.0', undefined, 'unknown', { action: 'register' }],
    ['only this app is registered', '1.0.0', '1.0.0', undefined, { action: 'register' }],
  ])('a starting desktop when %s', (_, own, running, registered, expected) => {
    expect(serviceHandover(own, running, registered ? { version: registered } : undefined)).toEqual(expected);
  });

  it('Windows: a server task that takes over removes the desktop sign-in entry and stops its host', async () => {
    const data = await mkdtemp(join(tmpdir(), 'pk-task-'));
    try {
      const steps: string[] = [];
      const terminal = async (file: string, args: string[]) => (
        steps.push(`${file} ${args[0]}`),
        { code: 0, output: '' }
      );
      const task = new WindowsTaskService(
        { ...spec, env: { ...spec.env, PI_KIT_DATA_DIR: data } },
        async () => void steps.push('stop host'),
        terminal,
        { account: 'BOX\\ana', sid: 'S-1-5-21-1-2-3-1001' },
        () => false,
      );
      let entry: string[] | undefined = ['C:\\pi-kit\\pi-kit.exe', '--pi-kit-service'];
      task.sibling = {
        registered: () => entry,
        uninstall: async () => void (steps.push('remove sign-in entry'), (entry = undefined)),
      };
      await task.install();
      expect(steps).toEqual(['remove sign-in entry', 'stop host', 'schtasks /Create', 'schtasks /Run']);
    } finally {
      await rm(data, { recursive: true, force: true });
    }
  });

  it('Windows: a task Windows refuses to remove keeps its batch, and says so', async () => {
    const data = await mkdtemp(join(tmpdir(), 'pk-task-'));
    try {
      await writeFile(join(data, 'service.cmd'), 'the batch');
      const refused = async (_file: string, args: string[]) => ({ code: args[0] === '/Delete' ? 1 : 0, output: '' });
      const task = new WindowsTaskService(
        { ...spec, env: { ...spec.env, PI_KIT_DATA_DIR: data } },
        async () => undefined,
        refused,
        { account: 'BOX\\ana' },
        () => true,
      );
      await expect(task.uninstall()).rejects.toThrow(/schtasks \/Delete failed/);
      expect(await readFile(join(data, 'service.cmd'), 'utf8')).toBe('the batch');
    } finally {
      await rm(data, { recursive: true, force: true });
    }
  });

  it('never writes the desktop launcher over another install’s pi-kit command', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pk-bin-'));
    try {
      const server = join(dir, 'server-bin-pi-kit');
      await writeFile(server, '#!/bin/sh\n# pi-kit, on the Node runtime this server install carries.\n');
      expect(otherCommand(join(dir, 'free'))).toBeUndefined();
      await writeFile(join(dir, 'ours'), '#!/bin/sh\n# Written by pi-kit (Settings > General > Background).\n');
      expect(otherCommand(join(dir, 'ours'))).toBeUndefined();
      await symlink(server, join(dir, 'linked'));
      expect(otherCommand(join(dir, 'linked'))).toBe(await realpath(server));
      expect(otherCommand(server)).toBe(server);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
