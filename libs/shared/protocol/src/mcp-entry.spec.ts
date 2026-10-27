import { describe, expect, it } from 'vitest';
import { type McpServerBody, bodyOfDetail, buildServerEntry, isStoredSecret, joinArgs, looksLikeSecret, previewEntry, secretAccount, serverDetailOf, splitArgs } from './mcp-entry';

/** A credential store that keeps nothing but a map and answers like the macOS one: the entry gets the command that prints the value. */
function fakeStore() {
  const kept = new Map<string, string>();
  return { kept, keep: (account: string, value: string): string => (kept.set(account, value), `!security find-generic-password -s pi-kit -a ${account} -w`) };
}

const command: McpServerBody = { name: 'playwright', kind: 'command', command: 'npx', args: ['@playwright/mcp@latest', '--headless'], env: [{ key: 'PLAYWRIGHT_BROWSERS_PATH', value: '~/.cache/ms-playwright' }], exposure: 'direct', description: '', enabled: true };
const url: McpServerBody = { name: 'docs-search', kind: 'url', url: 'https://docs.internal.example/mcp', headers: [{ key: 'Authorization', value: 'Bearer abcdefghijklmnop1234' }], exposure: 'deferred', description: 'Internal docs search', enabled: true };

describe('looksLikeSecret', () => {
  it('goes by the name', () => {
    for (const key of ['Authorization', 'X-Api-Key', 'GITHUB_TOKEN', 'DB_PASSWORD', 'apiKey', 'client_secret', 'AWS_ACCESS_KEY']) expect(looksLikeSecret(key, 'something-private'), key).toBe(true);
    for (const key of ['PLAYWRIGHT_BROWSERS_PATH', 'Content-Type', 'NODE_ENV', 'AUTHOR_NAME', 'TOKENIZER_PATH']) expect(looksLikeSecret(key, 'plain value'), key).toBe(false);
  });
  it('goes by the shape of the value', () => {
    expect(looksLikeSecret('CUSTOM', 'ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789')).toBe(true);
    expect(looksLikeSecret('CUSTOM', 'Bearer abcdefghijklmnopqrstuvwx')).toBe(true);
  });
  it('never keeps a reference or a command, or nothing', () => {
    expect(looksLikeSecret('Authorization', 'Bearer ${DOCS_TOKEN}')).toBe(false);
    expect(looksLikeSecret('GITHUB_TOKEN', '$GITHUB_TOKEN')).toBe(false);
    expect(looksLikeSecret('TOKEN', '!gh auth token')).toBe(false);
    expect(looksLikeSecret('TOKEN', '  ')).toBe(false);
  });
  it('knows its own commands', () => {
    expect(isStoredSecret('!security find-generic-password -s pi-kit -a mcp-x-env-TOKEN -w')).toBe(true);
    expect(isStoredSecret('!pi-kit-secret get mcp-x-env-TOKEN')).toBe(true);
    expect(isStoredSecret('!gh auth token')).toBe(false);
  });
});

