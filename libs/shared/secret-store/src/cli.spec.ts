import { describe, expect, it } from 'vitest';
import { type CliIo, runCli } from './cli';
import { defaultInstallDir, launcherName, launcherScript } from './launcher';
import { MemorySecretStore, NoSecretStore } from './store';

function io(input: { stdin?: string; typed?: string } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const asked: string[] = [];
  const api: CliIo = {
    readStdin: async () => input.stdin,
    promptHidden: async (message) => {
      asked.push(message);
      return input.typed ?? '';
    },
    out: (t) => void out.push(t),
    err: (t) => void err.push(t),
  };
  return { api, out, err, asked };
}

describe('pi-kit-secret', () => {
  it('set reads the secret from standard input, never from an argument, and get prints it and nothing else', async () => {
    const store = new MemorySecretStore();
    const set = io({ stdin: 'sk-or-v1-secret\n' });
    expect(await runCli(['set', 'openrouter'], set.api, store)).toBe(0);
    expect(store.get('openrouter')).toBe('sk-or-v1-secret');
    expect(set.err.join('')).toMatch(/Stored the secret for openrouter \(memory/);
    expect(set.err.join('')).not.toContain('sk-or-v1-secret');

    const get = io();
    expect(await runCli(['get', 'openrouter'], get.api, store)).toBe(0);
    expect(get.out).toEqual(['sk-or-v1-secret\n']);
    expect(get.err).toEqual([]);
  });

  it('get --bearer prints the secret as an Authorization header value (connectors), and only for get', async () => {
    const store = new MemorySecretStore();
    store.set('connector-github', 'ghp_x');
    const get = io();
    expect(await runCli(['get', 'connector-github', '--bearer'], get.api, store)).toBe(0);
    expect(get.out).toEqual(['Bearer ghp_x\n']);
    expect(await runCli(['get', 'missing', '--bearer'], io().api, store)).toBe(1);
    const set = io({ stdin: 'x' });
    expect(await runCli(['set', 'a', '--bearer'], set.api, store)).toBe(2);
    expect(await runCli(['get', 'connector-github', '--other'], io().api, store)).toBe(2);
  });

  it('asks for the secret without echo when standard input is a terminal', async () => {
    const store = new MemorySecretStore();
    const typed = io({ typed: 'gsk_typed' });
    expect(await runCli(['set', 'groq'], typed.api, store)).toBe(0);
    expect(typed.asked).toEqual(['Secret for groq: ']);
    expect(store.get('groq')).toBe('gsk_typed');
  });

  it('refuses a secret given as an argument, an empty secret and an account that is not a provider id', async () => {
    const store = new MemorySecretStore();
    const arg = io();
    expect(await runCli(['set', 'openrouter', 'sk-or-in-argv'], arg.api, store)).toBe(2);
    expect(arg.err.join('')).toMatch(/never an argument/);
    expect(arg.err.join('')).not.toContain('sk-or-in-argv');
    expect(await runCli(['set', 'openrouter'], io({ stdin: '\n' }).api, store)).toBe(2);
    expect(await runCli(['get', 'pi-kit/db'], io().api, store)).toBe(2);
    expect(await runCli(['get', '../etc'], io().api, store)).toBe(2);
    expect(store.list()).toEqual([]);
  });

  it('get exits 1 when there is nothing, delete says what it did, list shows accounts only', async () => {
    const store = new MemorySecretStore();
    store.set('anthropic', 'sk-ant-1');
    store.set('openai', 'sk-2');
    const missing = io();
    expect(await runCli(['get', 'groq'], missing.api, store)).toBe(1);
    expect(missing.out).toEqual([]);
    const list = io();
    expect(await runCli(['list'], list.api, store)).toBe(0);
    expect(list.out.join('')).toBe('anthropic\nopenai\n');
    const del = io();
    expect(await runCli(['delete', 'anthropic'], del.api, store)).toBe(0);
    expect(await runCli(['delete', 'anthropic'], io().api, store)).toBe(1);
    expect(store.list()).toEqual(['openai']);
  });

  it('prints its usage, and says plainly when the machine has no credential store', async () => {
    const help = io();
    expect(await runCli([], help.api, new MemorySecretStore())).toBe(2);
    expect(help.err.join('')).toMatch(/Usage: pi-kit-secret/);
    expect(await runCli(['--help'], io().api, new MemorySecretStore())).toBe(0);
    const none = io();
    expect(await runCli(['get', 'openrouter'], none.api, new NoSecretStore())).toBe(3);
    expect(none.err.join('')).toMatch(/no credential store/);
    expect(await runCli(['frobnicate'], io().api, new MemorySecretStore())).toBe(2);
  });
});

describe('the launcher on PATH', () => {
  const electron = { runtime: '/Applications/pi-kit.app/Contents/MacOS/pi-kit', electron: true, script: '/Applications/pi-kit.app/Contents/Resources/backend/pi-kit-secret.cjs' };

  it('starts the bundle with Electron’s Node in the packaged app (POSIX)', () => {
    expect(launcherScript('darwin', electron)).toBe(
      `#!/bin/sh\n# Written by pi-kit (Settings > Advanced). Reads and writes pi-kit's entries in the system credential store.\nELECTRON_RUN_AS_NODE=1 exec '/Applications/pi-kit.app/Contents/MacOS/pi-kit' '/Applications/pi-kit.app/Contents/Resources/backend/pi-kit-secret.cjs' "$@"\n`,
    );
  });

  it('starts it with node in development, and quotes a path with a quote in it', () => {
    const script = launcherScript('linux', { runtime: '/usr/bin/node', electron: false, script: "/home/o'neil/pi-kit/dist/apps/secret-cli/pi-kit-secret.cjs" });
    expect(script).toContain(`exec '/usr/bin/node' '/home/o'\\''neil/pi-kit/dist/apps/secret-cli/pi-kit-secret.cjs' "$@"`);
    expect(script).not.toContain('ELECTRON_RUN_AS_NODE');
  });

  it('is a .cmd file on Windows with CRLF line endings', () => {
    const script = launcherScript('win32', { runtime: 'C:\\Program Files\\pi-kit\\pi-kit.exe', electron: true, script: 'C:\\Program Files\\pi-kit\\resources\\backend\\pi-kit-secret.cjs' });
    expect(script).toBe(
      `@echo off\r\nrem Written by pi-kit (Settings > Advanced). Reads and writes pi-kit's entries in the Windows Credential Manager.\r\nset ELECTRON_RUN_AS_NODE=1\r\n"C:\\Program Files\\pi-kit\\pi-kit.exe" "C:\\Program Files\\pi-kit\\resources\\backend\\pi-kit-secret.cjs" %*\r\n`,
    );
    expect(launcherName('win32')).toBe('pi-kit-secret.cmd');
    expect(launcherName('darwin')).toBe('pi-kit-secret');
  });

  it('installs into ~/.local/bin, or the local app data folder on Windows', () => {
    expect(defaultInstallDir('darwin', {}, '/Users/ada')).toBe('/Users/ada/.local/bin');
    expect(defaultInstallDir('linux', {}, '/home/ada')).toBe('/home/ada/.local/bin');
    expect(defaultInstallDir('win32', { LOCALAPPDATA: 'C:\\Users\\ada\\AppData\\Local' }, 'C:\\Users\\ada')).toBe('C:\\Users\\ada\\AppData\\Local\\pi-kit\\bin');
  });
});

describe('explicit launcher store', () => {
  const target = { runtime: '/usr/bin/node', electron: false, script: '/tmp/cli.cjs' };
  it('propagates native choices on POSIX and Windows', () => {
    expect(launcherScript('darwin', { ...target, secretStore: 'macos' })).toContain("PI_KIT_SECRET_STORE='macos' exec");
    expect(launcherScript('win32', { ...target, secretStore: 'legacy' })).toContain('set "PI_KIT_SECRET_STORE=legacy"\r\n');
    expect(launcherScript('darwin', target)).not.toContain('PI_KIT_SECRET_STORE');
  });
  it('quotes shell metacharacters in file paths and rejects unsafe Windows settings', () => {
    expect(launcherScript('linux', { ...target, secretStore: "file:/tmp/o'neil/$(id);&" })).toContain("PI_KIT_SECRET_STORE='file:/tmp/o'\\''neil/$(id);&'");
    for (const setting of ['unknown', 'file:', 'file:x\ncommand', 'file:x\0']) {
      expect(() => launcherScript('linux', { ...target, secretStore: setting })).toThrow(/Invalid secret store/);
    }
    for (const suffix of ['%PATH%', '!VAR!', '"', '&calc', '|calc', '^', '<x', '>x']) {
      expect(() => launcherScript('win32', { ...target, secretStore: `file:C:\\${suffix}` })).toThrow(/Invalid secret store/);
    }
    expect(launcherScript('win32', { ...target, secretStore: 'file:C:\\with spaces\\store.json' })).toContain('set "PI_KIT_SECRET_STORE=file:C:\\with spaces\\store.json"\r\n');
  });
});
