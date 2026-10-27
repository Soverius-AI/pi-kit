import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { type DatabaseProtection, type DiskEncryption, type ResolverPlatform, type SecretsStatus, bearerFromResolver, isProviderAccount, resolverCommand } from '@pi-kit/protocol';
import { type SecretStore, defaultInstallDir, launcherName, launcherScript, readSecurityPreferences, writeSecurityPreferences, selectSecretStore } from '@pi-kit/secret-store';
import type { BackendConfig } from '../app/config';
import { CONFIG } from '../app/config.token';
import { DatabaseService } from '../db/database.service';
import { MetaRepository } from '../db/meta.repository';
import { agentDirOf } from '../pi/pi-resolution';
import { readMovableKeys } from '../setup/detect';
import { detectDiskEncryption } from './disk-encryption';
import { SECRET_STORE } from './tokens';
import { plaintextCredentialFile } from './plaintext-credentials';
import type { MoveKeysResult } from '@pi-kit/protocol';

/** Where a key went: the credential store (`auth.json` then holds a resolver) or, when there is none, pi's own file. */
export interface KeptKey {
  value: string;
  storage: 'keychain' | 'auth.json';
}

/**
 * Secrets at rest: API keys go to the operating system's credential store and `auth.json` gets the command that prints them (`resolverCommand`), so the pi
 * command line keeps working without pi-kit running; the database key (`pi-kit/db`) lives there too. This service owns the choices (which resolver, whether there is a store, what to do
 * when it refuses), the `pi-kit-secret` launcher (written to `<data dir>/bin` and put on this process's PATH, because pi runs the resolver in this process for pi-kit's own sessions) and the facts Settings
 * shows. A key is handled as a parameter of `keep()` and never logged, returned or kept.
 */
@Injectable()
export class SecretsService implements OnModuleInit {
  private readonly logger = new Logger(SecretsService.name);
  /** PATH as the user's shell gave it, before `<data dir>/bin` was put in front. */
  private readonly userPath = process.env['PATH'] ?? '';
  private retainedHelperReferences = false;

  constructor(
    @Inject(SECRET_STORE) public store: SecretStore,
    @Inject(CONFIG) private readonly config: Pick<BackendConfig, 'dataDir'>,
    private readonly database: DatabaseService,
    private readonly meta: MetaRepository,
  ) {}

