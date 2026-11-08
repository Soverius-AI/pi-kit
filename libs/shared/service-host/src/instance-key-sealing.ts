import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { InstanceKeyError, type InstanceKeyEncryption } from './instance-key';

const MAGIC = Buffer.from('PKIK1');
const MODE = { keyring: 0x6b, file: 0x66 } as const;
const IV = 12;
const TAG = 16;
const KEY = 32;

/** A 32-byte wrapping key. `read` answers undefined when none exists yet and throws when its store cannot be reached. */
export interface WrappingKeys {
  readonly mode: keyof typeof MODE;
  read(): Promise<Buffer | undefined>;
  create(): Promise<Buffer>;
}

/** What the wrapping key needs of a `SecretStore` (`@pi-kit/secret-store`). */
export interface CredentialStore {
  available(): boolean;
  get(account: string): string | undefined | Promise<string | undefined>;
  set(account: string, value: string): void | Promise<void>;
}

/** Sealed by the host itself rather than by a desktop's safeStorage. */
export const isHostSealed = (sealed: Buffer): boolean =>
  sealed.length > MAGIC.length && sealed.subarray(0, MAGIC.length).equals(MAGIC);

/** The owner-only file that replaces the OS store once the owner turns it on; beside the data folder, so a copy of the folder does not carry it. */
export const instanceKeyFile = (dataDir: string): string => {
  const folder = resolve(dataDir);
  return join(dirname(folder), `${basename(folder)}.instance-key`);
};

/** One entry per profile in the OS credential store. The store is made per read, so a store that comes up after the host still works. */
export class KeyringWrappingKeys implements WrappingKeys {
  readonly mode = 'keyring';
  private readonly account: string;

  constructor(
    private readonly store: () => CredentialStore,
    dataDir: string,
  ) {
    this.account = `pi-kit/instance-key/${createHash('sha256').update(resolve(dataDir)).digest('hex').slice(0, 16)}`;
  }

  async read(): Promise<Buffer | undefined> {
    const store = this.store();
    if (!store.available()) throw new Error('No OS credential store here.');
    const value = await store.get(this.account);
    if (value === undefined) return undefined;
    const key = Buffer.from(value, 'base64');
    if (key.length !== KEY) throw new Error('The stored wrapping key is malformed.');
    return key;
  }

  async create(): Promise<Buffer> {
    const existing = await this.read();
    if (existing) return existing;
    const key = randomBytes(KEY);
    await this.store().set(this.account, key.toString('base64'));
    return key;
  }
}

/** The opt-in file: protected by its owner-only permissions, like an SSH key. Never created by the host. */
export class FileWrappingKeys implements WrappingKeys {
  readonly mode = 'file';

  constructor(private readonly path: string) {}

  async read(): Promise<Buffer | undefined> {
    let file;
    try {
      file = await lstat(this.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    if (!file.isFile() || (process.platform !== 'win32' && file.mode & 0o077) || file.size !== KEY)
      throw new Error(`${this.path} must be a ${KEY}-byte file only its owner can read.`);
    const handle = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      return await handle.readFile();
    } finally {
      await handle.close();
    }
  }

  async create(): Promise<Buffer> {
    const existing = await this.read();
    if (existing) return existing;
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(randomBytes(KEY));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await link(temporary, this.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
    const key = await this.read();
    if (!key) throw new Error(`Could not create ${this.path}.`);
    return key;
  }
}

/** Seals the instance key in the host: AES-256-GCM under a wrapping key from the opt-in file when present, else the OS store. */
export class HostSealing implements InstanceKeyEncryption {
  constructor(
    private readonly keyring: WrappingKeys,
    private readonly file: WrappingKeys,
  ) {}

  async available(): Promise<boolean> {
    return (await this.current()) !== undefined;
  }

  async encrypt(value: string): Promise<Buffer> {
    const keys = await this.current();
    if (!keys) throw new InstanceKeyError('unavailable');
    const header = Buffer.concat([MAGIC, Buffer.from([MODE[keys.mode]])]);
    const iv = randomBytes(IV);
    const cipher = createCipheriv('aes-256-gcm', await keys.create(), iv);
    cipher.setAAD(header);
    const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return Buffer.concat([header, iv, cipher.getAuthTag(), body]);
  }

  async decrypt(sealed: Buffer): Promise<string> {
    const start = MAGIC.length + 1;
    if (!isHostSealed(sealed) || sealed.length <= start + IV + TAG) throw new InstanceKeyError('invalid');
    const mode = sealed[MAGIC.length];
    const keys = mode === MODE.file ? this.file : mode === MODE.keyring ? this.keyring : undefined;
    if (!keys) throw new InstanceKeyError('invalid');
    const key = await keys.read().catch(() => undefined);
    if (!key) throw new InstanceKeyError('unavailable');
    const decipher = createDecipheriv('aes-256-gcm', key, sealed.subarray(start, start + IV));
    decipher.setAAD(sealed.subarray(0, start));
    decipher.setAuthTag(sealed.subarray(start + IV, start + IV + TAG));
    return Buffer.concat([decipher.update(sealed.subarray(start + IV + TAG)), decipher.final()]).toString('utf8');
  }

  private async current(): Promise<WrappingKeys | undefined> {
    try {
      if (await this.file.read()) return this.file;
    } catch {
      // The owner turned the file on but it is unsafe: refuse rather than fall back to another store.
      return undefined;
    }
    try {
      await this.keyring.read();
      return this.keyring;
    } catch {
      return undefined;
    }
  }
}

/** The host's own seal first. A key a desktop sealed before still opens through that desktop, and the key store then re-seals it here. */
export class MigratingSealing implements InstanceKeyEncryption {
  constructor(
    private readonly host: InstanceKeyEncryption,
    private readonly desktop: InstanceKeyEncryption,
  ) {}

  async available(): Promise<boolean> {
    return (await this.host.available()) || (await this.desktop.available().catch(() => false));
  }

  async encrypt(value: string): Promise<Buffer> {
    return (await this.host.available()) ? this.host.encrypt(value) : this.desktop.encrypt(value);
  }

  async decrypt(sealed: Buffer): Promise<string> {
    if (isHostSealed(sealed)) return this.host.decrypt(sealed);
    if (!(await this.desktop.available().catch(() => false))) throw new InstanceKeyError('unavailable');
    return this.desktop.decrypt(sealed);
  }

  async reseal(sealed: Buffer, value: string): Promise<Buffer | undefined> {
    if (isHostSealed(sealed) || !(await this.host.available())) return undefined;
    return this.host.encrypt(value);
  }
}
