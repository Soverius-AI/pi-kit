import { describe, expect, it } from 'vitest';
import { localAddress, modelProviders } from './model-providers';

type Status = { configured: boolean; source?: 'stored' | 'runtime' | 'environment' | 'fallback' | 'models_json_key' | 'models_json_command' };
const runtime = (table: Record<string, { name: string; subscription?: boolean; status: Status }>) =>
  ({
    getProvider: (id: string) => (table[id] ? { name: table[id].name } : undefined),
    getProviderAuthStatus: (id: string) => table[id].status,
    isUsingSubscription: (id: string) => table[id].subscription ?? false,
  }) as never;

describe('localAddress', () => {
  it('knows loopback and private addresses and nothing else', () => {
    expect(localAddress('http://localhost:8080/v1')).toBe('localhost:8080');
    expect(localAddress('http://127.0.0.1:11434/v1')).toBe('127.0.0.1:11434');
    expect(localAddress('http://[::1]:9000')).toBe('::1:9000');
    expect(localAddress('http://192.168.1.20:8000')).toBe('192.168.1.20:8000');
    expect(localAddress('https://api.openai.com/v1')).toBeUndefined();
    expect(localAddress('not a url')).toBeUndefined();
    expect(localAddress(undefined)).toBeUndefined();
  });
});

describe('modelProviders', () => {
  it('says how each provider is signed in and orders subscription, key, environment, local', () => {
    const rt = runtime({
      'llama-swap': { name: 'llama-swap', status: { configured: true, source: 'models_json_key' } },
      google: { name: 'Google', status: { configured: true, source: 'environment' } },
      openrouter: { name: 'OpenRouter', status: { configured: true, source: 'stored' } },
      anthropic: { name: 'Anthropic', subscription: true, status: { configured: true, source: 'stored' } },
    });
    const list = modelProviders(rt, [
      { provider: 'llama-swap', baseUrl: 'http://localhost:8080/v1' },
      { provider: 'llama-swap', baseUrl: 'http://localhost:8080/v1' },
      { provider: 'google', baseUrl: 'https://generativelanguage.googleapis.com' },
      { provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1' },
      { provider: 'anthropic', baseUrl: 'https://api.anthropic.com' },
    ]);
    expect(list).toEqual([
      { id: 'anthropic', name: 'Anthropic', kind: 'subscription' },
      { id: 'openrouter', name: 'OpenRouter', kind: 'api-key' },
      { id: 'google', name: 'Google', kind: 'environment' },
      { id: 'llama-swap', name: 'llama-swap', kind: 'local', address: 'localhost:8080' },
    ]);
  });
});
