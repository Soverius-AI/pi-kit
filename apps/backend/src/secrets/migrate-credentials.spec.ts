import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MemorySecretStore } from '@pi-kit/secret-store';
import { migrateCredentialFile, migrateResolvers } from './migrate-credentials';

const file = () => join(mkdtempSync(join(tmpdir(), 'pk-migrate-')), 'auth.json');

describe('credential configuration migration', () => {
  it('rewrites exact provider, MCP header, environment and bearer resolvers, preserving arbitrary commands', () => {
    expect(migrateResolvers({
      key: '!security find-generic-password -s pi-kit -a openrouter -w',
      headers: { Authorization: '!echo Bearer $(security find-generic-password -s pi-kit -a connector-github -w)' },
      env: { TOKEN: '!security find-generic-password -s pi-kit -a mcp-files-env-TOKEN -w' },
      custom: '!security find-generic-password -s other-app -w',
      shell: '!security find-generic-password -s pi-kit -a openrouter -w; echo custom',
    })).toEqual({
      key: '!pi-kit-secret get openrouter',
      headers: { Authorization: '!pi-kit-secret get connector-github --bearer' },
      env: { TOKEN: '!pi-kit-secret get mcp-files-env-TOKEN' },
      custom: '!security find-generic-password -s other-app -w',
      shell: '!security find-generic-password -s pi-kit -a openrouter -w; echo custom',
    });
  });

  it('verifies plaintext API keys before replacing auth.json, leaves OAuth and environment entries unchanged, and is repeatable', async () => {
    const path = file();
    const store = new MemorySecretStore();
    const oauth = { type: 'oauth', access: 'pi-owned-token', refresh: 'pi-owned-refresh' };
    writeFileSync(path, JSON.stringify({ openrouter: { type: 'api_key', key: 'fixture-literal-key' }, openai: oauth, groq: { type: 'api_key', key: 'GROQ_API_KEY' } }));
    await migrateCredentialFile(path, store, true);
    expect(store.get('openrouter')).toBe('fixture-literal-key');
    expect(readFileSync(path, 'utf8')).not.toContain('fixture-literal-key');
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ openrouter: { key: '!pi-kit-secret get openrouter' }, openai: oauth, groq: { key: 'GROQ_API_KEY' } });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const before = readFileSync(path, 'utf8');
    await migrateCredentialFile(path, store, true);
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it('retains the original file byte for byte if native verification fails', async () => {
    const path = file();
    const original = JSON.stringify({ openrouter: { type: 'api_key', key: 'fixture-key' } });
    writeFileSync(path, original);
    const store = new MemorySecretStore();
    store.get = () => undefined;
    await expect(migrateCredentialFile(path, store, true)).rejects.toThrow(/verified/);
    expect(readFileSync(path, 'utf8')).toBe(original);
  });

  it('does not overwrite a configuration edit made while native consent is pending', async () => {
    const path = file();
    writeFileSync(path, JSON.stringify({ openrouter: { type: 'api_key', key: 'fixture-key' } }));
    const store = new MemorySecretStore();
    const save = store.set.bind(store);
    store.set = (account, value) => { save(account, value); writeFileSync(path, '{"edited":true}'); };
    await expect(migrateCredentialFile(path, store, true)).rejects.toThrow(/changed during/);
    expect(readFileSync(path, 'utf8')).toBe('{"edited":true}');
    expect(store.get('openrouter')).toBe('fixture-key');
  });
});
