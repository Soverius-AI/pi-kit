import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { InstanceKeyStore, type InstanceKeyEncryption } from './instance-key';
import {
  type CredentialStore,
  FileWrappingKeys,
  HostSealing,
  instanceKeyFile,
  isHostSealed,
  KeyringWrappingKeys,
  MigratingSealing,
} from './instance-key-sealing';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

/** An OS credential store kept in memory; `reachable` false is a Linux server without a Secret Service. */
function credentials(reachable = true) {
  const entries = new Map<string, string>();
  const store: CredentialStore = {
    available: () => true,
    get: (account) => {
      if (!reachable) throw new Error('No Secret Service.');
      return entries.get(account);
    },
    set: (account, value) => {
      if (!reachable) throw new Error('No Secret Service.');
      entries.set(account, value);
    },
  };
  return { store, entries };
}

/** The desktop's safeStorage as the host sees it: another seal, there only while a desktop is attached. */
function desktopSealing() {
  const secret = randomBytes(32);
  const sealing = {
    attached: true,
    available: async () => sealing.attached,
    encrypt: async (value: string) => {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', secret, iv);
      return Buffer.concat([iv, cipher.update(value, 'utf8'), cipher.final(), cipher.getAuthTag()]);
    },
    decrypt: async (bytes: Buffer) => {
      const decipher = createDecipheriv('aes-256-gcm', secret, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(-16));
      return Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString();
    },
  } satisfies InstanceKeyEncryption & { attached: boolean };
  return sealing;
}

async function profile() {
  const dir = await mkdtemp(join(tmpdir(), 'pi-kit-sealing-'));
  directories.push(dir);
  const dataDir = join(dir, 'pi-kit');
  return { dataDir, keyPath: join(dataDir, 'instance-keys', 'identity.v1.enc'), id: randomUUID() };
}

const hostSealing = (dataDir: string, store: CredentialStore) =>
  new HostSealing(new KeyringWrappingKeys(() => store, dataDir), new FileWrappingKeys(instanceKeyFile(dataDir)));

describe('instance key sealed by the host', () => {
  it('opens a desktop-sealed key once through the desktop, re-seals it, and signs with no desktop afterwards', async () => {
    const p = await profile();
    const desktop = desktopSealing();
    const created = await new InstanceKeyStore(() => p.keyPath, desktop).info(p.id, true);
    const { store } = credentials();

    const migrated = new InstanceKeyStore(
      () => p.keyPath,
      new MigratingSealing(hostSealing(p.dataDir, store), desktop),
    );
    expect(await migrated.info(p.id)).toEqual(created);
    expect(isHostSealed(await readFile(p.keyPath))).toBe(true);

    desktop.attached = false;
    const headless = new InstanceKeyStore(
      () => p.keyPath,
      new MigratingSealing(hostSealing(p.dataDir, store), desktop),
    );
    expect(await headless.info(p.id)).toEqual(created);
    await expect(
      headless.sign(p.id, { purpose: 'session', nonce: 'n'.repeat(16), aud: randomUUID() }),
    ).resolves.toEqual(expect.any(String));
  });

  it('fails closed and keeps the file when the seal that made it is gone', async () => {
    const p = await profile();
    const desktop = desktopSealing();
    await new InstanceKeyStore(() => p.keyPath, desktop).info(p.id, true);
    const legacy = await readFile(p.keyPath);
    desktop.attached = false;
    const sealing = new MigratingSealing(hostSealing(p.dataDir, credentials().store), desktop);
    await expect(new InstanceKeyStore(() => p.keyPath, sealing).info(p.id, true)).rejects.toMatchObject({
      code: 'unavailable',
    });
    expect(await readFile(p.keyPath)).toEqual(legacy);

    const q = await profile();
    await new InstanceKeyStore(() => q.keyPath, hostSealing(q.dataDir, credentials().store)).info(q.id, true);
    const sealed = await readFile(q.keyPath);
    const lostKeyring = hostSealing(q.dataDir, credentials().store);
    await expect(new InstanceKeyStore(() => q.keyPath, lostKeyring).info(q.id, true)).rejects.toMatchObject({
      code: 'unavailable',
    });
    expect(await readFile(q.keyPath)).toEqual(sealed);
  });

  it('seals with the opt-in file where no OS store answers, and never falls back to another store for it', async () => {
    const p = await profile();
    const offline = credentials(false);
    expect(await hostSealing(p.dataDir, offline.store).available()).toBe(false);

    await new FileWrappingKeys(instanceKeyFile(p.dataDir)).create();
    const created = await new InstanceKeyStore(() => p.keyPath, hostSealing(p.dataDir, offline.store)).info(p.id, true);
    const online = credentials();
    expect(await new InstanceKeyStore(() => p.keyPath, hostSealing(p.dataDir, online.store)).info(p.id)).toEqual(
      created,
    );
    expect(online.entries.size).toBe(0);

    if (process.platform !== 'win32') {
      await chmod(instanceKeyFile(p.dataDir), 0o644);
      await expect(
        new InstanceKeyStore(() => p.keyPath, hostSealing(p.dataDir, online.store)).info(p.id),
      ).rejects.toMatchObject({ code: 'unavailable' });
      await chmod(instanceKeyFile(p.dataDir), 0o600);
    }
    await unlink(instanceKeyFile(p.dataDir));
    await expect(
      new InstanceKeyStore(() => p.keyPath, hostSealing(p.dataDir, online.store)).info(p.id),
    ).rejects.toMatchObject({ code: 'unavailable' });
  });
});
