import { mkdtempSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileSecretStore, KeyringSecretStore, MemorySecretStore, NoSecretStore, osStoreLabel, selectSecretStore } from './store';

const scratch = (): string => realpathSync(mkdtempSync(join(tmpdir(), 'pk-secrets-')));

/** The surface of `@napi-rs/keyring` this package uses, backed by a map, so no test reaches a real keychain. */
function fakeKeyring(options: { failOn?: 'set' | 'load' } = {}) {
  const data = new Map<string, string>();
  const calls: { service: string; account: string; linux?: string }[] = [];
  return {
    data,
    calls,
    load: () => {
      if (options.failOn === 'load') throw new Error('no native binding');
      return {
        Entry: class {
          constructor(
            private readonly service: string,
            private readonly account: string,
            opts?: { linux?: { store?: string } },
          ) {
            calls.push({ service, account, ...(opts?.linux?.store ? { linux: opts.linux.store } : {}) });
          }
          getPassword() {
            return data.get(`${this.service}/${this.account}`) ?? null;
          }
          setPassword(value: string) {
            if (options.failOn === 'set') throw new Error('The keychain is locked');
            data.set(`${this.service}/${this.account}`, value);
          }
          deletePassword() {
            return data.delete(`${this.service}/${this.account}`);
          }
        },
        findCredentials: (service: string) => [...data.keys()].filter((k) => k.startsWith(`${service}/`)).map((k) => ({ account: k.slice(service.length + 1) })),
      };
    },
  };
}

describe('the operating system store', () => {
  it('names itself for the platform', () => {
    expect(osStoreLabel('darwin')).toBe('macOS Keychain');
    expect(osStoreLabel('win32')).toBe('Windows Credential Manager');
    expect(osStoreLabel('linux')).toBe('Secret Service (libsecret)');
  });

  it('keeps one entry per account under the service pi-kit, and lists accounts only', () => {
    const keyring = fakeKeyring();
    const store = new KeyringSecretStore(keyring.load, 'darwin');
    expect(store.available()).toBe(true);
    store.set('openrouter', 'sk-or-secret');
    store.set('anthropic', 'sk-ant-secret');
    expect(store.get('openrouter')).toBe('sk-or-secret');
    expect(store.get('nobody')).toBeUndefined();
    expect(store.list()).toEqual(['anthropic', 'openrouter']);
    expect(store.delete('openrouter')).toBe(true);
    expect(store.delete('openrouter')).toBe(false);
    expect(keyring.calls.every((c) => c.service === 'pi-kit')).toBe(true);
  });

  it('checks native capability without reading, writing or deleting credentials', () => {
    const keyring = fakeKeyring();
    const store = new KeyringSecretStore(keyring.load, 'darwin');
    expect(store.available()).toBe(true);
    expect(store.available()).toBe(true);
    expect(keyring.calls).toEqual([]);
    expect([...keyring.data.keys()]).toEqual([]);
  });

  it('pins the entries to the Secret Service on Linux, because secret-tool cannot see the kernel keyring fallback', () => {
    const keyring = fakeKeyring();
    new KeyringSecretStore(keyring.load, 'linux').set('openrouter', 'x');
    expect(keyring.calls.at(-1)).toEqual({ service: 'pi-kit', account: 'openrouter', linux: 'secret-service' });
    const mac = fakeKeyring();
    new KeyringSecretStore(mac.load, 'darwin').set('openrouter', 'x');
    expect(mac.calls.at(-1)).not.toHaveProperty('linux');
  });

  it('separates a missing native module from a locked credential store', () => {
    expect(new KeyringSecretStore(fakeKeyring({ failOn: 'load' }).load, 'linux').available()).toBe(false);
    expect(new KeyringSecretStore(fakeKeyring({ failOn: 'set' }).load, 'linux').available()).toBe(true);
    expect(() => new KeyringSecretStore(fakeKeyring({ failOn: 'load' }).load, 'linux').get('x')).toThrow(/not available/);
  });

  it('does not retry a failed account until requested, without blocking other accounts or caching successful secrets', () => {
    const options: { failOn?: 'set' | 'load' } = { failOn: 'set' };
    const keyring = fakeKeyring(options);
    const store = new KeyringSecretStore(keyring.load, 'darwin');
    expect(() => store.set('openrouter', 'value')).toThrow(/locked/);
    const calls = keyring.calls.length;
    options.failOn = undefined;
    expect(() => store.get('openrouter')).toThrow(/locked/);
    expect(() => store.set('openrouter', 'retry')).toThrow(/locked/);
    expect(keyring.calls).toHaveLength(calls);
    store.set('anthropic', 'first');
    expect(store.get('anthropic')).toBe('first');
    keyring.data.set('pi-kit/anthropic', 'changed by CLI');
    expect(store.get('anthropic')).toBe('changed by CLI');
    expect(store.accessStatus().state).toBe('locked');
    store.retryAccess();
    expect(keyring.calls).toHaveLength(calls + 3);
    expect(store.accessStatus().state).toBe('unknown');
    store.set('openrouter', 'retry');
    expect(store.get('openrouter')).toBe('retry');
    expect(store.accessStatus().state).toBe('ready');
  });
});

describe('the scratch stores', () => {
  it('a file store keeps JSON at mode 0600, shares entries between instances (two processes) and replaces the file atomically', () => {
    const path = join(scratch(), 'nested', 'secrets.json');
    const a = new FileSecretStore(path);
    a.set('openrouter', 'sk-or-1');
    const b = new FileSecretStore(path);
    expect(b.get('openrouter')).toBe('sk-or-1');
    b.set('groq', 'gsk_2');
    expect(a.list()).toEqual(['groq', 'openrouter']);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ openrouter: 'sk-or-1', groq: 'gsk_2' });
    expect(a.delete('groq')).toBe(true);
    expect(a.delete('groq')).toBe(false);
  });

  it('a memory store and the empty store behave', () => {
    const memory = new MemorySecretStore();
    memory.set('a', '1');
    expect(memory.get('a')).toBe('1');
    expect(memory.list()).toEqual(['a']);
    const none = new NoSecretStore();
    expect(none.available()).toBe(false);
    expect(none.get()).toBeUndefined();
    expect(() => none.set()).toThrow(/no credential store/);
  });
});

describe('which store a process uses', () => {
  it('follows PI_KIT_SECRET_STORE, so no test reaches a real keychain', () => {
    expect(selectSecretStore({ PI_KIT_SECRET_STORE: 'memory' }, true).kind).toBe('memory');
    expect(selectSecretStore({ PI_KIT_SECRET_STORE: 'none' }, true).kind).toBe('none');
    const path = join(scratch(), 's.json');
    const file = selectSecretStore({ PI_KIT_SECRET_STORE: `file:${path}` }, true);
    expect(file.kind).toBe('file');
    file.set('x', 'y');
    expect(new FileSecretStore(path).get('x')).toBe('y');
  });

  it('keeps the choice for one setting and makes a new one for another', () => {
    const first = selectSecretStore({ PI_KIT_SECRET_STORE: 'memory' }, true);
    expect(selectSecretStore({ PI_KIT_SECRET_STORE: 'memory' })).toBe(first);
    expect(selectSecretStore({ PI_KIT_SECRET_STORE: 'none' })).not.toBe(first);
  });
});
