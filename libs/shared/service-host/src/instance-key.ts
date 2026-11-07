import { constants } from 'node:fs';
import { open, mkdir, lstat, link, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  type KeyObject,
} from 'node:crypto';
import {
  InstanceIdSchema,
  InstanceKeyInfoSchema,
  PeerProofClaimsSchema,
  type InstanceKeyInfo,
  type PeerProofClaims,
} from '@pi-kit/protocol';

export interface InstanceKeyEncryption {
  available(): Promise<boolean>;
  encrypt(value: string): Promise<Buffer>;
  decrypt(value: Buffer): Promise<string>;
  /** New bytes for a key that opened under an older seal, or undefined to keep the file as it is. */
  reseal?(sealed: Buffer, value: string): Promise<Buffer | undefined>;
}
export class InstanceKeyError extends Error {
  constructor(readonly code: 'unavailable' | 'missing' | 'invalid' | 'identity-mismatch') {
    super(
      code === 'identity-mismatch'
        ? 'The protected instance key belongs to a different profile identity. Restore the matching key; no identity was replaced.'
        : 'The protected instance key is unavailable. Unlock OS-protected storage or restore the original key. No plaintext fallback or replacement was used.',
    );
  }
}
interface LoadedKey {
  instanceId: string;
  scope: string;
  key: KeyObject;
  info: InstanceKeyInfo;
}

/** A separate, OS-sealed service identity. Never accesses or changes provider/database-key policy. */
export class InstanceKeyStore {
  private loaded?: LoadedKey;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly path: () => string,
    private readonly encryption: InstanceKeyEncryption,
  ) {}

  info(instanceId: string, create = false): Promise<InstanceKeyInfo> {
    return this.serial(async () => structuredClone((await this.load(instanceId, create)).info));
  }
  sign(instanceId: string, value: PeerProofClaims): Promise<string> {
    return this.serial(async () => {
      const { SignJWT } = await import('jose');
      const claims = PeerProofClaimsSchema.parse(value);
      const loaded = await this.load(instanceId, false);
      return new SignJWT(claims)
        .setProtectedHeader({ alg: 'EdDSA', typ: 'JWT' })
        .setIssuer(loaded.instanceId)
        .setIssuedAt()
        .setExpirationTime('30s')
        .sign(loaded.key);
    });
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work, work);
    this.queue = result.catch(() => undefined);
    return result;
  }
  private async load(id: string, create: boolean): Promise<LoadedKey> {
    const instanceId = InstanceIdSchema.parse(id);
    const path = this.path(),
      scope = createHash('sha256').update(resolve(path)).digest('hex');
    if (this.loaded) {
      if (this.loaded.instanceId !== instanceId || this.loaded.scope !== scope)
        throw new InstanceKeyError('identity-mismatch');
      return this.loaded;
    }
    try {
      if (!(await this.encryption.available())) throw new InstanceKeyError('unavailable');
    } catch {
      throw new InstanceKeyError('unavailable');
    }
    let bytes: Buffer;
    try {
      const file = await lstat(path);
      if (
        !file.isFile() ||
        file.isSymbolicLink() ||
        (process.platform !== 'win32' && file.mode & 0o077) ||
        file.size > 16384
      )
        throw new InstanceKeyError('invalid');
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        bytes = await handle.readFile();
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw error instanceof InstanceKeyError ? error : new InstanceKeyError('invalid');
      if (!create) throw new InstanceKeyError('missing');
      const generated = generateKeyPairSync('ed25519');
      const record = JSON.stringify({
        version: 1,
        instanceId,
        profileScope: scope,
        privateKey: generated.privateKey.export({ type: 'pkcs8', format: 'pem' }),
      });
      let sealed: Buffer;
      try {
        sealed = await this.encryption.encrypt(record);
      } catch {
        throw new InstanceKeyError('unavailable');
      }
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        const handle = await open(temporary, 'wx', 0o600);
        try {
          await handle.writeFile(sealed);
          await handle.sync();
        } finally {
          await handle.close();
        }
        // Atomic no-clobber publication. Another process's existing identity always wins.
        await link(temporary, path);
        if (process.platform !== 'win32') {
          const directory = await open(dirname(path), 'r');
          try {
            await directory.sync();
          } finally {
            await directory.close();
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new InstanceKeyError('unavailable');
      } finally {
        await unlink(temporary).catch(() => undefined);
      }
      // Read the committed winner, not our potentially discarded generated key.
      return this.load(instanceId, false);
    }
    try {
      const plain = await this.encryption.decrypt(bytes);
      const record: unknown = JSON.parse(plain);
      if (!record || typeof record !== 'object') throw new InstanceKeyError('invalid');
      const value = record as { version?: unknown; instanceId?: unknown; profileScope?: unknown; privateKey?: unknown };
      if (value.version !== 1 || typeof value.privateKey !== 'string' || value.privateKey.length > 4096)
        throw new InstanceKeyError('invalid');
      if (value.instanceId !== instanceId || value.profileScope !== scope)
        throw new InstanceKeyError('identity-mismatch');
      const key = createPrivateKey(value.privateKey);
      if (key.asymmetricKeyType !== 'ed25519') throw new InstanceKeyError('invalid');
      const { calculateJwkThumbprint } = await import('jose');
      const exported = createPublicKey(key).export({ format: 'jwk' });
      if (typeof exported.x !== 'string') throw new InstanceKeyError('invalid');
      const publicKey = { kty: 'OKP' as const, crv: 'Ed25519' as const, x: exported.x };
      const info = InstanceKeyInfoSchema.parse({
        publicKey,
        fingerprint: await calculateJwkThumbprint(publicKey, 'sha256'),
      });
      this.loaded = { instanceId, scope, key, info };
      await this.reseal(path, bytes, plain);
      return this.loaded;
    } catch (error) {
      throw error instanceof InstanceKeyError ? error : new InstanceKeyError('invalid');
    }
  }

  /** Replaces the file only with bytes that read back to the same key; on any failure the old file stays and the next load tries again. */
  private async reseal(path: string, sealed: Buffer, plain: string): Promise<void> {
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      const resealed = await this.encryption.reseal?.(sealed, plain);
      if (!resealed || (await this.encryption.decrypt(resealed)) !== plain) return;
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(resealed);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, path);
    } catch {
      await unlink(temporary).catch(() => undefined);
    }
  }
}
