import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { DB_KEY_ACCOUNT, isProviderAccount, type CredentialAccess } from '@pi-kit/protocol';
import { accessFailure, KeyringSecretStore, SecretStoreAccessError, type SecretStore } from './store';

interface NativeEntry {
  get(account: string, type: 'string'): Promise<string | null>;
  getOrCreate(account: string, initial: string): Promise<string>;
  set(account: string, value: string): Promise<void>;
  remove(account: string): Promise<boolean>;
  status(account: string): Promise<{ status: string }>;
}
export interface MacKeychainModule {
  openKeychainStore(options: {
    keychainService: string;
    authentication: { accessControl: 'user-presence' } | 'none';
    iCloudSync: false;
    mutableAccounts: string[];
  }): NativeEntry;
}

const validAccount = (account: string): boolean => account === DB_KEY_ACCOUNT || isProviderAccount(account);

/** Account prefix of the unattended copies: separate items, because an item's access control is fixed when it is made. */
const UNATTENDED = 'unattended/';

/** Data Protection Keychain. Touch ID (or the Mac password) is enforced on each item by macOS; unattended copies are the opt-in exception. */
export class MacKeychainSecretStore implements SecretStore {
  readonly kind = 'keychain' as const;
  readonly helperResolver = true;
  readonly protected = true;
  private native: MacKeychainModule | null | undefined;
  private readonly blocked = new Map<string, SecretStoreAccessError>();
  private accessed = false;
  private pending: Promise<unknown> = Promise.resolve();
  private readonly registry: string;
  private readonly service: string;

  /** `unattended`: read keys from their copies, without Touch ID (see `setUnattended`). */
  constructor(
    env: NodeJS.ProcessEnv = process.env,
    private readonly legacy: SecretStore = new KeyringSecretStore(),
    private readonly load: () => MacKeychainModule = () => require('keychain-store') as MacKeychainModule,
    private unattended = false,
  ) {
    this.registry = join(
      env['PI_CODING_AGENT_DIR'] || join(homedir(), '.pi', 'agent'),
      'pi-kit-keychain-accounts.jsonl',
    );
    this.service = env['PI_KIT_KEYCHAIN_SERVICE'] || 'dev.pi-kit.app';
  }

  available(): boolean {
    if (this.native === undefined) {
      try {
        this.native = this.load();
      } catch {
        this.native = null;
      }
    }
    return this.native !== null;
  }

  accessStatus(): CredentialAccess {
    if (!this.available())
      return {
        state: 'unavailable',
        reason: 'Touch ID storage is unavailable. Reinstall a signed macOS build of pi-kit.',
      };
    return this.blocked.values().next().value?.access ?? { state: this.accessed ? 'ready' : 'unknown' };
  }

  retryAccess(): void {
    this.blocked.clear();
    this.accessed = false;
  }

  get label(): string {
    return this.unattended ? 'macOS Keychain (Touch ID, readable while you are away)' : 'macOS Keychain (Touch ID)';
  }

  get unattendedKeys(): boolean {
    return this.unattended;
  }

  private entry(account: string, unattended = false): NativeEntry {
    if (!validAccount(account)) throw new Error('Invalid credential account.');
    if (!this.available() || !this.native) throw new Error('Touch ID storage is unavailable.');
    return this.native.openKeychainStore({
      keychainService: this.service,
      authentication: unattended ? 'none' : { accessControl: 'user-presence' },
      iCloudSync: false,
      mutableAccounts: [unattended ? UNATTENDED + account : account],
    });
  }

  private readCopy(account: string): Promise<string | undefined> {
    return this.operate(
      account,
      async () => (await this.entry(account, true).get(UNATTENDED + account, 'string')) ?? undefined,
    );
  }

  private writeCopy(account: string, value: string): Promise<void> {
    return this.operate(account, () => this.entry(account, true).set(UNATTENDED + account, value));
  }

  private removeCopy(account: string): Promise<boolean> {
    return this.operate(account, () => this.entry(account, true).remove(UNATTENDED + account));
  }

  /** Copies every key (one Touch ID read each), or removes the copies; a failure part-way removes the copies already made. */
  async setUnattended(enabled: boolean): Promise<void> {
    const accounts = await this.list();
    if (!enabled) {
      this.unattended = false;
      for (const account of accounts) await this.removeCopy(account);
      return;
    }
    const made: string[] = [];
    try {
      for (const account of accounts) {
        const value = await this.protectedGet(account);
        if (value === undefined) continue;
        await this.writeCopy(account, value);
        made.push(account);
      }
    } catch (error) {
      for (const account of made) await this.removeCopy(account).catch(() => undefined);
      throw error;
    }
    this.unattended = true;
  }

