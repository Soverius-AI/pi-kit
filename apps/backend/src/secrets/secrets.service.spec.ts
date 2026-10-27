import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { FileSecretStore, MemorySecretStore, NoSecretStore, selectSecretStore, readSecurityPreferences, writeSecurityPreferences, type SecretStore } from '@pi-kit/secret-store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SecretsService } from './secrets.service';

// Never select a real native store in this service suite, including explicit export tests.
vi.mock('@pi-kit/secret-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@pi-kit/secret-store')>();
  return { ...actual, selectSecretStore: vi.fn() };
});

const scratch = (): string => realpathSync(mkdtempSync(join(tmpdir(), 'pk-secsvc-')));

/** The environment the service reads, put back after each test. */
const saved: Record<string, string | undefined> = {};
const setEnv = (name: string, value: string | undefined): void => {
  if (!(name in saved)) saved[name] = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
};
const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform') as PropertyDescriptor;
const asPlatform = (platform: NodeJS.Platform): void => void Object.defineProperty(process, 'platform', { value: platform });

function make(store: SecretStore, dataDir = scratch()) {
  const shown = false;
  const settings = new Map<string, unknown>();
  const database = { protection: { state: 'encrypted', path: join(dataDir, 'pi-kit.sqlite') }, recoveryKey: () => 'a'.repeat(64) };
  const meta = { getSetting: (k: string) => settings.get(k), setSetting: (k: string, v: unknown) => void settings.set(k, v) };
  void shown;
  return { service: new SecretsService(store, { dataDir }, database as never, meta as never), dataDir, settings, database, meta };
}

/** A built CLI bundle for `PI_KIT_SECRET_CLI`. */
function fakeBundle(): string {
  const file = join(scratch(), 'pi-kit-secret.cjs');
  writeFileSync(file, '// the bundle\n');
  return file;
}

