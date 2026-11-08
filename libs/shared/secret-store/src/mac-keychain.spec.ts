import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DB_KEY_ACCOUNT } from '@pi-kit/protocol';
import { MacKeychainSecretStore, type MacKeychainModule } from './mac-keychain';
import { MemorySecretStore } from './store';

function world() {
  const agent = mkdtempSync(join(tmpdir(), 'pk-biometric-'));
  const legacy = new MemorySecretStore();
  const data = new Map<string, string>();
  const get = vi.fn(async (account: string) => data.get(account) ?? null);
  const ensure = vi.fn(async (account: string, value: string) => {
    if (!data.has(account)) data.set(account, value);
    return data.get(account) as string;
  });
  const set = vi.fn(async (account: string, value: string) => {
    data.set(account, value);
  });
  const remove = vi.fn(async (account: string) => data.delete(account));
  const status = vi.fn(async (account: string) => ({
    status: data.has(account) ? 'requires-authentication' : 'missing',
  }));
  const open = vi.fn(() => ({ get, getOrCreate: ensure, set, remove, status }));
  const load = vi.fn((): MacKeychainModule => ({ openKeychainStore: open }));
  const store = new MacKeychainSecretStore({ PI_CODING_AGENT_DIR: agent }, legacy, load);
  return { agent, store, legacy, data, get, ensure, set, remove, status, open, load };
}

describe('Touch ID Keychain storage', () => {
  it('reports native capability without touching credentials, and uses persistent user-presence access control', async () => {
    const w = world();
    expect(w.store.available()).toBe(true);
    expect(w.store.accessStatus()).toEqual({ state: 'unknown' });
    expect(w.open).not.toHaveBeenCalled();
    await w.store.set('openrouter', 'fixture-key');
    expect(w.open).toHaveBeenCalledWith({
      keychainService: 'dev.pi-kit.app',
      authentication: { accessControl: 'user-presence' },
      iCloudSync: false,
      mutableAccounts: ['openrouter'],
    });
    expect(readFileSync(join(w.agent, 'pi-kit-keychain-accounts.jsonl'), 'utf8')).not.toContain('fixture-key');
  });

  it('copies and verifies the database key and provider/connector secrets, retaining every original', async () => {
    const w = world();
    for (const [account, value] of [
      [DB_KEY_ACCOUNT, 'a'.repeat(64)],
      ['openrouter', 'fixture-provider'],
      ['connector-github', 'fixture-connector'],
    ])
      w.legacy.set(account, value);
    await w.store.migrate();
    expect([...w.data].sort()).toEqual(
      w.legacy
        .list()
        .map((account) => [account, w.legacy.get(account)])
        .sort(),
    );
    expect(w.get).toHaveBeenCalledTimes(3);
    w.get.mockClear();
    await w.store.migrate();
    expect(w.get).not.toHaveBeenCalled(); // Relaunch migration checks presence, not secret values.
  });

  it('never falls back to a legacy secret after cancelled modern authentication and retries only explicitly', async () => {
    const w = world();
    w.legacy.set('openrouter', 'old-key');
    w.data.set('openrouter', 'new-key');
    const oldRead = vi.spyOn(w.legacy, 'get');
    w.get.mockRejectedValueOnce(
      Object.assign(new Error('Could not read Keychain item'), {
        code: 'item_read_failed',
        details: { osStatus: -128 },
      }),
    );
    await expect(w.store.get('openrouter')).rejects.toMatchObject({ access: { state: 'denied' } });
    await expect(w.store.get('openrouter')).rejects.toThrow();
    expect(w.get).toHaveBeenCalledTimes(1);
    expect(oldRead).not.toHaveBeenCalled();
    w.store.retryAccess();
    expect(await w.store.get('openrouter')).toBe('new-key');
  });

  it('does not overwrite a concurrent modern entry or remove the legacy copy if verification fails', async () => {
    const w = world();
    w.legacy.set('anthropic', 'original-key');
    w.ensure.mockImplementationOnce(async () => 'another-writer-key');
    await expect(w.store.get('anthropic')).rejects.toThrow();
    expect(w.legacy.get('anthropic')).toBe('original-key');
    expect(w.set).not.toHaveBeenCalled();
    expect(w.store.accessStatus().reason).not.toContain('original-key');
  });

  it('does not replace a modern value when importing a conflicting literal credential', async () => {
    const w = world();
    w.data.set('openrouter', 'newer-modern-value');
    await expect(w.store.migrateValue('openrouter', 'older-plaintext-value')).rejects.toThrow();
    expect(w.data.get('openrouter')).toBe('newer-modern-value');
    expect(w.set).not.toHaveBeenCalled();
  });

  it('removes both stores on logout so a legacy backup cannot resurrect the credential', async () => {
    const w = world();
    w.legacy.set('openrouter', 'old-key');
    await w.store.get('openrouter');
    expect(await w.store.delete('openrouter')).toBe(true);
    expect(await w.store.get('openrouter')).toBeUndefined();
    expect(await w.store.list()).toEqual([]);
  });

  it('validates signing before reading legacy credentials', async () => {
    const w = world();
    const oldList = vi.spyOn(w.legacy, 'list');
    w.status.mockRejectedValueOnce(Object.assign(new Error('Invalid host'), { code: 'host_identity_invalid' }));
    await expect(w.store.migrate()).rejects.toMatchObject({
      access: { state: 'unavailable', reason: expect.stringContaining('Apple-signed') },
    });
    expect(oldList).not.toHaveBeenCalled();
  });

  it('serializes native operations so concurrent callers cannot stack consent dialogs', async () => {
    const w = world();
    let finish!: () => void;
    w.set.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const first = w.store.set('openrouter', 'one');
    const second = w.store.set('anthropic', 'two');
    await vi.waitFor(() => expect(w.set).toHaveBeenCalledTimes(1));
    finish();
    await Promise.all([first, second]);
    expect(w.set).toHaveBeenCalledTimes(2);
  });
});

