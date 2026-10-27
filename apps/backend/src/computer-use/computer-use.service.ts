import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { ComputerUsePermission, ComputerUseState } from '@pi-kit/protocol';
import { PiSessionService } from '../pi/pi-session.service';
import { ComputerUsePackage, type ComputerUseHostModule } from './computer-use-package';

const run = promisify(execFile);
/** Where Cua Driver ships: macOS and Windows, and Linux in an X11 or Wayland desktop session (`packages/pi-computer-use`). */
const SUPPORTED_PLATFORMS: readonly NodeJS.Platform[] = ['darwin', 'win32', 'linux'];

/**
 * Settings › Computer use: the on/off switch (the same saved choice as `/computer-use on | off`), which app macOS gives the permissions to, and on macOS what it has
 * granted, with the System Settings page of each. The driver's native library is loaded only while computer use is on, as in the extension. A change of the
 * switch reloads the idle sessions, so their computer tools appear or go.
 */
@Injectable()
export class ComputerUseService {
  private readonly logger = new Logger(ComputerUseService.name);
  /** Screen Recording was asked for, or seen to change to granted, since this process started: macOS applies it after a relaunch. */
  private screenChanged = false;
  private screenFirstSeen: boolean | undefined;
  private adHoc: Promise<boolean | undefined> | undefined;
  /** Overridable for the tests. */
  platform: NodeJS.Platform = process.platform;
  openUrl = (url: string): Promise<unknown> => run('open', [url]);
  codesignInfo = async (bundle: string): Promise<string> => (await run('codesign', ['-dv', bundle])).stderr;

  constructor(
    private readonly pkg: ComputerUsePackage,
    private readonly sessions: PiSessionService,
  ) {}

  async state(): Promise<ComputerUseState> {
    const mod = await this.pkg.hostModule();
    const supported = SUPPORTED_PLATFORMS.includes(this.platform);
    const enabled = mod?.isEnabled() ?? false;
    const host = mod?.host() ?? { name: 'pi-kit', kind: 'app' as const };
    const adHoc = host.bundle && this.platform === 'darwin' && host.kind === 'app' ? await this.isAdHoc(host.bundle) : undefined;
    let permissions: ComputerUseState['permissions'] = null;
    if (mod && enabled && this.platform === 'darwin') {
      try {
        permissions = await mod.permissions();
        this.screenFirstSeen ??= permissions.screenRecording;
        if (permissions.screenRecording && this.screenFirstSeen === false) this.screenChanged = true;
      } catch (error) {
        this.logger.warn(`Could not read the macOS permissions: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return {
      installed: Boolean(mod),
      supported,
      platform: this.platform,
      enabled,
      host: { name: host.name, kind: host.kind, ...(adHoc === undefined ? {} : { adHoc }) },
      permissions,
      needsRelaunch: this.platform === 'darwin' && enabled && this.screenChanged,
    };
  }

  async setEnabled(enabled: boolean): Promise<ComputerUseState> {
    const mod = await this.required();
    if (enabled && !SUPPORTED_PLATFORMS.includes(this.platform)) throw new NotFoundException(`Computer use supports macOS, Windows and Linux; this is ${this.platform}.`);
    mod.setEnabled(enabled);
    const reloaded = await this.sessions.reloadIdleSessions();
    this.logger.log(`Computer use is ${enabled ? 'on' : 'off'}; reloaded ${reloaded} idle session(s).`);
    return this.state();
  }

  /** Asks macOS (its prompt, and the app added to the list switched off) and opens the permission's page in System Settings. */
  async open(permission: ComputerUsePermission): Promise<ComputerUseState> {
    const mod = await this.required();
    if (this.platform !== 'darwin') return this.state();
    try {
      await mod.requestPermissions();
    } catch (error) {
      this.logger.warn(`Could not ask macOS for the permissions: ${error instanceof Error ? error.message : String(error)}`);
    }
    const pane = mod.PERMISSIONS.find((p) => p.key === permission)?.pane;
    if (pane) await this.openUrl(pane);
    if (permission === 'screenRecording') this.screenChanged = true;
    return this.state();
  }

  private async required(): Promise<ComputerUseHostModule> {
    const mod = await this.pkg.hostModule();
    if (!mod) throw new NotFoundException('The computer-use package is not installed in pi.');
    return mod;
  }

  /** macOS ties a permission to the app's signature; an ad-hoc signature changes with every build. Asked once, `undefined` when codesign cannot say. */
  private isAdHoc(bundle: string): Promise<boolean | undefined> {
    this.adHoc ??= this.codesignInfo(bundle).then(
      (info) => /Signature=adhoc/.test(info),
      () => undefined,
    );
    return this.adHoc;
  }
}
