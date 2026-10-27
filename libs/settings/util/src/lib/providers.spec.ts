import { english } from '@pi-kit/i18n/testing';
import type { ProviderInfo, SettingsModel } from '@pi-kit/protocol';
import { describe, expect, it } from 'vitest';
import {
  agoText,
  credentialLine,
  environmentRows,
  letters,
  modelCountText,
  providerKind,
  providerRows,
  signedInCount,
} from './providers';

const NOW = Date.UTC(2026, 9, 17, 12);
const DAY = 86_400_000;

const provider = (over: Partial<ProviderInfo> & { id: string }): ProviderInfo => ({
  name: over.id,
  methods: ['api_key'],
  configured: false,
  stored: false,
  ...over,
});
const model = (p: string, id: string): SettingsModel => ({
  provider: p,
  id,
  name: id,
  reasoning: false,
  available: true,
});

const anthropic = provider({
  id: 'anthropic',
  name: 'Anthropic',
  methods: ['api_key', 'oauth'],
  subscription: true,
  configured: true,
  stored: true,
  storedType: 'oauth',
  source: 'stored',
  credential: { type: 'oauth', store: 'auth.json', addedAt: NOW - 3 * DAY },
});
const openrouter = provider({
  id: 'openrouter',
  name: 'OpenRouter',
  configured: true,
  stored: true,
  storedType: 'api_key',
  source: 'stored',
  credential: { type: 'api_key', store: 'keychain', lastFour: 'a1b2', addedAt: NOW - 100 },
});
const llama = provider({
  id: 'llama-swap',
  name: 'llama-swap',
  methods: [],
  configured: true,
  source: 'models_json_key',
});
const gemini = provider({
  id: 'google',
  name: 'Google',
  configured: true,
  source: 'environment',
  label: 'GEMINI_API_KEY',
});
const unused = provider({ id: 'mistral', name: 'Mistral' });
const all = [anthropic, openrouter, llama, gemini, unused];
const models = [
  model('anthropic', 'a'),
  model('anthropic', 'b'),
  model('openrouter', 'c'),
  model('llama-swap', 'd'),
  model('google', 'e'),
];

describe('the Providers list', () => {
  it('knows how each provider is signed in', () => {
    expect(all.map(providerKind)).toEqual(['subscription', 'api_key', 'local', 'environment', 'other']);
  });

  it('lists the providers that are signed in, never the ones that are not or only come from the environment', () => {
    const rows = providerRows(english, all, models, 'macOS Keychain', {}, NOW);
    expect(rows.map((r) => r.id)).toEqual(['anthropic', 'openrouter', 'llama-swap']);
    expect(rows.map((r) => r.chip.text)).toEqual(['subscription', 'API key', 'local']);
    expect(rows.map((r) => r.models)).toEqual([2, 1, 1]);
    expect(rows.map((r) => r.letters)).toEqual(['An', 'Op', 'LS']);
  });

  it('gives each row its icon actions', () => {
    const rows = providerRows(english, all, models, undefined, {}, NOW);
    expect(rows.find((r) => r.id === 'anthropic')?.actions).toEqual(['sign-out']);
    expect(rows.find((r) => r.id === 'openrouter')?.actions).toEqual(['change-key', 'remove-key']);
    expect(rows.find((r) => r.id === 'llama-swap')?.actions).toEqual(['test', 'edit', 'remove-provider']);
  });

  it('offers removal for LiteLLM and custom endpoints with stored keys, not environment credentials', () => {
    const rows = providerRows(
      english,
      [
        provider({ id: 'litellm', configured: true, source: 'models_json_key' }),
        provider({ id: 'custom', configured: true, stored: true, storedType: 'api_key', source: 'models_json_key' }),
      ],
      [],
    );
    expect(rows[0].actions).toEqual(['edit', 'remove-provider']);
    expect(rows[1].actions).toContain('remove-provider');
    expect(environmentRows(english, [gemini], [])[0].actions).toEqual(['add-key']);
  });

  it('describes a stored key by its last four characters, where it lives and when, and never by the key', () => {
    expect(credentialLine(english, openrouter, 'macOS Keychain', undefined, NOW)).toBe(
      'key ending in a1b2 · keychain (macOS Keychain) · added today',
    );
    expect(credentialLine(english, anthropic, undefined, undefined, NOW)).toBe(
      'Signed in with a subscription · signed in 3 days ago · auth.json, refreshed by pi',
    );
    const outside = provider({
      id: 'x',
      configured: true,
      stored: true,
      storedType: 'api_key',
      credential: { type: 'api_key', store: 'command' },
    });
    expect(credentialLine(english, outside, undefined, undefined, NOW)).toBe(
      'key from a command that prints it · added outside pi-kit',
    );
  });

  it('puts the address on a local server when it is known', () => {
    const rows = providerRows(english, [llama], models, undefined, { 'llama-swap': 'http://localhost:8080' }, NOW);
    expect(rows[0].line).toBe('http://localhost:8080 · pi’s models.json');
    expect(providerRows(english, [llama], models, undefined, {}, NOW)[0].line).toBe(
      'A server set up in pi’s models.json',
    );
  });

  it('lists the keys from the environment on their own, with the variable as the chip and "Add a key instead"', () => {
    const rows = environmentRows(english, all, models);
    expect(rows.map((r) => r.id)).toEqual(['google']);
    expect(rows[0].chip).toEqual({ text: 'GEMINI_API_KEY', tone: 'off' });
    expect(rows[0].actions).toEqual(['add-key']);
    expect(rows[0].line).toContain('GEMINI_API_KEY');
    // a stored key beside the variable is a row of the main list instead
    expect(
      environmentRows(
        english,
        [{ ...gemini, stored: true, storedType: 'api_key', credential: { type: 'api_key', store: 'auth.json' } }],
        models,
      ),
    ).toEqual([]);
  });

  it('carries the usage a provider reports, and nothing when it reports none', () => {
    const usage = { windows: [{ name: '5-hour window', used: 38, resets: '14:30' }] };
    expect(providerRows(english, [{ ...anthropic, usage }], models, undefined, {}, NOW)[0].usage).toEqual(usage);
    expect(providerRows(english, [anthropic], models, undefined, {}, NOW)[0].usage).toBeUndefined();
    expect(providerRows(english, [{ ...anthropic, usage: null }], models, undefined, {}, NOW)[0].usage).toBeUndefined();
  });

  it('counts, spells and abbreviates', () => {
    expect(signedInCount(all)).toBe(4);
    expect(modelCountText(0)).toBe('');
    expect(modelCountText(1)).toBe('1 model');
    expect(modelCountText(17)).toBe('17 models');
    expect(letters('GitHub Copilot')).toBe('GC');
    expect(letters('llama-swap')).toBe('LS');
    expect(letters('')).toBe('');
    expect(agoText(english, NOW - 2 * DAY, NOW)).toBe('2 days ago');
    expect(agoText(english, NOW - DAY, NOW)).toBe('yesterday');
  });
});
