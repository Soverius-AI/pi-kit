import { english } from '@pi-kit/i18n/testing';
import type { ProviderInfo, SettingsModel } from '@pi-kit/protocol';
import { describe, expect, it } from 'vitest';
import * as w from './add-provider';

const provider = (over: Partial<ProviderInfo> & { id: string }): ProviderInfo => ({
  name: over.id,
  methods: ['api_key'],
  configured: false,
  stored: false,
  ...over,
});
const providers = [
  provider({ id: 'anthropic', name: 'Anthropic', methods: ['api_key', 'oauth'], subscription: true, configured: true }),
  provider({ id: 'openai', name: 'OpenAI', methods: ['api_key', 'oauth'], subscription: true }),
  provider({ id: 'github-copilot', name: 'GitHub Copilot', methods: ['oauth'], subscription: true }),
  provider({ id: 'radius', name: 'Radius', methods: ['oauth'], subscription: true }),
  provider({ id: 'openrouter', name: 'OpenRouter' }),
  provider({ id: 'local-thing', name: 'Local thing', methods: [] }),
];

describe('the Add a provider wizard', () => {
  it('starts at "how", with nothing chosen and no way to continue', () => {
    const s = w.startAddProvider();
    expect(s).toMatchObject({ step: 'how', direction: 'forward', query: '' });
    expect(w.canContinue(s)).toBe(false);
    expect(w.dotsOn(s)).toBe(1);
    expect(w.footHint.bind(undefined, english)(s)).toBe('Step 1 of 4, next: choose the provider');
  });

  it('goes subscription: how, which, sign-in, done, and back the same way', () => {
    let s = w.choose(w.startAddProvider(), 'subscription');
    expect(s).toMatchObject({ step: 'which', method: 'subscription' });
    expect(w.canContinue(s)).toBe(false);
    s = w.pick(s, 'openai');
    expect(w.canContinue(s)).toBe(true);
    s = w.next(s);
    expect(s).toMatchObject({ step: 'sign-in', provider: 'openai', direction: 'forward' });
    expect(w.dotsOn(s)).toBe(3);
    s = w.next(s);
    expect(s.step).toBe('done');
    expect(w.next(s).step).toBe('done');
    s = w.back(s);
    expect(s).toMatchObject({ step: 'sign-in', direction: 'back' });
    s = w.back(w.back(s));
    expect(s.step).toBe('how');
    expect(w.back(s).step).toBe('how');
  });

  it('sends Radius straight to its sign-in, with Radius as the provider', () => {
    const s = w.choose(w.startAddProvider(), 'radius');
    expect(s).toMatchObject({ step: 'sign-in', provider: 'radius' });
    expect(w.footHint.bind(undefined, english)(s)).toBe('Step 2 of 3, next: what was saved');
    expect(w.back(s).step).toBe('how');
  });

  it('a local model has the address as its "which" and then is done', () => {
    let s = w.choose(w.startAddProvider(), 'local');
    expect(s.step).toBe('which');
    expect(s.provider).toBeUndefined();
    expect(w.canContinue(s)).toBe(false);
    expect(w.footHint.bind(undefined, english)(s)).toBe('Step 2 of 3, next: use the server');
    s = w.next(s);
    expect(s.step).toBe('done');
  });

  it('can be opened on a place: Edit on a local server, "Add a key instead" on a provider', () => {
    expect(w.startAddProvider({ method: 'local' })).toMatchObject({ step: 'which', method: 'local' });
    expect(w.startAddProvider({ method: 'api_key', provider: 'google' })).toMatchObject({
      step: 'which',
      method: 'api_key',
      provider: 'google',
    });
  });

  it('forgets the provider and the search when another way is chosen', () => {
    let s = w.choose(w.startAddProvider(), 'api_key');
    s = w.search(w.pick(s, 'openrouter'), 'open');
    s = w.choose(w.back(s), 'subscription');
    expect(s.provider).toBeUndefined();
    expect(s.query).toBe('');
  });

  it('lists the providers that offer the way, the ones not signed in first, narrowed by the search', () => {
    expect(w.providersFor(providers, 'subscription', '').map((p) => p.id)).toEqual([
      'github-copilot',
      'openai',
      'anthropic',
    ]);
    expect(w.providersFor(providers, 'api_key', '').map((p) => p.id)).toEqual(['openai', 'openrouter', 'anthropic']);
    expect(w.providersFor(providers, 'api_key', ' OPEN ').map((p) => p.id)).toEqual(['openai', 'openrouter']);
    expect(w.providersFor(providers, 'radius', '').map((p) => p.id)).toEqual(['radius']);
    expect(w.providersFor(providers, 'local', '')).toEqual([]);
    expect(w.providersFor(providers, undefined, '')).toEqual([]);
  });

  it('suggests the first usable model of the provider as the default', () => {
    const models: SettingsModel[] = [
      { provider: 'anthropic', id: 'virtual', name: 'v', reasoning: false, available: true, virtual: true },
      { provider: 'anthropic', id: 'claude-sonnet-5-5', name: 's', reasoning: true, available: true },
      { provider: 'openai', id: 'gpt', name: 'g', reasoning: false, available: true },
    ];
    expect(w.defaultModelOf('anthropic', models)?.id).toBe('claude-sonnet-5-5');
    expect(w.defaultModelOf('mistral', models)).toBeUndefined();
  });
});
