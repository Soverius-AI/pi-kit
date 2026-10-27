import { mkdtempSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemorySecretStore } from '@pi-kit/secret-store';
import { describe, expect, it } from 'vitest';
import { plaintextCredentialFile } from './plaintext-credentials';

function world() {
  const path = join(mkdtempSync(join(tmpdir(), 'pk-plaintext-')), 'config.json');
  const store = new MemorySecretStore();
  store.set('litellm', 'fixture-key');
  store.set('connector-github', 'fixture-token');
  return { path, store };
}

describe('plaintext credential export', () => {
  it('exports exact resolver and bearer forms, preserving arbitrary commands and environment references', async () => {
    const { path, store } = world();
    writeFileSync(path, JSON.stringify({
      a: '!pi-kit-secret get litellm',
      b: '!security find-generic-password -s pi-kit -a litellm -w',
      c: '!secret-tool lookup service pi-kit username litellm',
      d: '!pi-kit-secret get connector-github --bearer',
      e: '!echo Bearer $(security find-generic-password -s pi-kit -a connector-github -w)',
      f: '!echo Bearer $(secret-tool lookup service pi-kit username connector-github)',
      custom: '!echo custom-command', env: '${API_KEY}', internal: '!pi-kit-secret get pi-kit/db',
    }));
    const result = await plaintextCredentialFile(path, store);
    expect(result.failed).toEqual([]);
    expect(result.moved).toHaveLength(6);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      a: 'fixture-key', b: 'fixture-key', c: 'fixture-key', d: 'Bearer fixture-token',
      e: 'Bearer fixture-token', f: 'Bearer fixture-token', custom: '!echo custom-command',
      env: '${API_KEY}', internal: '!pi-kit-secret get pi-kit/db',
    });
    expect(JSON.stringify(result)).not.toContain('fixture-key');
  });

  it('only converts API-key fields in auth.json, preserving OAuth and unknown properties', async () => {
    const { path, store } = world();
    const oauth = { type: 'oauth', access: '!pi-kit-secret get litellm' };
    writeFileSync(path, JSON.stringify({ litellm: { type: 'api_key', key: '!pi-kit-secret get litellm', extra: true }, oauth }));
    await plaintextCredentialFile(path, store, true);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ litellm: { type: 'api_key', key: 'fixture-key', extra: true }, oauth });
  });

  it('refuses malformed or symlinked files and leaves originals intact', async () => {
    const { path, store } = world();
    writeFileSync(path, '{broken');
    await expect(plaintextCredentialFile(path, store)).rejects.toThrow();
    expect(readFileSync(path, 'utf8')).toBe('{broken');
    symlinkSync(path, `${path}.link`);
    await expect(plaintextCredentialFile(`${path}.link`, store)).rejects.toThrow();
  });
});