/** A Keychain that keeps Touch ID items and items without Touch ID apart, and counts the reads that would ask for Touch ID. */
function keychain() {
  const agent = mkdtempSync(join(tmpdir(), 'pk-unattended-'));
  const items = new Map<string, string>();
  const touchIdReads: string[] = [];
  let refuse: string | undefined;
  const open = (options: { authentication: unknown }) => {
    const kind = options.authentication === 'none' ? 'plain' : 'touch';
    return {
      status: async (account: string) => ({ status: items.has(`${kind}:${account}`) ? 'available' : 'missing' }),
      get: async (account: string) => {
        if (kind === 'touch') {
          touchIdReads.push(account);
          if (account === refuse) throw Object.assign(new Error('User canceled'), { code: 'user_canceled' });
        }
        return items.get(`${kind}:${account}`) ?? null;
      },
      getOrCreate: async (account: string, value: string) => {
        if (!items.has(`${kind}:${account}`)) items.set(`${kind}:${account}`, value);
        return items.get(`${kind}:${account}`) as string;
      },
      set: async (account: string, value: string) => void items.set(`${kind}:${account}`, value),
      remove: async (account: string) => items.delete(`${kind}:${account}`),
    };
  };
  const store = new MacKeychainSecretStore({ PI_CODING_AGENT_DIR: agent }, new MemorySecretStore(), () => ({
    openKeychainStore: open,
  }));
  return { store, items, touchIdReads, refuseOn: (account: string) => (refuse = account) };
}

describe('keys readable while you are away', () => {
  it('copies every key, then reads them without Touch ID; switching off removes only the copies', async () => {
    const k = keychain();
    await k.store.set(DB_KEY_ACCOUNT, 'd'.repeat(64));
    await k.store.set('anthropic', 'provider-key');

    await k.store.setUnattended(true);
    k.touchIdReads.length = 0;
    expect(await k.store.get(DB_KEY_ACCOUNT)).toBe('d'.repeat(64));
    expect(await k.store.get('anthropic')).toBe('provider-key');
    expect(k.touchIdReads).toEqual([]);

    await k.store.setUnattended(false);
    expect([...k.items.keys()].sort()).toEqual(['touch:anthropic', `touch:${DB_KEY_ACCOUNT}`]);
  });

  it('removes the copies already made when Touch ID is cancelled for a later key', async () => {
    const k = keychain();
    await k.store.set('openai', 'provider-key');
    await k.store.set(DB_KEY_ACCOUNT, 'd'.repeat(64));
    // Keys are copied in name order: openai first, then the database key, which is refused.
    k.refuseOn(DB_KEY_ACCOUNT);

    await expect(k.store.setUnattended(true)).rejects.toThrow();
    expect([...k.items.keys()].filter((key) => key.startsWith('plain:'))).toEqual([]);
    expect(k.store.unattendedKeys).toBe(false);
  });
});
