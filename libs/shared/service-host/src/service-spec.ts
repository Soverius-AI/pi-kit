import { execFile, execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir, tmpdir, userInfo } from 'node:os';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { bundledVersion } from './service-host';
import {
  LaunchDaemonService,
  LaunchdService,
  type RunCommand,
  runInTerminal,
  type ServiceManager,
  type ServiceSpec,
  SystemdService,
} from './service-registration';

/** The flag that starts the app as a windowless supervisor of the service host (the Windows sign-in entry). */
export const SUPERVISOR_FLAG = '--pi-kit-service';

const INSTALLED_NAME = 'dev.pi-kit.app.service';

/** The installed app's profile registers under one name; a development or scratch profile under a name of its own. */
export function serviceName(dataDir: string, installedProfile: boolean): string {
  if (installedProfile) return INSTALLED_NAME;
  return `${INSTALLED_NAME}.${createHash('sha256').update(dataDir).digest('hex').slice(0, 8)}`;
}

/** The installed app's folders, as Electron names them for `pi-kit` (its `userData` and `logs`). */
export function appFolders(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): { dataDir: string; logDir: string } {
  if (platform === 'darwin') {
    return {
      dataDir: join(home, 'Library', 'Application Support', 'pi-kit'),
      logDir: join(home, 'Library', 'Logs', 'pi-kit'),
    };
  }
  const base =
    platform === 'win32'
      ? env['APPDATA'] || join(home, 'AppData', 'Roaming')
      : env['XDG_CONFIG_HOME'] || join(home, '.config');
  const dataDir = join(base, 'pi-kit');
  return { dataDir, logDir: join(dataDir, 'logs') };
}

export interface SpecInputs {
  name: string;
  /** The app's binary: Electron, run as Node. */
  program: string;
  /** `service-host.cjs`. */
  hostEntry: string;
  dataDir: string;
  logDir: string;
  path?: string;
  /** `$APPIMAGE` when the app runs from an AppImage. */
  appImage?: string;
  /** Paths a development build must name; a packaged host finds them beside itself. */
  devEnv?: Record<string, string>;
}

/**
 * The registration the desktop and the `pi-kit` command both write, from the same inputs to the same bytes, so neither
 * rewrites (and so restarts) the other's. A packaged host needs only its data folder, logs and PATH; it derives the rest.
 */
export function serviceSpec(inputs: SpecInputs): ServiceSpec {
  const env: Record<string, string> = {
    ELECTRON_RUN_AS_NODE: '1',
    PI_KIT_SERVICE_LEVEL: 'login',
    PI_KIT_DATA_DIR: inputs.dataDir,
    PI_KIT_LOG_DIR: inputs.logDir,
    ...(inputs.path ? { PATH: inputs.path } : {}),
    ...inputs.devEnv,
  };
  const base = { name: inputs.name, description: 'pi-kit background service', env, logDir: inputs.logDir };
  // An AppImage's files live in a mount that moves at every start: run the image and find the host beside its binary.
  return inputs.appImage
    ? { ...base, program: inputs.appImage, args: ['-e', besideBinary('service-host.cjs')] }
    : { ...base, program: inputs.program, args: [inputs.hostEntry] };
}

/** `-e` code that loads a bundle from the app's `resources/backend`, wherever the binary is mounted. */
function besideBinary(file: string): string {
  return `require(require('path').join(process.execPath, '..', 'resources', 'backend', ${JSON.stringify(file)}))`;
}

const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';

/** Windows: a value in the user's Run key that starts the app as the supervisor; no admin, no stored password. */
export class WindowsRunService implements ServiceManager {
  constructor(
    private readonly name: string,
    private readonly program: string,
    private readonly args: string[],
    private readonly stopHost: () => Promise<void>,
  ) {}

  private get command(): string {
    return [this.program, ...this.args].map((part) => `"${part}"`).join(' ');
  }

  async unsupported(): Promise<string | undefined> {
    return undefined;
  }

  installed(): boolean {
    try {
      return execFileSync('reg', ['query', RUN_KEY, '/v', this.name], { encoding: 'utf8' }).includes(this.command);
    } catch {
      return false;
    }
  }

  registered(): string[] | undefined {
    try {
      const line = execFileSync('reg', ['query', RUN_KEY, '/v', this.name], { encoding: 'utf8' });
      return [...line.matchAll(/"([^"]*)"/g)].map((match) => match[1]);
    } catch {
      return undefined;
    }
  }

  async install(): Promise<boolean> {
    const changed = !this.installed();
    if (changed) await this.reg(['add', RUN_KEY, '/v', this.name, '/t', 'REG_SZ', '/d', this.command, '/f']);
    await this.start();
    return changed;
  }

