import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readSecurityPreferences, selectSecretStore, type SecretStore } from '@pi-kit/secret-store';
import { BG_DB_FILE, DB_FILE } from '../db/database.service';
import { isPlainDatabase } from '../db/encryption';

/** Inspect the file, never a credential, before selecting startup storage. */
export function hasEncryptedDatabase(dataDir: string): boolean {
  return [DB_FILE, BG_DB_FILE].some((file) => {
    const path = join(dataDir, file);
    return existsSync(path) && statSync(path).size > 0 && !isPlainDatabase(path);
  });
}

/** Existing encrypted profiles retain their store; fresh macOS profiles never probe Keychain. */
export function startupSecretStore(dataDir: string, env: NodeJS.ProcessEnv = process.env): SecretStore {
  const preferences = readSecurityPreferences(dataDir);
  const protectedProfile = preferences?.credentialStoreEnabled || hasEncryptedDatabase(dataDir);
  const selectedEnv = !env['PI_KIT_SECRET_STORE'] && process.platform === 'darwin' && protectedProfile
    ? { ...env, PI_KIT_SECRET_STORE: 'macos' }
    : env;
  return selectSecretStore(selectedEnv);
}

/** Explicit scratch/legacy stores retain their test and automation semantics. */
export function encryptionEnabled(dataDir: string, store: SecretStore): boolean {
  return hasEncryptedDatabase(dataDir)
    || (readSecurityPreferences(dataDir)?.credentialStoreEnabled ?? store.kind !== 'none');
}
