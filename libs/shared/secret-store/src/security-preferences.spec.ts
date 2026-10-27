import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readSecurityPreferences, writeSecurityPreferences } from './security-preferences';

const directories: string[] = [];
const scratch = () => { const dir = mkdtempSync(join(tmpdir(), 'pk-security-')); directories.push(dir); return dir; };
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('security preferences', () => {
  it('returns undefined only when missing and atomically persists only the credential-storage flag privately', () => {
    const dir = join(scratch(), 'nested');
    expect(readSecurityPreferences(dir)).toBeUndefined();
    const preferences = { credentialStoreEnabled: true };
    writeSecurityPreferences(dir, preferences);
    expect(readSecurityPreferences(dir)).toEqual(preferences);
    if (process.platform !== 'win32') expect(statSync(join(dir, 'security.json')).mode & 0o777).toBe(0o600);
    writeSecurityPreferences(dir, { credentialStoreEnabled: false });
    expect(JSON.parse(readFileSync(join(dir, 'security.json'), 'utf8'))).toEqual({ credentialStoreEnabled: false });
    expect(readdirSync(dir)).toEqual(['security.json']);
  });

  it.each(['not-json-private-value', 'null', '[]', '{}', '{"credentialStoreEnabled":true,"databaseEncryptionEnabled":"false"}', '{"credentialStoreEnabled":"secret-value","databaseEncryptionEnabled":false}', '{"credentialStoreEnabled":true,"databaseEncryptionEnabled":false,"secret":"secret-value"}'])('rejects invalid config without disclosing its contents: %s', (text) => {
    const dir = scratch();
    writeFileSync(join(dir, 'security.json'), text);
    expect(() => readSecurityPreferences(dir)).toThrow(/Invalid security.json/);
    try { readSecurityPreferences(dir); } catch (error) { expect((error as Error).message).not.toContain('secret-value'); }
  });

  it.each([true, false])('reads local 0.8.5 compatibility fields but ignores the database flag: %s', (legacy) => {
    const dir = scratch();
    writeFileSync(join(dir, 'security.json'), JSON.stringify({ credentialStoreEnabled: true, databaseEncryptionEnabled: legacy }));
    expect(readSecurityPreferences(dir)).toEqual({ credentialStoreEnabled: true });
    writeSecurityPreferences(dir, readSecurityPreferences(dir)!);
    expect(JSON.parse(readFileSync(join(dir, 'security.json'), 'utf8'))).toEqual({ credentialStoreEnabled: true });
  });

  it('validates writes before replacing existing preferences', () => {
    const dir = scratch();
    const preferences = { credentialStoreEnabled: false };
    writeSecurityPreferences(dir, preferences);
    expect(() => writeSecurityPreferences(dir, { ...preferences, secret: 'never persist' } as typeof preferences)).toThrow(/Invalid security.json/);
    expect(() => writeSecurityPreferences(dir, { ...preferences, databaseEncryptionEnabled: false } as typeof preferences)).toThrow(/Invalid security.json/);
    expect(readSecurityPreferences(dir)).toEqual(preferences);
    expect(readdirSync(dir)).toEqual(['security.json']);
  });
});
