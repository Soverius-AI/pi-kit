import { execFile, execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { LaunchdService, type ServiceManager, type ServiceSpec, SystemdService } from './service-registration';

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
    return new WindowsRunService(inputs.name, inputs.program, inputs.supervisorArgs, inputs.stopHost);
  if (platform === 'darwin') return new LaunchdService(serviceSpec(inputs));
  if (platform === 'linux') return new SystemdService(serviceSpec(inputs));
  return undefined;
}

export interface BackgroundServiceStatus {
  supported: boolean;
  /** Why it cannot run here, when it cannot. */
  reason?: string;
  enabled: boolean;
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