  async onModuleInit(): Promise<void> {
    // Permission to resolve an existing reference is independent of saving new credentials.
    // Reading configuration here never executes a resolver or accesses Keychain.
    this.retainedHelperReferences = this.hasCredentialReference(/!pi-kit-secret get [A-Za-z0-9._-]+/);
    if (!this.credentialsEnabled() && !this.retainedHelperReferences) return;
    try {
      const launcher = this.ensureLauncher();
      if (this.store.helperResolver && !launcher) throw new Error('The signed pi-kit-secret helper is required for Touch ID storage.');
      // Existing keys move only through the explicit migration action, never on startup.
    } catch (error) {
      if (this.store.protected) throw new Error('The secure credential helper could not be prepared. Original credentials were retained.', { cause: error });
      this.logger.warn(`Could not write the pi-kit-secret launcher: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  platform(): ResolverPlatform {
    return process.platform === 'darwin' || process.platform === 'win32' ? process.platform : 'linux';
  }

  // ---- the launcher

  /** The built `pi-kit-secret.cjs`: next to the backend bundle when packaged, in `dist/apps/secret-cli` in a checkout, or where `PI_KIT_SECRET_CLI` says. */
  cliBundle(): string | undefined {
    const candidates = [process.env['PI_KIT_SECRET_CLI'], join(__dirname, 'pi-kit-secret.cjs'), join(__dirname, '..', 'secret-cli', 'pi-kit-secret.cjs')].filter((c): c is string => !!c);
    return candidates.find((c) => existsSync(c));
  }

  private launcherText(): string | undefined {
    const script = this.cliBundle();
    if (!script) return undefined;
    const electron = !!process.versions['electron'] || process.env['ELECTRON_RUN_AS_NODE'] === '1';
    const secretStore = this.store.kind === 'keychain' && this.platform() === 'darwin'
      ? this.store.protected ? 'macos' : 'legacy'
      : process.env['PI_KIT_SECRET_STORE'] || (this.platform() === 'darwin' && this.retainedHelperReferences ? 'macos' : undefined);
    return launcherScript(this.platform(), { runtime: process.execPath, electron, script, ...(secretStore ? { secretStore } : {}) });
  }

  binDir(): string {
    return join(this.config.dataDir, 'bin');
  }

  /** Writes `<data dir>/bin/pi-kit-secret` (when the CLI bundle exists) and puts the folder at the front of this process's PATH, so `!pi-kit-secret get <provider>` resolves for pi in here. */
  ensureLauncher(): string | undefined {
    const text = this.launcherText();
    if (!text) return undefined;
    const dir = this.binDir();
    const file = join(dir, launcherName(this.platform()));
    mkdirSync(dir, { recursive: true });
    if (!existsSync(file) || readFileSync(file, 'utf8') !== text) {
      const temp = `${file}.${process.pid}.tmp`;
      writeFileSync(temp, text, { mode: 0o755 });
      chmodSync(temp, 0o755);
      renameSync(temp, file);
    }
    const path = process.env['PATH'] ?? '';
    if (!path.split(delimiter).includes(dir)) process.env['PATH'] = `${dir}${delimiter}${path}`;
    return file;
  }

  /** "Install on PATH": the same launcher in `~/.local/bin` (or the local app data folder on Windows), for the pi command line in a terminal. Only on the person's click. */
  installCli(): { path: string; dir: string; onPath: boolean } {
    const text = this.launcherText();
    if (!text) throw new Error('The pi-kit-secret command is not part of this build.');
    const dir = process.env['PI_KIT_BIN_DIR'] || defaultInstallDir(this.platform(), process.env, homedir());
    const file = join(dir, launcherName(this.platform()));
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, text, { mode: 0o755 });
    chmodSync(file, 0o755);
    return { path: file, dir, onPath: this.userPath.split(delimiter).includes(dir) };
  }

  private cliOnUserPath(): boolean {
    const name = launcherName(this.platform());
    return this.userPath.split(delimiter).some((dir) => dir && dir !== this.binDir() && existsSync(join(dir, name)));
  }

  private secretToolInstalled(): boolean {
    return this.platform() === 'linux' && this.userPath.split(delimiter).some((dir) => dir && existsSync(join(dir, 'secret-tool')));
  }

  // ---- keys

  /**
   * The resolver `auth.json` gets for a provider, or undefined when there is no store to keep the key in. A scratch store (tests: `file`, `memory`) is read by the helper only,
   * whatever the platform, because `security` cannot see it. The helper is also the answer where the platform has none of its own and the CLI bundle does not exist.
   */
  resolver(provider: string): string | undefined {
    if (!this.credentialsEnabled() || !this.store.available() || !isProviderAccount(provider)) return undefined;
    if (this.store.helperResolver) return this.cliBundle() ? resolverCommand('win32', provider) : undefined;
    if (this.store.kind === 'keychain') {
      const platform = this.platform();
      if (platform !== 'darwin' && !this.cliBundle() && !(platform === 'linux' && this.secretToolInstalled())) return undefined;
      return resolverCommand(platform, provider, { secretTool: this.secretToolInstalled() });
    }
    return this.cliBundle() ? resolverCommand('win32', provider) : undefined;
  }

  /** Stores the key and returns what pi's login should write instead of it. When there is no store, or it refuses, the key itself goes to `auth.json` (pi's own 0600 file), and the caller says so. */
  async keep(provider: string, key: string): Promise<KeptKey> {
    if (!this.credentialsEnabled()) return { value: key, storage: 'auth.json' };
    let resolver = this.resolver(provider);
    if (!resolver) {
      if (this.store.protected) throw new Error('Touch ID storage requires the signed pi-kit-secret helper.');
      return { value: key, storage: 'auth.json' };
    }
    try {
      await this.store.set(provider, key);
      if (await this.store.get(provider) !== key) throw new Error('The store did not return what was written.');
      // `secret-tool` only sees the Secret Service; if it cannot read the entry back, the helper is the resolver.
      if (resolver.startsWith('!secret-tool') && !this.resolves(resolver, key)) resolver = resolverCommand('linux', provider);
      return { value: resolver, storage: 'keychain' };
    } catch (error) {
      if (this.store.protected) throw error;
      this.logger.warn(`The credential store did not take the key for ${provider}: ${error instanceof Error ? error.message : String(error)}`);
      return { value: key, storage: 'auth.json' };
    }
  }

  /**
   * A connector's bearer token: kept like an API key, and what `mcp.json` gets is the `Authorization` value that prints it (`!echo Bearer $(security ...)`, or the helper's
   * `--bearer`), never the token. With no store, or when it refuses, the value is `Bearer <token>` itself and the caller says so (and keeps it out of any project file).
   */
  async keepBearer(account: string, token: string): Promise<{ value: string; storage: 'keychain' | 'mcp.json' }> {
    const kept = await this.keep(account, token);
    if (kept.storage !== 'keychain') return { value: `Bearer ${token}`, storage: 'mcp.json' };
    return { value: bearerFromResolver(kept.value), storage: 'keychain' };
  }

  /** Runs a resolver the way pi does (a shell, ten seconds) and compares its output with the key. */
  private resolves(command: string, key: string): boolean {
    try {
      const out = execFileSync('/bin/sh', ['-c', command.slice(1)], { timeout: 10_000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: process.env });
      return out.trim() === key;
    } catch {
      return false;
    }
  }

  /** Signing out of a provider whose key was in the store removes the entry. */
  async forget(provider: string): Promise<void> {
    // Direct-storage mode must not authenticate just to disconnect or remove a provider.
    if (!this.credentialsEnabled()) return;
    try {
      await this.store.delete(provider);
    } catch (error) {
      if (this.store.protected) throw error;
      this.logger.warn(`Could not remove the stored key for ${provider}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  credentialsEnabled(): boolean {
    const configured = readSecurityPreferences(this.config.dataDir)?.credentialStoreEnabled;
    if (configured !== undefined) return configured;
    const previous = this.meta.getSetting('credentialStoreEnabled');
    if (typeof previous === 'boolean') return previous;
    // Scratch stores remain explicit opt-ins; a new macOS profile starts with no store.
    return this.store.kind !== 'none' && (process.platform !== 'darwin' || this.store.kind !== 'keychain' || !!process.env['PI_KIT_SECRET_STORE']);
  }

  private enabledStore(): SecretStore {
    const store = this.store.kind !== 'none' ? this.store : selectSecretStore({
      ...process.env,
      ...(!process.env['PI_KIT_SECRET_STORE'] && process.platform === 'darwin' ? { PI_KIT_SECRET_STORE: 'macos' } : {}),
    });
    if (!store.available()) throw new Error('Secure storage is unavailable in this build.');
    return store;
  }

  private hasCredentialReference(pattern: RegExp): boolean {
    const agent = agentDirOf(process.env);
    const files = ['auth.json', 'models.json', 'mcp.json'].map((name) => join(agent, name));
    for (const workspace of this.meta.listWorkspaces?.() ?? []) files.push(join(workspace.cwd, '.pi', 'mcp.json'));
    return files.some((path) => {
      try { return pattern.test(readFileSync(path, 'utf8')); } catch { return false; }
    });
  }

  /** Explicit opt-out affects credential writes, never the database key or database encryption. */
  async setCredentialStorage(enabled: boolean): Promise<MoveKeysResult> {
    const result: MoveKeysResult = { moved: [], failed: [] };
    if (enabled) {
      const previous = this.store;
      this.store = this.enabledStore();
      try {
        if (this.store.helperResolver && !this.cliBundle()) throw new Error('Secure storage requires the signed pi-kit-secret helper.');
        this.ensureLauncher();
        writeSecurityPreferences(this.config.dataDir, { credentialStoreEnabled: true });
      } catch (error) {
        this.store = previous;
        throw error;
      }
      this.meta.setSetting('credentialStoreEnabled', true);
      return result;
    }
    // Persist first, so a failed export or restart never silently resumes storing new keys.
    writeSecurityPreferences(this.config.dataDir, { credentialStoreEnabled: false });
    this.meta.setSetting('credentialStoreEnabled', false);
    const agent = agentDirOf(process.env);
    // This is an explicit export action, so existing references may authorize access to their old store.
    // Respect explicit test/automation overrides; default startup still never selects it for new saves.
    const exportStore = this.store.kind === 'none' && this.platform() === 'darwin' && !process.env['PI_KIT_SECRET_STORE']
      && this.hasCredentialReference(/!(?:pi-kit-secret get |security find-generic-password -s pi-kit -a |echo Bearer \$\()/)
      ? selectSecretStore({ ...process.env, PI_KIT_SECRET_STORE: 'macos' }) : this.store;
    for (const name of ['auth.json', 'models.json', 'mcp.json']) {
      try {
        const exported = await plaintextCredentialFile(join(agent, name), exportStore, name === 'auth.json');
        result.moved.push(...exported.moved);
        result.failed.push(...exported.failed);
      } catch {
        result.failed.push({ provider: name, reason: 'The configuration could not be migrated. It was retained; re-enter its credentials or retry after fixing the file.' });
      }
    }
    // Project configuration is intentionally never rewritten with plaintext secrets.
    return result;
  }

  // ---- what Settings shows

  status(): SecretsStatus {
    const credentialsEnabled = this.credentialsEnabled();
    const available = credentialsEnabled && this.store.available();
    const resolver = available ? this.resolver('provider') : undefined;
    return {
      store: this.store.kind,
      label: this.store.label,
      available,
      credentialsEnabled,
      access: available ? this.store.accessStatus?.() ?? { state: 'ready' } : { state: 'unavailable' },
      movable: available ? readMovableKeys(agentDirOf(process.env)) : [],
      ...(resolver ? { resolver: resolver.replace(/(-a |get |username )provider\b/, '$1<provider>') } : {}),
      cliOnPath: this.cliOnUserPath(),
      ...(this.cliBundle() ? { cliInstallDir: process.env['PI_KIT_BIN_DIR'] || defaultInstallDir(this.platform(), process.env, homedir()) } : {}),
      cliNeeded: !!resolver && resolver.includes('pi-kit-secret') && !this.cliOnUserPath(),
    };
  }

  retryAccess(): SecretsStatus {
    this.store.retryAccess?.();
    return this.status();
  }

  databaseProtection(): DatabaseProtection {
    return { ...this.database.protection, recoveryKeyShown: this.meta.getSetting('recoveryKeyShown') === true };
  }

  /** The recovery key, once: the first call returns it and records that it was shown, every later call refuses (the person saved it, or knows they did not). */
  recoveryKey(): { key: string } {
    if (this.meta.getSetting('recoveryKeyShown') === true) throw new Error('The recovery key was shown once already and is not shown again.');
    const key = this.database.recoveryKey();
    if (!key) throw new Error('The database is not encrypted, so there is no key to export.');
    this.meta.setSetting('recoveryKeyShown', true);
    return { key };
  }

  disk(): Promise<DiskEncryption> {
    return detectDiskEncryption();
  }
}
