import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { isProviderAccount, keyStorageOf, parseResolver } from '@pi-kit/protocol';
import type { SecretStore } from '@pi-kit/secret-store';

function helper(value: string): string {
  const direct = parseResolver(value);
  if (direct?.via === 'security') return `!pi-kit-secret get ${direct.provider}`;
  const bearer = /^!echo Bearer \$\((security find-generic-password -s pi-kit -a [A-Za-z0-9._-]+ -w)\)$/.exec(value);
  const parsed = bearer && parseResolver(`!${bearer[1]}`);
  return parsed ? `!pi-kit-secret get ${parsed.provider} --bearer` : value;
}

/** Only pi-kit's exact legacy resolvers change; arbitrary shell commands are left alone. */
export function migrateResolvers(value: unknown): unknown {
  if (typeof value === 'string') return helper(value);
  if (Array.isArray(value)) return value.map(migrateResolvers);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, migrateResolvers(item)]));
  return value;
}

/** Verify native writes before atomically replacing config; a concurrent editor's changes win. */
export async function migrateCredentialFile(path: string, store: SecretStore, auth = false): Promise<void> {
  if (!existsSync(path)) return;
  if (lstatSync(path).isSymbolicLink()) throw new Error('Credential migration requires a regular configuration file; the original was retained.');
  const original = readFileSync(path, 'utf8');
  let parsed: unknown;
  try { parsed = JSON.parse(original) as unknown; }
  catch { throw new Error('The credential configuration is invalid JSON. The original was retained.'); }
  if (auth && parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    for (const [account, entry] of Object.entries(parsed)) {
      if (!isProviderAccount(account) || !entry || typeof entry !== 'object') continue;
      const credential = entry as { type?: string; key?: string };
      if (credential.type !== 'api_key' || typeof credential.key !== 'string' || keyStorageOf(credential.key) !== 'auth.json') continue;
      const value = credential.key;
      if (store.migrateValue) await store.migrateValue(account, value);
      else {
        const existing = await store.get(account);
        if (existing === undefined) await store.set(account, value);
        else if (existing !== value) throw new Error('An existing credential differs. The original configuration was retained.');
        if (await store.get(account) !== value) throw new Error('Credential migration could not be verified. The original configuration was retained.');
      }
      credential.key = `!pi-kit-secret get ${account}`;
    }
  }
  const next = `${JSON.stringify(migrateResolvers(parsed), null, 2)}\n`;
  if (next === original) return;
  const temporary = `${path}.touch-id-${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, next, { mode: 0o600, flag: 'wx' });
    if (readFileSync(path, 'utf8') !== original) throw new Error('The configuration changed during credential migration. Retry after saving it.');
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}
