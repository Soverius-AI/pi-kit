import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

/** Opt-in security choices only. Never store credentials in this file. */
export interface SecurityPreferences {
  credentialStoreEnabled: boolean;
}

function validate(value: unknown, allowLegacy = false): SecurityPreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid security.json: expected credentialStoreEnabled boolean with no unknown fields.');
  }
  const object = value as Record<string, unknown>;
  const allowed = allowLegacy ? ['credentialStoreEnabled', 'databaseEncryptionEnabled'] : ['credentialStoreEnabled'];
  if (Object.keys(object).some((key) => !allowed.includes(key)) ||
      !Object.hasOwn(object, 'credentialStoreEnabled') || typeof object['credentialStoreEnabled'] !== 'boolean' ||
      (Object.hasOwn(object, 'databaseEncryptionEnabled') && typeof object['databaseEncryptionEnabled'] !== 'boolean')) {
    throw new Error('Invalid security.json: expected credentialStoreEnabled boolean with no unknown fields.');
  }
  return { credentialStoreEnabled: object['credentialStoreEnabled'] };
}

/** Missing preferences are distinct from explicit opt-out. Errors never include file contents. */
export function readSecurityPreferences(dataDir: string): SecurityPreferences | undefined {
  let text: string;
  try {
    text = readFileSync(join(dataDir, 'security.json'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error('Could not read security.json security preferences.', { cause: error });
  }
  let value: unknown;
  try { value = JSON.parse(text); } catch {
    throw new Error('Invalid security.json: expected valid JSON security preferences.');
  }
  // Local 0.8.5 profiles may contain the withdrawn database flag; validate, then ignore it.
  return validate(value, true);
}

/** Atomically replace preferences, with an exclusively created private temporary file. */
export function writeSecurityPreferences(dataDir: string, preferences: SecurityPreferences): void {
  const value = validate(preferences);
  const path = join(dataDir, 'security.json');
  const temporary = join(dataDir, `.security.${randomUUID()}.tmp`);
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  } catch {
    throw new Error('Could not write security.json security preferences.');
  } finally {
    try { unlinkSync(temporary); } catch { /* Renamed or not created. */ }
  }
}