  private operate<T>(account: string, action: () => Promise<T>): Promise<T> {
    const run = this.pending.then(async () => {
      const previous = this.blocked.get(account);
      if (previous) throw previous;
      try {
        const result = await action();
        this.accessed = true;
        return result;
      } catch (error) {
        const nativeError = error as { code?: string; details?: { osStatus?: number } } | null;
        const code = nativeError?.code;
        const access: CredentialAccess =
          code === 'host_identity_invalid' || nativeError?.details?.osStatus === -34018
            ? {
                state: 'unavailable',
                reason:
                  'Touch ID needs an Apple-signed pi-kit app with its Keychain access group and provisioning profile.',
              }
            : this.available()
              ? accessFailure(
                  new Error(`${nativeError?.details?.osStatus ?? ''} ${error instanceof Error ? error.message : ''}`),
                )
              : this.accessStatus();
        const failure = new SecretStoreAccessError(access, error);
        this.blocked.set(account, failure);
        throw failure;
      }
    });
    // Serialize consent dialogs; a rejected operation must not poison the queue.
    this.pending = run.catch(() => undefined);
    return run;
  }

  /** Account names only. Append records avoid lost index updates from concurrent CLI processes. */
  private record(account: string, present: boolean): void {
    mkdirSync(dirname(this.registry), { recursive: true });
    appendFileSync(this.registry, `${JSON.stringify({ account, present })}\n`, { mode: 0o600 });
  }

  private accounts(): string[] {
    const accounts = new Set<string>();
    if (existsSync(this.registry)) {
      for (const line of readFileSync(this.registry, 'utf8').split('\n')) {
        if (!line) continue;
        const record = JSON.parse(line) as { account?: unknown; present?: unknown };
        if (typeof record.account !== 'string' || !validAccount(record.account)) continue;
        if (record.present === true) accounts.add(record.account);
        else if (record.present === false) accounts.delete(record.account);
      }
    }
    return [...accounts].sort();
  }

  async get(account: string): Promise<string | undefined> {
    if (!this.unattended) return this.protectedGet(account);
    const copied = await this.readCopy(account);
    if (copied !== undefined) return copied;
    // No copy yet: read it once with Touch ID and copy it.
    const value = await this.protectedGet(account);
    if (value !== undefined) await this.writeCopy(account, value);
    return value;
  }

  private protectedGet(account: string): Promise<string | undefined> {
    return this.operate(account, async () => {
      const entry = this.entry(account);
      const status = await entry.status(account);
      if (status.status !== 'missing') return (await entry.get(account, 'string')) ?? undefined;
      const original = await this.legacy.get(account);
      if (original === undefined) return undefined;
      await this.copyVerified(entry, account, original);
      return original;
    });
  }

  private async copyVerified(entry: NativeEntry, account: string, original: string): Promise<void> {
    // Atomic creation adopts a concurrent winner, but never overwrites its value.
    const copied = await entry.getOrCreate(account, original);
    if (copied !== original || (await entry.get(account, 'string')) !== original) {
      throw new Error('Credential migration could not be verified. The original entry was retained.');
    }
    this.record(account, true);
  }

  migrateValue(account: string, value: string): Promise<void> {
    return this.operate(account, () => this.copyVerified(this.entry(account), account, value));
  }

  async set(account: string, value: string): Promise<void> {
    await this.operate(account, async () => {
      await this.entry(account).set(account, value);
      this.record(account, true);
    });
    if (this.unattended) await this.writeCopy(account, value);
  }

  async delete(account: string): Promise<boolean> {
    // Remove the unattended copy first, so a signed-out key is never readable without Touch ID. Whatever this store's
    // mode, a copy left by an unattended store must not outlive the key.
    const copied = await this.removeCopy(account);
    return this.operate(account, async () => {
      const entry = this.entry(account);
      // Remove the legacy entry first, so a later read cannot resurrect a signed-out credential.
      const old = await this.legacy.delete(account);
      const removed = await entry.remove(account);
      this.record(account, false);
      return old || removed || copied;
    });
  }

  list(): Promise<string[]> {
    return this.operate('pi-kit/list', async () => {
      const accounts = new Set([...this.accounts(), ...(await this.legacy.list())]);
      return [...accounts].filter(validAccount).sort();
    });
  }

  async migrate(): Promise<void> {
    if (!this.available()) throw new SecretStoreAccessError(this.accessStatus());
    // Metadata validates the host before legacy enumeration. Never re-read migrated secrets on startup.
    await this.operate(DB_KEY_ACCOUNT, () => this.entry(DB_KEY_ACCOUNT).status(DB_KEY_ACCOUNT));
    for (const account of await this.list()) {
      const status = await this.operate(account, () => this.entry(account).status(account));
      if (status.status === 'missing') await this.get(account);
    }
  }
}
