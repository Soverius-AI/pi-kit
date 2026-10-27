import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { MacKeychainSecretStore } from './mac-keychain';
import { SECRET_SERVICE, type CredentialAccess, type SecretStoreKind } from '@pi-kit/protocol';

/**
 * The port behind every secret pi-kit keeps outside its own database: provider API keys and the database key. The backend and the
 * `pi-kit-secret` command use the same implementations, so an entry one wrote the other reads. Native operations may be asynchronous (Touch ID requires consent); database startup awaits its key and nothing here logs a value.
 */
export type StoreResult<T> = T | Promise<T>;

export interface SecretStore {
  /** Modern macOS storage requires the signed pi-kit-secret helper. */
  readonly helperResolver?: boolean;
  /** Refuse plaintext fallback if biometric storage fails. */
  readonly protected?: boolean;
  migrate?(): Promise<void>;
  /** Copy a legacy value without overwriting an existing modern credential. */
  migrateValue?(account: string, value: string): Promise<void>;
  readonly kind: SecretStoreKind;
  /** The store in words: "macOS Keychain", "a scratch file". */
  readonly label: string;
  /** Native capability only; never reads, writes or deletes a credential. Access may still be locked or denied. */
  available(): boolean;
  accessStatus?(): CredentialAccess;
  /** An explicit user retry allows native access again after a failed operation. Does not probe. */
  retryAccess?(): void;
  get(account: string): StoreResult<string | undefined>;
  set(account: string, value: string): StoreResult<void>;
  /** Whether there was an entry to delete. */
  delete(account: string): StoreResult<boolean>;
  /** Account names only, never values. */
  list(): StoreResult<string[]>;
}

/** The operating system's name for its credential store. */
export function osStoreLabel(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'darwin') return 'macOS Keychain';
  if (platform === 'win32') return 'Windows Credential Manager';
  return 'Secret Service (libsecret)';
}

/** What `@napi-rs/keyring` offers, as far as this file uses it (the package is loaded lazily, so a platform without its binary still starts). */
interface KeyringModule {
  Entry: new (service: string, account: string, options?: { linux?: { store?: 'secret-service' | 'keyutils' } }) => {
    getPassword(): string | null;
    setPassword(value: string): void;
    deletePassword(): boolean;
  };
  findCredentials(service: string): { account: string }[];
}

/** Safe to show or log; native details remain on the cause, which may contain sensitive data. */
export class SecretStoreAccessError extends Error {
  constructor(readonly access: CredentialAccess, cause?: unknown) {
    super(access.reason, { cause });
    this.name = 'SecretStoreAccessError';
  }
}

export function accessFailure(error: unknown): CredentialAccess {
  const message = error instanceof Error ? error.message : '';
  if (/locked|interaction.*not.*allowed|-25308/i.test(message)) return { state: 'locked', reason: 'The credential store is locked. Unlock it, then retry access.' };
  if (/denied|cancelled|canceled|authorization|authentication.*failed|-25293|(?:^|\D)-128(?:\D|$)/i.test(message)) return { state: 'denied', reason: 'Credential access was denied or cancelled. Allow access in the operating system, then retry.' };
  return { state: 'failed', reason: 'The credential store could not be accessed. Check its availability, then retry.' };
}

/** The OS credential store through `@napi-rs/keyring` (Keychain, Credential Manager, Secret Service), service `pi-kit`, one entry per account. */
export class KeyringSecretStore implements SecretStore {
  readonly kind = 'keychain' as const;
  readonly label: string;
  private module: KeyringModule | null | undefined;
  private readonly blocked = new Map<string, SecretStoreAccessError>();
  private accessed = false;

  constructor(
    private readonly load: () => KeyringModule = () => require('@napi-rs/keyring') as KeyringModule,
    platform: NodeJS.Platform = process.platform,
  ) {
    this.label = osStoreLabel(platform);
    this.platform = platform;
  }

  private readonly platform: NodeJS.Platform;

  private keyring(): KeyringModule | null {
    if (this.module === undefined) {
      try {
        this.module = this.load();
      } catch {
        this.module = null;
      }
    }
    return this.module;
  }

  private entry(account: string) {
    const keyring = this.keyring();
    if (!keyring) throw new Error('The operating system’s credential store is not available here.');
    // On Linux the entry is pinned to the Secret Service, so that `secret-tool` (which only sees that store) can resolve it; the kernel-keyring fallback would be invisible to it.
    return new keyring.Entry(SECRET_SERVICE, account, this.platform === 'linux' ? { linux: { store: 'secret-service' } } : undefined);
  }

  /** Loading the module must not provoke OS consent just to draw a status card. */
  available(): boolean {
    return this.keyring() !== null;
  }