describe('buildServerEntry', () => {
  it("writes a command server with arguments and environment, in pi's order, and no defaults", () => {
    const { entry, stored } = buildServerEntry(command, undefined, fakeStore().keep);
    expect(entry).toEqual({ command: 'npx', args: ['@playwright/mcp@latest', '--headless'], env: { PLAYWRIGHT_BROWSERS_PATH: '~/.cache/ms-playwright' }, exposure: 'direct' });
    expect(Object.keys(entry)).toEqual(['command', 'args', 'env', 'exposure']);
    expect(stored).toEqual([]);
  });

  it('writes a URL server with headers, a description and the exposure; codemode and enabled are left out', () => {
    const store = fakeStore();
    const { entry, stored } = buildServerEntry(url, undefined, store.keep);
    expect(entry).toEqual({
      url: 'https://docs.internal.example/mcp',
      headers: { Authorization: '!security find-generic-password -s pi-kit -a mcp-docs-search-header-Authorization -w' },
      description: 'Internal docs search',
      exposure: 'deferred',
    });
    expect(stored).toEqual(['mcp-docs-search-header-Authorization']);
    expect(store.kept.get('mcp-docs-search-header-Authorization')).toBe('Bearer abcdefghijklmnop1234');
    const off = buildServerEntry({ ...url, exposure: 'codemode', enabled: false, headers: [] }, undefined, store.keep).entry;
    expect(off).toEqual({ url: 'https://docs.internal.example/mcp', description: 'Internal docs search', enabled: false });
  });

  it('puts an environment secret in the store and writes the command, never the value', () => {
    const store = fakeStore();
    const { entry, stored } = buildServerEntry(
      { ...command, env: [{ key: 'API_KEY', value: 'plain-looking-value' }, { key: 'COLOR', value: 'blue', secret: true }, { key: 'HOME_DIR', value: '/tmp' }] },
      undefined,
      store.keep,
    );
    expect(entry['env']).toEqual({
      API_KEY: '!security find-generic-password -s pi-kit -a mcp-playwright-env-API_KEY -w',
      COLOR: '!security find-generic-password -s pi-kit -a mcp-playwright-env-COLOR -w',
      HOME_DIR: '/tmp',
    });
    expect(stored).toEqual(['mcp-playwright-env-API_KEY', 'mcp-playwright-env-COLOR']);
    expect(JSON.stringify(entry)).not.toContain('plain-looking-value');
  });

  it('writes the value as it is when there is no store, and says which', () => {
    const { entry, plain } = buildServerEntry(url, undefined, () => undefined);
    expect(entry['headers']).toEqual({ Authorization: 'Bearer abcdefghijklmnop1234' });
    expect(plain).toEqual(['Authorization']);
  });

  it('leaves a reference, a command and an already stored secret alone', () => {
    const store = fakeStore();
    const { entry } = buildServerEntry(
      { ...url, headers: [{ key: 'Authorization', value: 'Bearer ${DOCS_TOKEN}' }, { key: 'X-Api-Key', value: '!gh auth token' }, { key: 'X-Token', value: '!pi-kit-secret get mcp-x-header-X-Token' }] },
      undefined,
      store.keep,
    );
    expect(entry['headers']).toEqual({ Authorization: 'Bearer ${DOCS_TOKEN}', 'X-Api-Key': '!gh auth token', 'X-Token': '!pi-kit-secret get mcp-x-header-X-Token' });
    expect(store.kept.size).toBe(0);
  });

  it("keeps what the form does not own, the order of the keys, and the file's value of a row without one", () => {
    const existing = { timeout: 120, url: 'https://old.example/mcp', oauth: { clientName: 'Claude Code' }, headers: { 'X-Api-Key': '!pi-kit-secret get mcp-docs-search-header-X-Api-Key', Old: 'x' }, exposure: 'direct', type: 'http' };
    const { entry } = buildServerEntry({ ...url, headers: [{ key: 'X-Api-Key' }, { key: 'X-Team', value: 'core' }], description: '' }, existing, fakeStore().keep);
    expect(Object.keys(entry)).toEqual(['timeout', 'url', 'oauth', 'headers', 'exposure', 'type']);
    expect(entry).toMatchObject({ timeout: 120, oauth: { clientName: 'Claude Code' }, url: 'https://docs.internal.example/mcp', exposure: 'deferred', type: 'http' });
    expect(entry['headers']).toEqual({ 'X-Api-Key': '!pi-kit-secret get mcp-docs-search-header-X-Api-Key', 'X-Team': 'core' });
  });

  it('drops a type that no longer fits and the keys of the other kind', () => {
    const existing = { command: 'npx', args: ['x'], env: { A: '1' }, type: 'stdio' };
    const { entry } = buildServerEntry(url, existing, fakeStore().keep);
    expect(entry).not.toHaveProperty('command');
    expect(entry).not.toHaveProperty('args');
    expect(entry).not.toHaveProperty('type');
  });
});

