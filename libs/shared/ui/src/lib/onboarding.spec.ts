import { english } from '@pi-kit/i18n/testing';
import type { ProviderInfo, SettingsModel, SetupInfo } from '@pi-kit/protocol';
import { describe, expect, it } from 'vitest';
import {
  onboardingSteps,
  cardStatuses,
  credentialStatus,
  foundLines,
  isCredentialRejection,
  isOutOfFunds,
  modelOptionLabel,
  shouldAutoOpen,
  stepIndex,
  suggestedPrompts,
} from './onboarding';

const info = (over: Partial<SetupInfo> = {}): SetupInfo => ({
  os: { platform: 'darwin', arch: 'arm64', release: '25.0' },
  pi: { version: '1.3.0', source: 'bundled' },
  pathPi: { found: false },
  agentDir: {
    path: '/Users/ada/.pi/agent',
    exists: false,
    auth: [],
    hasModelsJson: false,
    hasSettings: false,
    sessionCount: 0,
  },
  providers: [],
  localServers: [],
  needsSetup: true,
  existingSetupWorks: false,
  autoOpenOff: false,
  ...over,
});

describe('when the first-run flow opens by itself', () => {
  it('opens on a first run, with or without a model (an existing pi user sees the Welcome card once)', () => {
    expect(shouldAutoOpen(info())).toBe(true);
    expect(shouldAutoOpen(info({ needsSetup: false }))).toBe(true);
  });

  it('after it was finished it opens again only when no provider has a model', () => {
    const done = { state: 'completed' as const, at: 1 };
    expect(shouldAutoOpen(info({ needsSetup: false, onboarding: done }))).toBe(false);
    expect(shouldAutoOpen(info({ needsSetup: true, onboarding: done }))).toBe(true);
  });

  it('does not come back after it was skipped, even with no model, and the tests can switch it off', () => {
    expect(shouldAutoOpen(info({ needsSetup: true, onboarding: { state: 'skipped', at: 1 } }))).toBe(false);
    expect(shouldAutoOpen(info({ autoOpenOff: true }))).toBe(false);
  });
});

describe('the steps', () => {
  it('are five, in the order of mockup 07', () => {
    expect(onboardingSteps(english).map((s) => s.id)).toEqual(['welcome', 'model', 'defaults', 'folder', 'prompt']);
    expect(stepIndex(english, 'folder')).toBe(3);
  });
});

