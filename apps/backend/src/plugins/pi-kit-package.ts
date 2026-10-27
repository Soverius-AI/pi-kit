import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Logger } from '@nestjs/common';
import { MetaRepository } from '../db/meta.repository';
import { loadPi } from '../pi/load-pi';

/** What identifies one of the pi packages that ship with the app: `@pi-kit/learn`, `@pi-kit/meat-proxy`, `@pi-kit/computer-use`. */
export interface PackageSpec {
  /** The package's name in its `package.json`. */
  name: string;
  /** The folder under `packages/` (in the repository, and next to the backend bundle in the app). */
  folder: string;
  /** The module the backend loads from the installed package: a path inside it. */
  entry: string;
  /** The key in the settings table that remembers pi-kit offered the package once. */
  setting: string;
  /** `<env>=off` skips the install; `<env>_DIR` names the copy to install (tests, a development checkout). */
  env: string;
  /** For the log. */
  label: string;
}

export type InstallResult = 'installed' | 'repointed' | 'present' | 'removed-by-user' | 'unavailable' | 'off';

const nativeImport = new Function('specifier', 'return import(specifier)') as <T>(specifier: string) => Promise<T>;

const nameOf = (dir: string): string | undefined => {
  try {
    return (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: string }).name;
  } catch {
    return undefined;
  }
};

/** One write of pi's settings at a time: two packages installed in parallel would each read the file before the other wrote it. */
let installing: Promise<unknown> = Promise.resolve();

/**
 * A pi package that ships with the app (`@pi-kit/learn`, `@pi-kit/meat-proxy`, `@pi-kit/computer-use`): where the copy that ships is, whether the user's pi has it
 * installed, and a module of it the backend uses. pi-kit installs the package into pi's settings (`pi install <path>`, in effect) the first time it starts and never again: a user
 * who ran `pi remove` keeps it removed, and a removed package means pi-kit does what it does through that package no more. A package whose folder moved with the app is pointed at
 * the new copy.
 */
export abstract class PiKitPackage<Module> {
  protected readonly logger: Logger;
  private moduleDir: string | undefined;
  private loaded: Promise<Module> | undefined;
  /** How the package's module is imported: a native `import()` (the bundle compiles a plain one to `require`). A test replaces it. */
  importer: <T>(url: string) => Promise<T> = nativeImport;

  constructor(
    protected readonly meta: MetaRepository,
    protected readonly spec: PackageSpec,
  ) {
    this.logger = new Logger(`${spec.label}Package`);
  }

  /** The copy shipped with pi-kit: next to the backend bundle (`packages/<folder>`), or the repository's own folder when it runs from source. */
  bundledDir(): string | undefined {
    const candidates = [process.env[`${this.spec.env}_DIR`], join(__dirname, 'packages', this.spec.folder), resolve(__dirname, '..', '..', '..', '..', 'packages', this.spec.folder)];
    return candidates.find((dir): dir is string => !!dir && nameOf(dir) === this.spec.name);
  }

  /** The folder of the package pi has configured (user scope), if it has one that is there. */
  async installedDir(): Promise<string | undefined> {
    const { packages } = await this.context();
    for (const configured of packages.listConfiguredPackages()) {
      if (configured.scope !== 'user' || !configured.installedPath) continue;
      if (nameOf(configured.installedPath) === this.spec.name && existsSync(join(configured.installedPath, this.spec.entry))) return configured.installedPath;
    }
    return undefined;
  }

  /** Installs the bundled package into the user's pi settings once. `<env>=off` skips it (a machine that wants no plugin). Returns what happened, for the log and the tests. */
  ensureInstalled(): Promise<InstallResult> {
    const run = installing.then(() => this.install());
    installing = run.catch(() => undefined);
    return run;
  }

  private async install(): Promise<InstallResult> {
    if (process.env[this.spec.env] === 'off') return 'off';
    const bundled = this.bundledDir();
    if (!bundled) return 'unavailable';
    const { settings, packages } = await this.context();
    const configured = packages.listConfiguredPackages().filter((p) => p.scope === 'user');
    const ours = configured.find((p) => p.installedPath && nameOf(p.installedPath) === this.spec.name);
    const stale = configured.find((p) => this.isSource(p.source) && (!p.installedPath || !existsSync(p.installedPath)));
    if (ours?.installedPath) {
      this.remember();
      return 'present';
    }
    const offered = (this.meta.getSetting(this.spec.setting) as { offered?: boolean } | undefined)?.offered === true;
    if (stale) {
      // The app moved or was updated: the entry points at a folder that is gone. Point it at the copy that ships now.
      packages.removeSourceFromSettings(stale.source);
      packages.addSourceToSettings(bundled);
      await settings.flush();
      this.remember();
      this.logger.log(`Pointed pi at the ${this.spec.label} package in ${bundled} (was ${stale.source}).`);
      return 'repointed';
    }
    if (offered) return 'removed-by-user';
    packages.addSourceToSettings(bundled);
    await settings.flush();
    const failures = settings.drainErrors();
    if (failures.length > 0) throw new Error(`pi could not save its settings: ${failures[0].error.message}`);
    this.remember();
    this.logger.log(`Installed the ${this.spec.label} package (${bundled}) into pi's settings.`);
    return 'installed';
  }

  /** The package's module, or `undefined` when pi has none (removed, or never installed). */
  protected async load(): Promise<Module | undefined> {
    const dir = await this.installedDir();
    if (!dir) return undefined;
    if (this.moduleDir !== dir) {
      this.moduleDir = dir;
      this.loaded = this.importer<Module>(`${pathToFileURL(join(dir, this.spec.entry)).href}?v=${Date.now()}`);
    }
    return this.loaded;
  }

  private remember(): void {
    this.meta.setSetting(this.spec.setting, { offered: true });
  }

  private isSource(source: string): boolean {
    return new RegExp(`${this.spec.folder}/?$`).test(source) || source === this.spec.name;
  }

  protected async context() {
    const pi = await loadPi();
    const agentDir = pi.getAgentDir();
    const cwd = process.cwd();
    const settings = pi.SettingsManager.create(cwd, agentDir, { projectTrusted: false });
    const packages = new pi.DefaultPackageManager({ cwd, agentDir, settingsManager: settings, builtinExtensions: [] });
    return { pi, settings, packages };
  }
}
