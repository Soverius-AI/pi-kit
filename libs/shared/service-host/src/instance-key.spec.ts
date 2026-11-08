import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { InstanceKeyStore, type InstanceKeyEncryption } from './instance-key';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'pi-kit-instance-key-'));
  directories.push(dir);
  const path = join(dir, 'key.enc');
  const secret = randomBytes(32);
  const encryption: InstanceKeyEncryption = {
    available: async () => true,
    encrypt: async (value) => {
      const iv = randomBytes(12),
        cipher = createCipheriv('aes-256-gcm', secret, iv);
      const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
    },
    decrypt: async (bytes) => {
      const decipher = createDecipheriv('aes-256-gcm', secret, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString();
    },
  };
  return { path, encryption, id: randomUUID(), store: new InstanceKeyStore(() => path, encryption) };
}

describe('OS-sealed unattended instance identity', () => {
  it('creates only on explicit consent, persists an encrypted key and signs short-lived audience-bound proofs', async () => {
    const { importJWK, jwtVerify } = await import('jose');
    const f = await fixture();
    await expect(f.store.info(f.id)).rejects.toMatchObject({ code: 'missing' });
    const info = await f.store.info(f.id, true);
    expect((await stat(f.path)).mode & 0o777).toBe(0o600);
    const ciphertext = (await readFile(f.path)).toString();
    expect(ciphertext).not.toContain('PRIVATE KEY');
    expect(ciphertext).not.toContain(f.id);
    expect(Object.keys(info.publicKey)).toEqual(['kty', 'crv', 'x']);
    const audience = randomUUID();
    const proof = await f.store.sign(f.id, {
      purpose: 'session',
      nonce: randomBytes(32).toString('base64url'),
      aud: audience,
    });
    const verified = await jwtVerify(proof, await importJWK(info.publicKey, 'EdDSA'), {
      issuer: f.id,
      audience,
      algorithms: ['EdDSA'],
    });
    expect(verified.payload.exp! - verified.payload.iat!).toBe(30);
    await expect(
      jwtVerify(proof, await importJWK(info.publicKey, 'EdDSA'), { audience: randomUUID() }),
    ).rejects.toThrow();
    const reopened = new InstanceKeyStore(() => f.path, f.encryption);
    expect(await reopened.info(f.id)).toEqual(info);
  });

  it('fails closed on unavailable/locked storage, corruption and profile mismatch without replacing a key', async () => {
    const f = await fixture();
    await expect(
      new InstanceKeyStore(() => f.path, { ...f.encryption, available: async () => false }).info(f.id, true),
    ).rejects.toMatchObject({ code: 'unavailable' });
    const info = await f.store.info(f.id, true);
    const before = await readFile(f.path);
    await expect(new InstanceKeyStore(() => f.path, f.encryption).info(randomUUID(), true)).rejects.toMatchObject({
      code: 'identity-mismatch',
    });
    await expect(
      new InstanceKeyStore(() => f.path, {
        ...f.encryption,
        decrypt: async () => {
          throw Error('locked');
        },
      }).info(f.id, true),
    ).rejects.toMatchObject({ code: 'invalid' });
    expect(await readFile(f.path)).toEqual(before);
    await writeFile(f.path, 'corrupt', { mode: 0o600 });
    await expect(new InstanceKeyStore(() => f.path, f.encryption).info(f.id, true)).rejects.toMatchObject({
      code: 'invalid',
    });
    expect(await readFile(f.path, 'utf8')).toBe('corrupt');
    expect(info.fingerprint).toHaveLength(43);
  });

  it('rejects a cloned key at a different profile path even under the same OS encryption context', async () => {
    const f = await fixture(),
      clone = await fixture();
    await f.store.info(f.id, true);
    await copyFile(f.path, clone.path);
    const before = await readFile(clone.path);
    await expect(new InstanceKeyStore(() => clone.path, f.encryption).info(f.id, true)).rejects.toMatchObject({
      code: 'identity-mismatch',
    });
    expect(await readFile(clone.path)).toEqual(before);
    let path = f.path;
    const cached = new InstanceKeyStore(() => path, f.encryption);
    await cached.info(f.id);
    path = clone.path;
    await expect(cached.info(f.id)).rejects.toMatchObject({ code: 'identity-mismatch' });
  });

  it('uses an atomic no-clobber key when two owners race and never leaks mutable cached key info', async () => {
    const f = await fixture();
    const other = new InstanceKeyStore(() => f.path, f.encryption);
    const [a, b] = await Promise.all([f.store.info(f.id, true), other.info(f.id, true)]);
    expect(a).toEqual(b);
    a.publicKey.x = 'changed';
    expect((await f.store.info(f.id)).publicKey.x).toBe(b.publicKey.x);
  });
});
