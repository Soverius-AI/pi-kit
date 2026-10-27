import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemorySecretStore, NoSecretStore, selectSecretStore, writeSecurityPreferences, type SecretStore } from '@pi-kit/secret-store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BG_DB_FILE, DB_FILE } from '../db/database.service';
import { encryptionEnabled, hasEncryptedDatabase, startupSecretStore } from './security-config';

// Selection tests must never instantiate a native keychain, even on a macOS developer machine.
vi.mock('@pi-kit/secret-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@pi-kit/secret-store')>();
  return { ...actual, selectSecretStore: vi.fn() };
});

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
let dir: string;
let native: SecretStore;
beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  dir = mkdtempSync(join(tmpdir(), 'pk-security-config-'));
  native = {
    kind: 'keychain', label: 'Mock original macOS store', protected: true,
    available: vi.fn(() => true), get: vi.fn(() => undefined), set: vi.fn(),
    delete: vi.fn(() => false), list: vi.fn(() => []), accessStatus: vi.fn(() => ({ state: 'ready' as const })),
  };
  vi.mocked(selectSecretStore).mockImplementation((env = {}) => {
    const choice = env['PI_KIT_SECRET_STORE'];
    if (choice === 'macos' || choice === 'legacy') return native;
    if (choice === 'memory' || choice?.startsWith('file:')) return new MemorySecretStore();
    return new NoSecretStore();
  });
});
afterEach(() => {
  Object.defineProperty(process, 'platform', originalPlatform);
  vi.clearAllMocks();
});

function expectNoNativeAccess(): void {
  for (const method of [native.available, native.get, native.set, native.delete, native.list, native.accessStatus]) {
    expect(method).not.toHaveBeenCalled();
  }
}

describe('startup security choices', () => {
  it('defaults a fresh macOS profile to none and plaintext without probing native credentials', () => {
    const store = startupSecretStore(dir, {});
    expect(store.kind).toBe('none');
    expect(selectSecretStore).toHaveBeenCalledWith({});
    expect(hasEncryptedDatabase(dir)).toBe(false);
    expect(encryptionEnabled(dir, store)).toBe(false);
    expectNoNativeAccess();
  });

  it('persisted credential opt-in selects macOS storage and enables database encryption at startup', () => {
    writeSecurityPreferences(dir, { credentialStoreEnabled: true });
    const store = startupSecretStore(dir, {});
    expect(store).toBe(native);
    expect(selectSecretStore).toHaveBeenCalledWith({ PI_KIT_SECRET_STORE: 'macos' });
    expect(encryptionEnabled(dir, store)).toBe(true);
    expectNoNativeAccess();
  });

  it.each(['memory', 'file:/unused-test-store', 'none', 'legacy'])('respects explicit %s overrides instead of choosing macOS storage', (choice) => {
    const store = startupSecretStore(dir, { PI_KIT_SECRET_STORE: choice });
    expect(selectSecretStore).toHaveBeenCalledWith({ PI_KIT_SECRET_STORE: choice });
    expect(encryptionEnabled(dir, store)).toBe(choice !== 'none');
    expectNoNativeAccess();
  });

  it('ignores the old database opt-out and follows the credential preference', () => {
    writeFileSync(join(dir, 'security.json'), JSON.stringify({ credentialStoreEnabled: true, databaseEncryptionEnabled: false }));
    expect(encryptionEnabled(dir, startupSecretStore(dir, { PI_KIT_SECRET_STORE: 'memory' }))).toBe(true);
    expectNoNativeAccess();
  });

  it('ignores the old database opt-in when credentials are disabled', () => {
    writeFileSync(join(dir, 'security.json'), JSON.stringify({ credentialStoreEnabled: false, databaseEncryptionEnabled: true }));
    expect(startupSecretStore(dir, {}).kind).toBe('none');
    expect(encryptionEnabled(dir, new MemorySecretStore())).toBe(false);
    expectNoNativeAccess();
  });

  it.each([DB_FILE, BG_DB_FILE])('retains the original store and encryption for encrypted %s despite credential opt-out', (file) => {
    writeFileSync(join(dir, file), Buffer.alloc(4096, 42));
    writeSecurityPreferences(dir, { credentialStoreEnabled: false });
    expect(hasEncryptedDatabase(dir)).toBe(true);
    expect(startupSecretStore(dir, {})).toBe(native);
    expect(encryptionEnabled(dir, native)).toBe(true);
    expect(encryptionEnabled(dir, new NoSecretStore())).toBe(true);
    expectNoNativeAccess();
  });

  it.each([DB_FILE, BG_DB_FILE])('existing encrypted %s without preferences remains encrypted and selects its original store', (file) => {
    writeFileSync(join(dir, file), Buffer.alloc(4096, 42));
    expect(startupSecretStore(dir, {})).toBe(native);
    expect(encryptionEnabled(dir, native)).toBe(true);
    expectNoNativeAccess();
  });

  it('a plaintext or empty file is not an encrypted existing profile', () => {
    const file = join(dir, 'pi-kit.sqlite');
    writeFileSync(file, '');
    expect(hasEncryptedDatabase(dir)).toBe(false);
    writeFileSync(file, 'SQLite format 3\0some pages');
    expect(hasEncryptedDatabase(dir)).toBe(false);
    expect(startupSecretStore(dir, {}).kind).toBe('none');
    expectNoNativeAccess();
  });
});
