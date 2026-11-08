import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  LaunchDaemonService,
  LaunchdService,
  launchAgentArguments,
  launchAgentPlist,
  type RunCommand,
  type ServiceManager,
  type ServiceSpec,
  SystemdService,
  systemdExecStart,
  systemdUnit,
} from './service-registration';
import {
  otherCommand,
  otherInstall,
  ownAppImage,
  scheduledTaskXml,
  serviceBatch,
  serviceHandover,
  serviceSpec,
  WindowsRunService,
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

  it('Linux: an AppImage service starts where AppRun adds --no-sandbox, which Node refuses as an option', () => {
    const appImage = serviceSpec({
      name: 'dev.pi-kit.app.service',
      program: '/tmp/.mount_pi-kit/pi-kit',
      hostEntry: '/tmp/.mount_pi-kit/resources/backend/service-host.cjs',
      dataDir: '/home/ana/.config/pi-kit',
      logDir: '/home/ana/.config/pi-kit/logs',
      appImage: '/home/ana/pi-kit.AppImage',
    });
    // electron-builder's AppRun, on Ubuntu 24.04 and later: --no-sandbox first, unless the arguments hold one.
    const appRun = (args: string[]) => (args.includes('--no-sandbox') ? args : ['--no-sandbox', ...args]);
    const probe = 'process.stdout.write(JSON.stringify(process.argv.slice(1)))';
    const argv = appRun(appImage.args).map((arg, i, all) => (all[i - 1] === '-e' ? probe : arg));
    expect(JSON.parse(execFileSync(process.execPath, argv, { encoding: 'utf8' }))).toEqual(['--no-sandbox']);
  });

  it.skipIf(process.platform === 'win32')(
    'Linux: a stopped AppImage service clears the mount its runtime could not unmount, and no live one',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'pk-mounts-'));
      try {
        const appImage = serviceSpec({
          name: 'dev.pi-kit.app.service',
          program: '/tmp/.mount_pi-kit/pi-kit',
          hostEntry: '/tmp/.mount_pi-kit/resources/backend/service-host.cjs',
          dataDir: '/home/ana/.config/pi-kit',
          logDir: '/home/ana/.config/pi-kit/logs',
          appImage: '/home/ana/pi-kit-0.10.9-linux-arm64.AppImage',
        });
        const unit = systemdUnit(appImage);
        expect(unit).toContain('KillMode=mixed\n');
        const afterStop = systemdExecStart(unit.replace(/^ExecStart=.*$/m, '').replace('ExecStopPost=', 'ExecStart='));
        expect(afterStop).toEqual(appImage.afterStop);

        // A dead FUSE mount fails `ls` like this dangling link; fusermount, faked, turns it into the folder an unmount leaves.
        const bin = join(root, 'bin');
        await mkdir(bin);
        await writeFile(
          join(bin, 'fusermount'),
          '#!/bin/sh\necho "$@" >> "$TMPDIR/unmounted"\nrm "$2" && mkdir "$2"\n',
          {
            mode: 0o755,
          },
        );
        await symlink(join(root, 'gone'), join(root, '.mount_pi-kitDEAD01'));
        await mkdir(join(root, '.mount_pi-kitGONE02'));
        await mkdir(join(root, '.mount_pi-kitLIVE03'));
        await writeFile(join(root, '.mount_pi-kitLIVE03', 'app.asar'), '');
        await symlink(join(root, 'gone'), join(root, '.mount_otherXDEAD04'));
        execFileSync(afterStop[0], afterStop.slice(1), {
          env: { PATH: `${bin}:${process.env['PATH']}`, TMPDIR: root },
        });

        expect(await readFile(join(root, 'unmounted'), 'utf8')).toBe(`-uz ${join(root, '.mount_pi-kitDEAD01')}\n`);
        expect(existsSync(join(root, '.mount_pi-kitDEAD01'))).toBe(false);
        expect(existsSync(join(root, '.mount_pi-kitGONE02'))).toBe(false);
        expect(existsSync(join(root, '.mount_pi-kitLIVE03', 'app.asar'))).toBe(true);
        expect(lstatSync(join(root, '.mount_otherXDEAD04')).isSymbolicLink()).toBe(true);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'Linux: names an AppImage the registration starts by asking the image for its version, which only it can read',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'pk-appimage-'));
      try {
        const image = join(root, 'pi-kit.AppImage');
        await writeFile(image, '#!/bin/sh\nprintf 3.1.0\n', { mode: 0o755 });
        const registration = serviceSpec({
          name: 'dev.pi-kit.app.service',
          program: '/tmp/.mount_pi-kit/pi-kit',
          hostEntry: '/tmp/.mount_pi-kit/resources/backend/service-host.cjs',
          dataDir: '/home/ana/.config/pi-kit',
          logDir: '/home/ana/.config/pi-kit/logs',
          appImage: image,
        });
        const starting = {
          registered: () => [registration.program, ...registration.args],
        } as unknown as ServiceManager;
        const server = '/home/ana/pi-kit-server/backend/service-host.cjs';

        expect(otherInstall(starting, server)).toEqual({ entry: image, version: '3.1.0' });
        expect(otherInstall(starting, image)).toBeUndefined();
        await rm(image);
        expect(otherInstall(starting, server)).toEqual({ entry: image, version: 'unknown' });

        // Only code inside the image's mount is the AppImage: a server's pi-kit run from the app's terminal inherits $APPIMAGE.
        const env = { APPIMAGE: image, APPDIR: '/tmp/.mount_pi-kitAb12' };
        expect(ownAppImage('/tmp/.mount_pi-kitAb12/resources/backend', env)).toBe(image);
        expect(ownAppImage('/home/ana/pi-kit-server/backend', env)).toBeUndefined();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

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
      const unloaded = async () => ({ code: 113, output: '' });
      const daemon = new LaunchDaemonService(spec, sudo, 'ana', '/Users/ana', root, unloaded);
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
    ['running', 0, () => []],
    ['not running', 0, () => [['launchctl', 'kickstart', `system/${spec.name}`]]],
    // Its bootstrap failed: launchd has no such job, so kickstart could not start it.
    ['not loaded', 113, (plist: string) => [['launchctl', 'bootstrap', 'system', plist]]],
  ])(
    'macOS: re-installing an unchanged LaunchDaemon that is %s asks sudo only to start it',
    async (state, code, expected) => {
      const root = await mkdtemp(join(tmpdir(), 'pk-daemons-'));
      try {
        const commands: string[][] = [];
        const sudo = async (file: string, args: string[]) => {
          commands.push([file, ...args]);
          if (file === 'install') await copyFile(args[args.length - 2], args[args.length - 1]);
          return { code: 0, output: '' };
        };
        const print = async () => ({ code, output: `system/${spec.name} = {\n\tstate = ${state}\n}` });
        const daemon = new LaunchDaemonService(spec, sudo, 'ana', '/Users/ana', root, print);
        await daemon.install();
        commands.length = 0;
        expect(await daemon.install()).toBe(false);
        expect(commands).toEqual(expected(join(root, `${spec.name}.plist`)));
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.each([
    [
      'LaunchDaemon',
      (s: ServiceSpec, launchctl: RunCommand, dir: string) =>
        new LaunchDaemonService(s, launchctl, 'ana', '/Users/ana', dir, launchctl),
    ],
    [
      'LaunchAgent',
      (s: ServiceSpec, launchctl: RunCommand, dir: string) => new LaunchdService(s, launchctl, dir, 501, dir),
    ],
  ])('macOS: a %s that changes is loaded again only once launchd has let go of the old job', async (_, manager) => {
    const dir = await mkdtemp(join(tmpdir(), 'pk-launchd-'));
    try {
      // launchd answers a bootstrap with error 5 while the job it booted out is still going away.
      let loaded = false;
      let goingAway = 0;
      const launchctl: RunCommand = async (file, args) => {
        if (file === 'install') await copyFile(args[args.length - 2], args[args.length - 1]);
        if (args[0] === 'print')
          return goingAway > 0 ? (goingAway--, { code: 0, output: '' }) : { code: loaded ? 0 : 113, output: '' };
        if (args[0] === 'bootout') [loaded, goingAway] = [false, 2];
        if (args[0] === 'bootstrap' && goingAway > 0) return { code: 5, output: '' };
        if (args[0] === 'bootstrap') loaded = true;
        return { code: 0, output: '' };
      };
      await manager(spec, launchctl, dir).install();
      const server = { ...spec, args: ['/srv/pi-kit-server/backend/service-host.cjs'] };
      expect(await manager(server, launchctl, dir).install()).toBe(true);
      expect(loaded).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('macOS: the LaunchDaemon of the same name refuses a LaunchAgent and is the install the service starts', async () => {
    const home = await mkdtemp(join(tmpdir(), 'pk-home-'));
    const daemons = await mkdtemp(join(tmpdir(), 'pk-daemons-'));
    try {
      const agent = new LaunchdService(spec, async () => ({ code: 0, output: '' }), home, 501, daemons);
      expect(await agent.unsupported()).toBeUndefined();
      const server = '/srv/pi-kit-server/backend/service-host.cjs';
      await writeFile(join(daemons, `${spec.name}.plist`), launchAgentPlist({ ...spec, args: [server] }));
      expect(await agent.unsupported()).toContain('pi-kit service uninstall --level boot');
      // So an older install never takes the boot service from a newer one, and the app updates to the newer one first.
      expect(otherInstall(agent, '/Applications/pi-kit.app/Contents/Resources/backend/service-host.cjs')).toMatchObject(
        {
          entry: server,
        },
      );
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
  it('Windows: a desktop that starts the service starts the server install’s task when that is what is registered', async () => {
    // Its own entry would start its own host, which the server's task host then finds holding the profile.
    let started = 0;
    const desktop = new WindowsRunService(
      'dev.pi-kit.test.unregistered',
      join(tmpdir(), 'no-such-app', 'pi-kit.exe'),
      ['--pi-kit-service'],
      async () => undefined,
    );
    desktop.sibling = {
      registered: () => ['C:\\pi-kit-server\\runtime\\node.exe', 'C:\\pi-kit-server\\backend\\pi-kit.cjs'],
      uninstall: async () => undefined,
      start: async () => void started++,
    };
    await desktop.start();
    expect(started).toBe(1);
  });

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