describe('what the Welcome card found', () => {
  it('says what is there and what is not, with the home folder shortened', () => {
    const lines = foundLines(english, info());
    expect(lines.map((l) => `${l.strong} ${l.text}`)).toEqual(['pi 1.3.0 bundled', '~/.pi/agent does not exist yet']);
    expect(lines[1].tone).toBe('muted');
  });

  it('counts credentials and sessions, the pi on PATH and the local servers', () => {
    const lines = foundLines(
      english,
      info({
        pathPi: { found: true, version: '1.2.9' },
        agentDir: {
          path: '/home/ada/.pi/agent',
          exists: true,
          auth: [
            { provider: 'openrouter', type: 'api_key', store: 'auth.json' },
            { provider: 'anthropic', type: 'oauth', store: 'auth.json' },
          ],
          hasModelsJson: true,
          hasSettings: true,
          sessionCount: 1,
        },
        localServers: [
          {
            kind: 'llama-swap',
            name: 'llama-swap or llama.cpp',
            baseUrl: 'http://127.0.0.1:8080/v1',
            models: ['a', 'b'],
          },
          { kind: 'ollama', name: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1', models: ['m'] },
        ],
      }),
    );
    expect(lines.map((l) => `${l.strong} ${l.text}`)).toEqual([
      'pi 1.3.0 bundled',
      'pi 1.2.9 on PATH',
      '~/.pi/agent 2 credentials, models.json, 1 session',
      'llama-swap on :8080, 2 models',
      'Ollama on :11434, 1 model',
    ]);
  });
});

const provider = (over: Partial<ProviderInfo>): ProviderInfo => ({
  id: 'x',
  name: 'X',
  methods: ['api_key'],
  configured: true,
  stored: false,
  ...over,
});
const model = (providerId: string, id: string, over: Partial<SettingsModel> = {}): SettingsModel => ({
  provider: providerId,
  id,
  name: id,
  reasoning: false,
  available: true,
  contextWindow: 262144,
  ...over,
});

describe('what each card says about itself', () => {
  it('describes a stored key by provider, last four characters and where it lives, never more', () => {
    const p = provider({
      id: 'openrouter',
      name: 'OpenRouter',
      stored: true,
      storedType: 'api_key',
      credential: { type: 'api_key', store: 'keychain', lastFour: 'a1b2' },
    });
    expect(credentialStatus(english, p, 38)).toBe('OpenRouter key …a1b2 kept in the keychain, 38 models');
    expect(
      credentialStatus(
        english,
        provider({
          name: 'Claude',
          credential: { type: 'oauth', store: 'auth.json' },
          stored: true,
          storedType: 'oauth',
        }),
        1,
      ),
    ).toBe('Claude signed in, 1 model');
  });

  it('sorts the configured providers onto the four cards', () => {
    const providers = [
      provider({
        id: 'radius',
        name: 'Radius',
        methods: ['oauth', 'api_key'],
        stored: true,
        storedType: 'oauth',
        credential: { type: 'oauth', store: 'auth.json' },
      }),
      provider({
        id: 'openai',
        name: 'OpenAI',
        methods: ['oauth', 'api_key'],
        subscription: true,
        stored: true,
        storedType: 'oauth',
        credential: { type: 'oauth', store: 'auth.json' },
      }),
      provider({
        id: 'openrouter',
        name: 'OpenRouter',
        stored: true,
        storedType: 'api_key',
        credential: { type: 'api_key', store: 'auth.json', lastFour: 'a1b2' },
      }),
      provider({ id: 'llama-swap', name: 'llama-swap', source: 'models_json_key' }),
      provider({ id: 'anthropic', name: 'Anthropic', source: 'environment', label: 'ANTHROPIC_API_KEY' }),
      provider({ id: 'groq', name: 'Groq', configured: false }),
    ];
    const models = [
      model('radius', 'r1'),
      model('openai', 'gpt'),
      model('openrouter', 'o1'),
      model('openrouter', 'o2'),
      model('llama-swap', 'gemma'),
      model('anthropic', 'opus'),
    ];
    const status = cardStatuses(english, providers, models);
    expect(status.radius).toEqual(['Radius signed in, 1 model']);
    expect(status.subscription).toEqual(['OpenAI signed in, 1 model']);
    expect(status.key).toEqual([
      'OpenRouter key …a1b2 saved in auth.json, plain text, 2 models',
      'Anthropic through ANTHROPIC_API_KEY, 1 model',
    ]);
    expect(status.local).toEqual(['llama-swap configured in models.json, 1 model']);
  });

  it('labels a model with its provider, context and price', () => {
    expect(modelOptionLabel(english, model('llama-swap', 'gemma', { name: 'Gemma 4 26B' }))).toBe(
      'Gemma 4 26B · llama-swap · 262k context · free',
    );
    expect(
      modelOptionLabel(
        english,
        model('openrouter', 'o1', { name: 'Opus', contextWindow: 200000, costInput: 3, costOutput: 15 }),
      ),
    ).toBe('Opus · openrouter · 200k context · $3/$15 per 1M');
  });
});

describe('first prompts', () => {
  it('differ for an empty scratch folder and a real project', () => {
    expect(suggestedPrompts(english, true)).toHaveLength(3);
    expect(suggestedPrompts(english, false)).toHaveLength(3);
    expect(suggestedPrompts(english, true)[0]).not.toBe(suggestedPrompts(english, false)[0]);
  });
});

describe('a credential the provider refuses', () => {
  it('is recognised from the error text of a run', () => {
    for (const text of [
      '401 {"error":{"message":"Incorrect API key provided"}}',
      'Unauthorized',
      'authentication_error: invalid x-api-key',
      'OAuth token has expired',
    ])
      expect(isCredentialRejection(text)).toBe(true);
    for (const text of [
      '429 rate limit',
      'The model is overloaded',
      'ECONNREFUSED 127.0.0.1:8080',
      '403 forbidden: plan does not include this model',
    ])
      expect(isCredentialRejection(text)).toBe(false);
  });
});

describe('a gateway account with no balance', () => {
  it('is recognised from the error text of a run', () => {
    expect(
      isOutOfFunds(
        '402 Payment Required: Radius gateway account balance is insufficient: $0.00 available (insufficient_balance)',
      ),
    ).toBe(true);
    for (const text of ['401 Unauthorized', '429 rate limit', 'The model is overloaded'])
      expect(isOutOfFunds(text)).toBe(false);
  });
});