describe('SecretsService', () => {
  beforeEach(() => {
    vi.mocked(selectSecretStore).mockReset().mockImplementation(() => { throw new Error('Unexpected native store selection in test'); });
    // Installed helpers on the developer's machine must not affect discovery assertions.
    setEnv('PI_KIT_SECRET_STORE', undefined);
    setEnv('PATH', scratch());
    setEnv('PI_KIT_SECRET_CLI', fakeBundle());
    setEnv('PI_KIT_BIN_DIR', join(scratch(), 'bin-installed'));
    setEnv('PI_CODING_AGENT_DIR', scratch());
  });
  afterEach(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    Object.defineProperty(process, 'platform', realPlatform);
  });

  it('a fresh macOS profile stays disabled without any credential-store calls during status, startup, or new logins', async () => {
    asPlatform('darwin');
    setEnv('PI_KIT_SECRET_STORE', undefined);
    const store = new NoSecretStore();
    const calls = ['available', 'get', 'set', 'delete'].map((method) => vi.spyOn(store, method as 'get'));
    const accessStatus = vi.fn(() => ({ state: 'ready' as const }));
    Object.assign(store, { accessStatus });
    const { service, database } = make(store);
    database.protection.state = 'plain';
    expect(service.status()).toMatchObject({ store: 'none', credentialsEnabled: false, available: false, access: { state: 'unavailable' }, movable: [] });
    const launcher = vi.spyOn(service, 'ensureLauncher');
    await service.onModuleInit();
    expect(launcher).not.toHaveBeenCalled();
    await service.forget('openrouter');
    expect(await service.keep('openrouter', 'new-api-key')).toEqual({ value: 'new-api-key', storage: 'auth.json' });
    expect(await service.keepBearer('connector-github', 'new-token')).toEqual({ value: 'Bearer new-token', storage: 'mcp.json' });
    expect(service.databaseProtection()).toMatchObject({ state: 'plain' });
    for (const call of calls) expect(call).not.toHaveBeenCalled();
    expect(accessStatus).not.toHaveBeenCalled();
  });

  it.each(['auth.json', 'models.json', 'mcp.json'])('prepares a pinned macOS launcher for retained helper references in %s without probing a store', async (name) => {
    asPlatform('darwin');
    const store = new NoSecretStore();
    const calls = ['available', 'get', 'set', 'delete'].map((method) => vi.spyOn(store, method as 'get'));
    const accessStatus = vi.fn(() => ({ state: 'ready' as const }));
    Object.assign(store, { accessStatus });
    const { service, dataDir } = make(store);
    const file = join(process.env['PI_CODING_AGENT_DIR']!, name);
    const original = JSON.stringify(name === 'auth.json'
      ? { openrouter: { type: 'api_key', key: '!pi-kit-secret get openrouter' } }
      : name === 'models.json'
        ? { providers: { litellm: { apiKey: '!pi-kit-secret get litellm' } } }
        : { mcpServers: { github: { headers: { Authorization: '!pi-kit-secret get connector-github --bearer' } } } });
    writeFileSync(file, original);
    expect(service.credentialsEnabled()).toBe(false);
    await service.onModuleInit();
    const launcher = join(dataDir, 'bin', 'pi-kit-secret');
    expect(readFileSync(launcher, 'utf8')).toContain("PI_KIT_SECRET_STORE='macos'");
    expect(process.env['PATH']!.split(delimiter)[0]).toBe(join(dataDir, 'bin'));
    expect(readFileSync(file, 'utf8')).toBe(original);
    expect(service.status()).toMatchObject({ credentialsEnabled: false, available: false });
    expect(await service.keep('openrouter', 'new-direct-key')).toEqual({ value: 'new-direct-key', storage: 'auth.json' });
    await service.forget('openrouter');
    for (const call of calls) expect(call).not.toHaveBeenCalled();
    expect(accessStatus).not.toHaveBeenCalled();
    expect(selectSecretStore).not.toHaveBeenCalled();
  });

  it('explicit opt-out may select the original store only to export known references while new credentials remain disabled', async () => {
    asPlatform('darwin');
    const originalStore = new MemorySecretStore();
    originalStore.set('openrouter', 'retained-key');
    vi.mocked(selectSecretStore).mockReturnValue(originalStore);
    const { service, dataDir } = make(new NoSecretStore());
    const file = join(process.env['PI_CODING_AGENT_DIR']!, 'auth.json');
    writeFileSync(file, JSON.stringify({ openrouter: { type: 'api_key', key: '!pi-kit-secret get openrouter' } }));
    await service.onModuleInit();
    expect(selectSecretStore).not.toHaveBeenCalled();
    expect(await service.setCredentialStorage(false)).toEqual({ moved: ['openrouter'], failed: [] });
    expect(selectSecretStore).toHaveBeenCalledWith(expect.objectContaining({ PI_KIT_SECRET_STORE: 'macos' }));
    expect(JSON.parse(readFileSync(file, 'utf8')).openrouter.key).toBe('retained-key');
    expect(readSecurityPreferences(dataDir)?.credentialStoreEnabled).toBe(false);
    expect(service.store.kind).toBe('none');
    expect(originalStore.get('openrouter')).toBe('retained-key');
  });

  it('explicit none override prevents original native store selection even for a requested export', async () => {
    asPlatform('darwin');
    setEnv('PI_KIT_SECRET_STORE', 'none');
    const { service } = make(new NoSecretStore());
    const file = join(process.env['PI_CODING_AGENT_DIR']!, 'auth.json');
    const original = JSON.stringify({ openrouter: { type: 'api_key', key: '!pi-kit-secret get openrouter' } });
    writeFileSync(file, original);
    const result = await service.setCredentialStorage(false);
    expect(result.moved).toEqual([]);
    expect(result.failed).toEqual([expect.objectContaining({ provider: 'openrouter' })]);
    expect(readFileSync(file, 'utf8')).toBe(original);
    expect(selectSecretStore).not.toHaveBeenCalled();
  });

  it('explicit credential opt-in persists for next startup without accessing database keys', async () => {
    const store = new MemorySecretStore();
    const { service, dataDir, database } = make(store);
    database.protection.state = 'plain';
    writeSecurityPreferences(dataDir, { credentialStoreEnabled: false });
    const get = vi.spyOn(store, 'get');
    const set = vi.spyOn(store, 'set');
    expect(await service.setCredentialStorage(true)).toEqual({ moved: [], failed: [] });
    expect(readSecurityPreferences(dataDir)).toEqual({ credentialStoreEnabled: true });
    expect(statSync(join(dataDir, 'security.json')).mode & 0o777).toBe(0o600);
    expect(get).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
    // No SQLite metadata from the first service is needed to remember the choice.
    const next = make(store, dataDir).service;
    expect(next.credentialsEnabled()).toBe(true);
    expect(service.databaseProtection()).toMatchObject({ state: 'plain' });
  });

  it('startup never migrates existing plaintext credentials even after opting in', async () => {
    const store = new MemorySecretStore();
    const { service, dataDir } = make(store);
    const agent = process.env['PI_CODING_AGENT_DIR']!;
    const files = {
      'auth.json': JSON.stringify({ openrouter: { type: 'api_key', key: 'original-api-key' } }),
      'models.json': JSON.stringify({ providers: { litellm: { apiKey: 'original-model-key' } } }),
      'mcp.json': JSON.stringify({ mcpServers: { github: { headers: { Authorization: 'Bearer original-token' } } } }),
    };
    for (const [name, text] of Object.entries(files)) writeFileSync(join(agent, name), text);
    writeSecurityPreferences(dataDir, { credentialStoreEnabled: true });
    const calls = ['get', 'set', 'delete'].map((method) => vi.spyOn(store, method as 'get'));
    await service.onModuleInit();
    for (const [name, text] of Object.entries(files)) expect(readFileSync(join(agent, name), 'utf8')).toBe(text);
    for (const call of calls) expect(call).not.toHaveBeenCalled();
  });

  it('opts out persistently without touching the database key, and bypasses even a protected store for new keys', async () => {
    const store = new MemorySecretStore();
    store.set('pi-kit/db', 'database-key');
    store.set('litellm', 'saved-api-key');
    const { service, dataDir, database, meta } = make(store);
    const agent = process.env['PI_CODING_AGENT_DIR']!;
    writeFileSync(join(agent, 'models.json'), JSON.stringify({ providers: { litellm: { apiKey: '!pi-kit-secret get litellm' } } }));
    const result = await service.setCredentialStorage(false);
    expect(result).toEqual({ moved: ['litellm'], failed: [] });
    expect(JSON.parse(readFileSync(join(agent, 'models.json'), 'utf8')).providers.litellm.apiKey).toBe('saved-api-key');
    expect(statSync(join(agent, 'models.json')).mode & 0o777).toBe(0o600);
    expect(store.get('pi-kit/db')).toBe('database-key');
    expect(store.get('litellm')).toBe('saved-api-key');
    expect(service.databaseProtection().state).toBe('encrypted');
    expect(service.status()).toMatchObject({ credentialsEnabled: false, available: false, movable: [], cliNeeded: false });
    expect(service.resolver('litellm')).toBeUndefined();
    const next = new SecretsService(store, { dataDir }, database as never, meta as never);
    Object.defineProperty(store, 'protected', { value: true });
    const set = vi.spyOn(store, 'set').mockImplementation(() => { throw new Error('must not write'); });
    expect(await next.keep('litellm', 'direct-api-key')).toEqual({ value: 'direct-api-key', storage: 'auth.json' });
    expect(await next.keepBearer('connector-github', 'token')).toEqual({ value: 'Bearer token', storage: 'mcp.json' });
    expect(set).not.toHaveBeenCalled();
    const launcher = vi.spyOn(next, 'ensureLauncher');
    await next.onModuleInit();
    expect(launcher).not.toHaveBeenCalled();
    await next.setCredentialStorage(true);
    expect(next.credentialsEnabled()).toBe(true);
    set.mockRestore();
  });

  it('reports unreadable keys without returning secrets and still disables future credential-store writes', async () => {
    const store = new MemorySecretStore();
    const { service } = make(store);
    const agent = process.env['PI_CODING_AGENT_DIR']!;
    writeFileSync(join(agent, 'auth.json'), JSON.stringify({ openrouter: { type: 'api_key', key: '!pi-kit-secret get openrouter' } }));
    vi.spyOn(store, 'get').mockImplementation(() => { throw new Error('sensitive-native-error'); });
    const result = await service.setCredentialStorage(false);
    expect(result.failed[0].provider).toBe('openrouter');
    expect(JSON.stringify(result)).not.toContain('sensitive-native-error');
    expect(readFileSync(join(agent, 'auth.json'), 'utf8')).toContain('!pi-kit-secret get openrouter');
    expect(service.credentialsEnabled()).toBe(false);
  });

  describe('which command auth.json gets', () => {
    it('is `security` for the macOS keychain, the helper for Windows, and secret-tool on Linux only when it is installed', async () => {
      const keychain = new MemorySecretStore();
      Object.defineProperty(keychain, 'kind', { value: 'keychain' });
      asPlatform('darwin');
      setEnv('PI_KIT_SECRET_STORE', 'legacy');
      expect(make(keychain).service.resolver('openrouter')).toBe('!security find-generic-password -s pi-kit -a openrouter -w');
      asPlatform('win32');
      expect(make(keychain).service.resolver('openrouter')).toBe('!pi-kit-secret get openrouter');
      asPlatform('linux');
      expect(make(keychain).service.resolver('openrouter')).toBe('!pi-kit-secret get openrouter');
      const bin = scratch();
      writeFileSync(join(bin, 'secret-tool'), '#!/bin/sh\n');
      chmodSync(join(bin, 'secret-tool'), 0o755);
      setEnv('PATH', `${bin}${delimiter}${process.env['PATH']}`);
      expect(make(keychain).service.resolver('openrouter')).toBe('!secret-tool lookup service pi-kit username openrouter');
    });

    it('is the helper for a scratch store, because `security` cannot read a file, and nothing without a store or a helper on a platform that needs it', async () => {
      asPlatform('darwin');
      expect(make(new MemorySecretStore()).service.resolver('groq')).toBe('!pi-kit-secret get groq');
      expect(make(new NoSecretStore()).service.resolver('groq')).toBeUndefined();
      setEnv('PI_KIT_SECRET_CLI', join(scratch(), 'missing.cjs'));
      expect(make(new MemorySecretStore()).service.resolver('groq')).toBeUndefined();
      expect(make(new MemorySecretStore()).service.resolver('not a provider')).toBeUndefined();
    });
  });

  describe('keeping a key', () => {
    it('stores it and hands pi the command, so the key is not what goes into auth.json', async () => {
      const store = new MemorySecretStore();
      const { service } = make(store);
      const kept = await service.keep('openrouter', 'sk-or-v1-secret-value-1234');
      expect(kept).toEqual({ value: '!pi-kit-secret get openrouter', storage: 'keychain' });
      expect(store.get('openrouter')).toBe('sk-or-v1-secret-value-1234');
      await service.forget('openrouter');
      expect(store.get('openrouter')).toBeUndefined();
    });

    it('never falls back to plaintext when protected biometric storage refuses access', async () => {
      setEnv('PI_KIT_SECRET_STORE', 'macos');
      const store: SecretStore = {
        kind: 'keychain', label: 'Touch ID', protected: true, helperResolver: true,
        available: () => true, get: async () => undefined,
        set: async () => { throw new Error('Authentication cancelled'); },
        delete: async () => false, list: async () => [],
      };
      await expect(make(store).service.keep('openrouter', 'fixture-secret')).rejects.toThrow(/cancelled/);
    });

    it('falls back to the key itself (pi’s own 0600 file) when there is no store, no helper, or the store refuses', async () => {
      expect(await make(new NoSecretStore()).service.keep('openrouter', 'sk-1')).toEqual({ value: 'sk-1', storage: 'auth.json' });
      const refusing = new MemorySecretStore();
      refusing.set = () => {
        throw new Error('The keychain is locked');
      };
      expect(await make(refusing).service.keep('openrouter', 'sk-2')).toEqual({ value: 'sk-2', storage: 'auth.json' });
      const forgetful = new MemorySecretStore();
      forgetful.get = () => undefined;
      expect(await make(forgetful).service.keep('openrouter', 'sk-3')).toEqual({ value: 'sk-3', storage: 'auth.json' });
    });
  });

  describe('the launcher', () => {
    it('is written to the data folder (executable), is put on this process’s PATH, and is rewritten only when it changes', async () => {
      const { service, dataDir } = make(new MemorySecretStore());
      const file = service.ensureLauncher() as string;
      expect(file).toBe(join(dataDir, 'bin', process.platform === 'win32' ? 'pi-kit-secret.cmd' : 'pi-kit-secret'));
      const text = readFileSync(file, 'utf8');
      expect(text).toContain(process.env['PI_KIT_SECRET_CLI']);
      expect(text).toContain(process.execPath);
      if (process.platform !== 'win32') expect(statSync(file).mode & 0o111).not.toBe(0);
      expect((process.env['PATH'] ?? '').split(delimiter)[0]).toBe(join(dataDir, 'bin'));
      const mtime = statSync(file).mtimeMs;
      service.ensureLauncher();
      expect(statSync(file).mtimeMs).toBe(mtime);
    });

    it('installs on PATH only when asked, into the folder the setting names, and says whether that folder is on PATH', async () => {
      const { service } = make(new MemorySecretStore());
      const result = service.installCli();
      expect(existsSync(result.path)).toBe(true);
      expect(result.dir).toBe(process.env['PI_KIT_BIN_DIR']);
      expect(result.onPath).toBe(false);
      expect(readFileSync(result.path, 'utf8')).toContain('exec');
    });

    it('says nothing is to be installed when the build has no CLI', async () => {
      setEnv('PI_KIT_SECRET_CLI', join(scratch(), 'missing.cjs'));
      const { service } = make(new MemorySecretStore());
      expect(service.ensureLauncher()).toBeUndefined();
      expect(() => service.installCli()).toThrow(/not part of this build/);
    });
  });

  describe('what Settings shows', () => {
    it('lists the keys auth.json holds in full as movable, and not commands, variables, tokens or entries with extra settings', async () => {
      const agent = process.env['PI_CODING_AGENT_DIR'] as string;
      mkdirSync(agent, { recursive: true });
      writeFileSync(
        join(agent, 'auth.json'),
        JSON.stringify({
          openrouter: { type: 'api_key', key: 'sk-or-v1-abcdefghijklmnop' },
          groq: { type: 'api_key', key: 'gsk_abcdefghijklmnop' },
          anthropic: { type: 'api_key', key: '!security find-generic-password -s pi-kit -a anthropic -w' },
          google: { type: 'api_key', key: 'GEMINI_API_KEY' },
          openai: { type: 'oauth', access: 'a', refresh: 'r', expires: 1 },
          'cloudflare-workers-ai': { type: 'api_key', key: 'cf-abcdefghijkl', env: { CLOUDFLARE_ACCOUNT_ID: 'x' } },
        }),
      );
      const status = make(new MemorySecretStore()).service.status();
      expect(status).toMatchObject({ store: 'memory', available: true, movable: ['groq', 'openrouter'], resolver: '!pi-kit-secret get <provider>' });
      expect(status.cliInstallDir).toBe(process.env['PI_KIT_BIN_DIR']);
      expect(status.cliNeeded).toBe(true);
      expect(make(new NoSecretStore()).service.status()).toMatchObject({ store: 'none', available: false, movable: [] });
      expect(make(new NoSecretStore()).service.status().resolver).toBeUndefined();
    });

    it('shows the database key once', async () => {
      const { service } = make(new MemorySecretStore());
      expect(service.databaseProtection().recoveryKeyShown).toBe(false);
      expect(service.recoveryKey()).toEqual({ key: 'a'.repeat(64) });
      expect(service.databaseProtection().recoveryKeyShown).toBe(true);
      expect(() => service.recoveryKey()).toThrow(/not shown again/);
    });

    it('a file store is a real second process’s view: the CLI reads what the backend wrote', async () => {
      const path = join(scratch(), 'secrets.json');
      const { service } = make(new FileSecretStore(path));
      await service.keep('openrouter', 'sk-or-shared');
      expect(new FileSecretStore(path).get('openrouter')).toBe('sk-or-shared');
    });
  });
});
