import type { SafeStorage } from 'electron';
import type { InstanceKeyEncryption } from '@pi-kit/service-host';

/** Async Electron adapter. Linux's plaintext fallback is never accepted for a reusable instance key. */
export class SafeStorageEncryption implements InstanceKeyEncryption {
  constructor(
    private readonly storage: Pick<
      SafeStorage,
      'isAsyncEncryptionAvailable' | 'getSelectedStorageBackend' | 'encryptStringAsync' | 'decryptStringAsync'
    >,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  async available(): Promise<boolean> {
    if (!(await this.storage.isAsyncEncryptionAvailable())) return false;
    return (
      this.platform !== 'linux' ||
      ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'].includes(this.storage.getSelectedStorageBackend())
    );
  }

  encrypt(value: string): Promise<Buffer> {
    return this.storage.encryptStringAsync(value);
  }

  async decrypt(value: Buffer): Promise<string> {
    return (await this.storage.decryptStringAsync(value)).result;
  }
}
