import { describe, expect, it } from 'vitest';
import { DB_KEY_ACCOUNT, isProviderAccount, keyStorageOf, parseResolver, resolverCommand } from './secrets';

describe('the command written into auth.json in place of a key', () => {
  it('is `security` on macOS, which ships with the system and finds the entry by service and account', () => {
    expect(resolverCommand('darwin', 'openrouter')).toBe('!security find-generic-password -s pi-kit -a openrouter -w');
    expect(resolverCommand('darwin', 'github-copilot', { secretTool: true })).toBe('!security find-generic-password -s pi-kit -a github-copilot -w');
  });

  it('is the helper on Windows, and on Linux unless libsecret’s secret-tool is installed', () => {
    expect(resolverCommand('win32', 'anthropic')).toBe('!pi-kit-secret get anthropic');
    expect(resolverCommand('linux', 'anthropic')).toBe('!pi-kit-secret get anthropic');
    expect(resolverCommand('linux', 'anthropic', { secretTool: false })).toBe('!pi-kit-secret get anthropic');
    expect(resolverCommand('linux', 'anthropic', { secretTool: true })).toBe('!secret-tool lookup service pi-kit username anthropic');
  });

  it('refuses a provider id that would need quoting, so no command is ever built from text that can carry shell syntax', () => {
    for (const bad of ['', 'a b', 'x;rm -rf ~', '$(id)', "a'b", 'a/b', '-w', '.hidden', 'x'.repeat(65)]) {
      expect(isProviderAccount(bad)).toBe(false);
      expect(() => resolverCommand('darwin', bad)).toThrow(/keychain entry/);
    }
    for (const good of ['openrouter', 'google-vertex', 'amazon-bedrock', 'qwen-token-plan-cn', 'a.b_c-1']) expect(isProviderAccount(good)).toBe(true);
  });

  it('is recognised again, for every platform’s form, and only for pi-kit’s own', () => {
    expect(parseResolver('!security find-generic-password -s pi-kit -a openrouter -w')).toEqual({ provider: 'openrouter', via: 'security' });
    expect(parseResolver('!secret-tool lookup service pi-kit username groq')).toEqual({ provider: 'groq', via: 'secret-tool' });
    expect(parseResolver('!pi-kit-secret get anthropic')).toEqual({ provider: 'anthropic', via: 'pi-kit-secret' });
    for (const other of [
      "!security find-generic-password -ws 'anthropic'",
      '!security find-generic-password -s pi-kit -a openrouter -w; curl evil',
      '!pi-kit-secret get openrouter && echo',
      '!op read op://vault/openai/key',
      'sk-or-v1-abc',
      '',
    ]) {
      expect(parseResolver(other)).toBeUndefined();
    }
  });

  it('round trips: whatever resolverCommand writes, parseResolver reads back', () => {
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      for (const secretTool of [true, false]) {
        const command = resolverCommand(platform, 'openrouter', { secretTool });
        expect(parseResolver(command)?.provider).toBe('openrouter');
        expect(keyStorageOf(command)).toBe('keychain');
      }
    }
  });
});

describe('where an API key lives, from auth.json’s key field', () => {
  it('tells a literal key, a pi-kit resolver, somebody’s command and an environment variable apart', () => {
    expect(keyStorageOf('sk-or-v1-abcdef')).toBe('auth.json');
    expect(keyStorageOf('!pi-kit-secret get openrouter')).toBe('keychain');
    expect(keyStorageOf('!op read op://vault/openai/key')).toBe('command');
    expect(keyStorageOf('ANTHROPIC_API_KEY')).toBe('environment');
    expect(keyStorageOf('GEMINI_API_KEY')).toBe('environment');
    expect(keyStorageOf('abc')).toBe('auth.json');
  });

  it('keeps the database key out of the provider namespace', () => {
    expect(DB_KEY_ACCOUNT).toBe('pi-kit/db');
    expect(isProviderAccount(DB_KEY_ACCOUNT)).toBe(false);
  });
});