  async uninstall(): Promise<void> {
    await this.reg(['delete', RUN_KEY, '/v', this.name, '/f']).catch(() => undefined);
  }

  async start(): Promise<void> {
    spawn(this.program, this.args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  }

  async restart(): Promise<void> {
    await this.stopHost();
    await this.start();
  }

  private reg(args: string[]): Promise<void> {
    return new Promise((resolve, reject) =>
      execFile('reg', args, (error, _stdout, stderr) =>
        error ? reject(new Error(`reg ${args[0]} failed: ${stderr.trim() || error.message}`)) : resolve(),
      ),
    );
  }
}

export interface ManagerInputs extends SpecInputs {
  /** The supervisor's arguments on Windows: the flag, after the app's folder for a development build. */
  supervisorArgs: string[];
  stopHost: () => Promise<void>;
  /** A server install runs on its own Node, which has no windowless supervisor: Windows gets a scheduled task instead. */
  server?: boolean;
  /** `boot`: start with nobody signed in. Only macOS has a separate registration for it (a LaunchDaemon). */
  level?: 'login' | 'boot';
}

/**
 * The batch file a scheduled task runs: a task's action has no environment of its own, so the file sets the service's. `%` is
 * doubled so cmd expands nothing.
 */
export function serviceBatch(spec: ServiceSpec): string {
  const lines = Object.entries(spec.env).map(([key, value]) => `set "${key}=${value.replace(/%/g, '%%')}"`);
  return ['@echo off', ...lines, [spec.program, ...spec.args].map((part) => `"${part}"`).join(' '), ''].join('\r\n');
}

/** A task that runs `batch` at boot as `user`, whether signed in or not, and again after a failure; no window ever shows. */
export function scheduledTaskXml(batch: string, user: string, description: string): string {
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>${xmlText(description)}</Description></RegistrationInfo>
  <Triggers><BootTrigger><Enabled>true</Enabled></BootTrigger></Triggers>
  <Principals>
    <Principal id="Owner"><UserId>${xmlText(user)}</UserId><LogonType>Password</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure>
  </Settings>
  <Actions Context="Owner"><Exec><Command>cmd.exe</Command><Arguments>/d /c "${xmlText(batch)}"</Arguments></Exec></Actions>
</Task>
`;
}

const xmlText = (value: string): string => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Windows, for a server install: a Task Scheduler task that starts at boot and runs whether the owner is signed in or not, so
 * its `node.exe` never opens a window. Task Scheduler stores the account's password, so Credential Manager works; `schtasks`
 * asks for it in the terminal.
 */
export class WindowsTaskService implements ServiceManager {
  private readonly batch: string;

  constructor(
    private readonly spec: ServiceSpec,
    private readonly stopHost: () => Promise<void>,
    private readonly terminal: RunCommand = runInTerminal,
    private readonly user = `${process.env['USERDOMAIN'] ?? '.'}\\${userInfo().username}`,
  ) {
    this.batch = join(spec.env['PI_KIT_DATA_DIR'] ?? spec.logDir, 'service.cmd');
  }

  async unsupported(): Promise<string | undefined> {
    return undefined;
  }

  installed(): boolean {
    try {
      execFileSync('schtasks', ['/Query', '/TN', this.spec.name], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  registered(): string[] | undefined {
    if (!existsSync(this.batch)) return undefined;
    const run = readFileSync(this.batch, 'utf8').trim().split(/\r?\n/).pop() ?? '';
    return [...run.matchAll(/"([^"]*)"/g)].map((match) => match[1]);
  }

  async install(): Promise<boolean> {
    const content = serviceBatch(this.spec);
    const same = existsSync(this.batch) && readFileSync(this.batch, 'utf8') === content;
    if (same && this.installed()) {
      await this.start();
      return false;
    }
    mkdirSync(dirname(this.batch), { recursive: true });
    writeFileSync(this.batch, content, { mode: 0o600 });
    const staging = mkdtempSync(join(tmpdir(), 'pi-kit-task-'));
    try {
      const xml = join(staging, 'task.xml');
      writeFileSync(
        xml,
        Buffer.from(`\ufeff${scheduledTaskXml(this.batch, this.user, this.spec.description)}`, 'utf16le'),
      );
      await this.must(['/Create', '/TN', this.spec.name, '/XML', xml, '/RU', this.user, '/RP', '*', '/F']);
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
    await this.start();
    return true;
  }

  async uninstall(): Promise<void> {
    await this.stopHost();
    await this.terminal('schtasks', ['/Delete', '/TN', this.spec.name, '/F']);
    rmSync(this.batch, { force: true });
  }

  async start(): Promise<void> {
    await this.must(['/Run', '/TN', this.spec.name]);
  }

  async restart(): Promise<void> {
    await this.stopHost();
    await this.start();
  }

  private async must(args: string[]): Promise<void> {
    const result = await this.terminal('schtasks', args);
    if (result.code !== 0) throw new Error(`schtasks ${args[0]} failed (${result.code})`);
  }
}

/** This platform's service manager, or undefined where pi-kit has none. */
/** Why an app at this location must not register: the path it would register goes away. */
export function temporaryLocation(
  platform: NodeJS.Platform,
  program: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (env['PORTABLE_EXECUTABLE_FILE'])
    return 'The portable pi-kit runs from a temporary folder. Install pi-kit to keep it running in the background.';
  if (platform === 'darwin' && (program.includes('/AppTranslocation/') || program.startsWith('/Volumes/')))
    return 'pi-kit runs from a temporary location. Move it to Applications and open it from there.';
  return undefined;
}

class UnavailableService implements ServiceManager {
  constructor(private readonly reason: string) {}

  async unsupported(): Promise<string> {
    return this.reason;
  }

  installed(): boolean {
    return false;
  }

  registered(): undefined {
    return undefined;
  }

  async install(): Promise<boolean> {
    throw new Error(this.reason);
  }

  async uninstall(): Promise<void> {
    throw new Error(this.reason);
  }

  async start(): Promise<void> {
    throw new Error(this.reason);
  }

  async restart(): Promise<void> {
    throw new Error(this.reason);
  }
}

export function serviceManager(
  inputs: ManagerInputs,
  platform: NodeJS.Platform = process.platform,
): ServiceManager | undefined {
  const temporary = temporaryLocation(platform, inputs.program);
  if (temporary) return new UnavailableService(temporary);
  if (platform === 'win32')
    return inputs.server
      ? new WindowsTaskService(serviceSpec(inputs), inputs.stopHost)
      : new WindowsRunService(inputs.name, inputs.program, inputs.supervisorArgs, inputs.stopHost);
  if (platform === 'darwin')
    return inputs.level === 'boot'
      ? new LaunchDaemonService(serviceSpec(inputs))
      : new LaunchdService(serviceSpec(inputs));
  if (platform === 'linux') return new SystemdService(serviceSpec(inputs));
  return undefined;
}

export interface BackgroundServiceStatus {
  supported: boolean;
  /** Why it cannot run here, when it cannot. */
  reason?: string;
  enabled: boolean;
}

/**
 * The other install a registration starts: its service host and version, or undefined when the registration starts `entry`
 * itself or no service host at all. An install that is gone has the version `unknown`, so it never counts as newer.
 */
export function otherInstall(manager: ServiceManager, entry: string): { entry: string; version: string } | undefined {
  const host = manager.registered()?.find((part) => basename(part) === 'service-host.cjs');
  if (!host || resolve(host) === resolve(entry)) return undefined;
  return { entry: host, version: existsSync(host) ? bundledVersion(dirname(host)) : 'unknown' };
}

export async function backgroundStatus(service: ServiceManager | undefined): Promise<BackgroundServiceStatus> {
  if (!service) return { supported: false, reason: 'This system has no supported service manager.', enabled: false };
  const reason = await service.unsupported();
  return reason ? { supported: false, reason, enabled: false } : { supported: true, enabled: service.installed() };
}

/** The `pi-kit` launcher a terminal finds on PATH: the app's binary run as Node on the CLI bundle. */
export function cliLauncher(
  platform: NodeJS.Platform,
  target: { runtime: string; script: string; appImage?: string },
): string {
  if (platform === 'win32') {
    const quote = (text: string) => `"${text.replace(/"/g, '""')}"`;
    return `@echo off\r\nrem Written by pi-kit (Settings > General > Background).\r\nset ELECTRON_RUN_AS_NODE=1\r\n${quote(target.runtime)} ${quote(target.script)} %*\r\n`;
  }
  const quote = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`;
  const run = target.appImage
    ? `${quote(target.appImage)} -e ${quote(besideBinary('pi-kit.cjs'))} --`
    : `${quote(target.runtime)} ${quote(target.script)}`;
  return `#!/bin/sh\n# Written by pi-kit (Settings > General > Background).\nELECTRON_RUN_AS_NODE=1 exec ${run} "$@"\n`;
}

export const cliLauncherName = (platform: NodeJS.Platform): string => (platform === 'win32' ? 'pi-kit.cmd' : 'pi-kit');

/** A folder most shells have on PATH already, or that the user is told to add (the one `pi-kit-secret` uses). */
export function cliInstallDir(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home = homedir()): string {
  if (platform === 'win32') return join(env['LOCALAPPDATA'] ?? join(home, 'AppData', 'Local'), 'pi-kit', 'bin');
  return join(home, '.local', 'bin');
}