describe('the form <-> entry round trip', () => {
  it('reads a command entry back into the same form', () => {
    const { entry } = buildServerEntry(command, undefined, fakeStore().keep);
    const detail = serverDetailOf('playwright', 'user', '/x/mcp.json', entry);
    expect(detail).toMatchObject({ kind: 'command', command: 'npx', args: ['@playwright/mcp@latest', '--headless'], env: [{ key: 'PLAYWRIGHT_BROWSERS_PATH', value: '~/.cache/ms-playwright' }], exposure: 'direct', description: '', enabled: true, kept: [], oauth: false });
    expect(bodyOfDetail(detail)).toEqual(command);
  });

  it('reads a URL entry back: a stored secret has no value, only stored', () => {
    const { entry } = buildServerEntry(url, undefined, fakeStore().keep);
    const detail = serverDetailOf('docs-search', 'project', '/p/.pi/mcp.json', entry);
    expect(detail.headers).toEqual([{ key: 'Authorization', stored: true }]);
    expect(JSON.stringify(detail)).not.toContain('abcdefghijklmnop1234');
    expect(detail).toMatchObject({ kind: 'url', url: 'https://docs.internal.example/mcp', exposure: 'deferred', description: 'Internal docs search', scope: 'project', oauth: false });
    // saving the form without touching the row keeps the stored command and writes the same entry
    const again = buildServerEntry(bodyOfDetail(detail), entry, fakeStore().keep).entry;
    expect(again).toEqual(entry);
  });

  it('every field survives a round trip, for both kinds', () => {
    const forms: McpServerBody[] = [command, url, { ...command, enabled: false, description: 'Browser', exposure: 'hidden' }, { ...url, headers: [{ key: 'X-Team', value: 'core' }], exposure: 'codemode', enabled: false }];
    for (const form of forms) {
      const first = buildServerEntry(form, undefined, fakeStore().keep);
      const second = buildServerEntry(bodyOfDetail(serverDetailOf(form.name, 'user', 'p', first.entry)), first.entry, fakeStore().keep);
      expect(second.entry).toEqual(first.entry);
    }
  });

  it('a URL server without an Authorization header signs in with OAuth', () => {
    expect(serverDetailOf('linear', 'user', 'p', { url: 'https://mcp.linear.app/mcp' }).oauth).toBe(true);
    expect(serverDetailOf('x', 'user', 'p', { url: 'https://x/mcp', headers: { authorization: 'x' } }).oauth).toBe(false);
  });

  it('lists the keys the form leaves alone', () => {
    expect(serverDetailOf('x', 'user', 'p', { url: 'https://x/mcp', oauth: {}, timeout: 5, toolExposure: {} }).kept).toEqual(['oauth', 'timeout', 'toolExposure']);
  });
});

describe('the preview', () => {
  it('shows the command that prints a secret and never the value', () => {
    const entry = previewEntry(url, undefined);
    expect(entry['headers']).toEqual({ Authorization: '!pi-kit-secret get mcp-docs-search-header-Authorization' });
    expect(JSON.stringify(entry)).not.toContain('abcdefghijklmnop1234');
  });
});

describe('arguments on one line', () => {
  it('splits on spaces and lets quotes keep one together, and joins back', () => {
    expect(splitArgs('@playwright/mcp@latest --headless "a b" \'c d\'')).toEqual(['@playwright/mcp@latest', '--headless', 'a b', 'c d']);
    const args = ['-y', 'with space', "it's", 'say "hi"'];
    expect(splitArgs(joinArgs(args))).toEqual(args);
  });
});

describe('secretAccount', () => {
  it('is a name the keychain and a shell word can carry', () => {
    expect(secretAccount('docs-search', 'header', 'X-Api-Key')).toBe('mcp-docs-search-header-X-Api-Key');
    const long = secretAccount('s'.repeat(40), 'env', 'K'.repeat(80));
    expect(long.length).toBeLessThanOrEqual(64);
    expect(long).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
    expect(secretAccount('a', 'env', 'ä ö')).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
  });
});