  accessStatus(): CredentialAccess {
    if (!this.available()) return { state: 'unavailable', reason: 'The native credential store is not available here.' };
    const failure = this.blocked.values().next().value;
    return failure?.access ?? { state: this.accessed ? 'ready' : 'unknown' };
  }

  retryAccess(): void {
    this.blocked.clear();
    this.accessed = false;
  }

  private operate<T>(account: string, action: () => T): T {
    const previous = this.blocked.get(account);
    if (previous) throw previous;
    try {
      const result = action();
      this.accessed = true;
      return result;
    } catch (error) {
      const access = this.available() ? accessFailure(error) : this.accessStatus();
      const failure = new SecretStoreAccessError(access, error);
      this.blocked.set(account, failure);
      throw failure;
    }
  }

  get(account: string): string | undefined {
    return this.operate(account, () => this.entry(account).getPassword() ?? undefined);
  }

  set(account: string, value: string): void {
    this.operate(account, () => this.entry(account).setPassword(value));
  }

  delete(account: string): boolean {
    return this.operate(account, () => this.entry(account).deletePassword());
  }

  list(): string[] {
    const keyring = this.keyring();
    if (!keyring) return [];
    return this.operate('pi-kit/list', () => keyring
      .findCredentials(SECRET_SERVICE)
      .map((c) => c.account)
      .filter((account) => account !== 'pi-kit/probe')
      .sort());
  }
}

/** A JSON file of `{ account: value }` (mode 0600): the scratch store the tests and `PI_KIT_SECRET_STORE=file:<path>` use, so no test touches a real keychain. */
export class FileSecretStore implements SecretStore {
  readonly kind = 'file' as const;
  readonly label = 'scratch store, tests';

  constructor(private readonly path: string) {}

  available(): boolean {
    return true;
  }

  private read(): Record<string, string> {
    if (!existsSync(this.path)) return {};
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, string>) : {};
    } catch {
      return {};
    }
  }

  private write(data: Record<string, string>): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, this.path);
  }

  get(account: string): string | undefined {
    return this.read()[account];
  }

  set(account: string, value: string): void {
    this.write({ ...this.read(), [account]: value });
  }

  delete(account: string): boolean {
    const data = this.read();
    if (!(account in data)) return false;
    delete data[account];
    this.write(data);
    return true;
  }

  list(): string[] {
    return Object.keys(this.read()).sort();
  }
}

/** Entries in memory only (unit tests of the code that uses a store). */
export class MemorySecretStore implements SecretStore {
  readonly kind = 'memory' as const;
  readonly label = 'memory (tests)';
  private readonly data = new Map<string, string>();

  available(): boolean {
    return true;
  }
  get(account: string): string | undefined {
    return this.data.get(account);
  }
  set(account: string, value: string): void {
    this.data.set(account, value);
  }
  delete(account: string): boolean {
    return this.data.delete(account);
  }
  list(): string[] {
    return [...this.data.keys()].sort();
  }
}

/** No credential store: a headless machine without a keyring. Reads find nothing, writes say why not. */
export class NoSecretStore implements SecretStore {
  readonly kind = 'none' as const;
  readonly label = 'none';

  available(): boolean {
    return false;
  }
  get(): undefined {
    return undefined;
  }
  set(): never {
    throw new Error('There is no credential store on this machine.');
  }
  delete(): boolean {
    return false;
  }
  list(): string[] {
    return [];
  }
}

let selected: SecretStore | undefined;
let selectedFor: string | undefined;

/**
 * The store this process uses. `PI_KIT_SECRET_STORE` decides: `macos`, `legacy`, `memory`, `file:<path>`, or `none`. Unset disables storage on macOS;
 * other platforms use the operating system credential store when available. Tests and e2e runs set it so nothing reaches a real keychain. The choice is made once per distinct setting.
 */
export function selectSecretStore(env: NodeJS.ProcessEnv = process.env, fresh = false): SecretStore {
  const setting = env['PI_KIT_SECRET_STORE'] ?? '';
  if (!fresh && selected && selectedFor === setting) return selected;
  let store: SecretStore;
  if (setting === 'memory') store = new MemorySecretStore();
  else if (setting === 'none') store = new NoSecretStore();
  else if (setting.startsWith('file:')) store = new FileSecretStore(setting.slice('file:'.length));
  else if (setting === 'legacy') store = new KeyringSecretStore();
  else if (setting === 'macos') store = new MacKeychainSecretStore(env);
  else if (setting !== '') throw new Error('Unknown PI_KIT_SECRET_STORE setting. Use macos, legacy, memory, file:<path>, or none.');
  else if (process.platform === 'darwin') store = new NoSecretStore();
  else {
    const keyring = new KeyringSecretStore();
    store = keyring.available() ? keyring : new NoSecretStore();
  }
  selected = store;
  selectedFor = setting;
  return store;
}
