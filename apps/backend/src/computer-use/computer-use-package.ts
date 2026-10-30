import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { ComputerUseState } from '@pi-kit/protocol';
import { MetaRepository } from '../db/meta.repository';
import { PiKitPackage } from '../plugins/pi-kit-package';

export const COMPUTER_USE_PACKAGE = '@pi-kit/computer-use';

type Permissions = NonNullable<ComputerUseState['permissions']>;

/** What `packages/pi-computer-use/lib/host.mjs` offers pi-kit's backend (the extension uses the same files). */
export interface ComputerUseHostModule {
  isEnabled(): boolean;
  setEnabled(enabled: boolean): void;
  host(): { name: string; kind: 'app' | 'development' | 'terminal'; bundle?: string };
  PERMISSIONS: readonly { key: keyof Permissions; name: string; pane: string }[];
  /** Loads the driver's SDK (and its native library) on macOS. */
  permissions(): Promise<Permissions>;
  requestPermissions(): Promise<Permissions>;
  /** Linux: a Wayland session, Hyprland, and whether Cua's Hyprland plugin answers (`hyprctl -j cua:status`); `undefined` elsewhere. */
  linuxReadiness(): Promise<ComputerUseState['linux']>;
}

/**
 * The `@pi-kit/computer-use` package as pi-kit sees it: a pi package that ships with the app and is installed into pi's settings once, like `@pi-kit/learn` and `@pi-kit/meat-proxy`
 * (`PI_KIT_COMPUTER_USE_PACKAGE=off` skips the install; `PI_KIT_COMPUTER_USE_PACKAGE_DIR` names the copy to install). It has no plugin events: the tools are its extension's, off until
 * the person turns computer use on, and the backend loads only `lib/host.mjs` for Settings › Computer use (the saved choice and the macOS permissions).
 */
@Injectable()
export class ComputerUsePackage extends PiKitPackage<ComputerUseHostModule> implements OnModuleInit {
  private readonly log = new Logger('ComputerUse');

  constructor(meta: MetaRepository) {
    super(meta, { name: COMPUTER_USE_PACKAGE, folder: 'pi-computer-use', entry: 'lib/host.mjs', setting: 'computerUse', env: 'PI_KIT_COMPUTER_USE_PACKAGE', label: 'computer-use' });
  }

  onModuleInit(): void {
    void this.ensureInstalled().catch((error: unknown) => this.log.warn(`Could not install the computer-use package: ${error instanceof Error ? error.message : String(error)}`));
  }

  /** The host module of the installed package, or `undefined` when pi has none (removed, or never installed). */
  hostModule(): Promise<ComputerUseHostModule | undefined> {
    return this.load();
  }
}
