import { english } from '@pi-kit/i18n/testing';
import type { ModelInfo, ModelProvider, ModelRef } from '@pi-kit/protocol';
import { describe, expect, it } from 'vitest';
import {
  FLASK_FILL,
  flaskStroke,
  matchModel,
  pickerSections,
  pinPattern,
  pinnedModels,
  providerUsageBar,
  providerUsageLine,
  providerUsageTip,
  resetText,
  stateChip,
  tileLetters,
  togglePinned,
  visibleModels,
} from './model-picker';

const model = (provider: string, id: string, extra: Partial<ModelInfo> = {}): ModelInfo => ({
  provider,
  id,
  name: id,
  contextWindow: 200_000,
  reasoning: false,
  levels: ['off'],
  ...extra,
});
const MODELS: ModelInfo[] = [
  model('anthropic', 'claude-sonnet-5-5'),
  model('anthropic', 'claude-opus-5-5'),
  model('anthropic', 'claude-haiku-5-5'),
  model('openrouter', 'gpt-5.2'),
  model('google', 'gemini-3.5-flash'),
  model('llama-swap', 'gemma-4-26b'),
  model('mystery', 'x-1'),
];
const PROVIDERS: ModelProvider[] = [
  { id: 'anthropic', name: 'Anthropic', kind: 'subscription' },
  { id: 'openrouter', name: 'OpenRouter', kind: 'api-key' },
  { id: 'google', name: 'Google', kind: 'environment' },
  { id: 'llama-swap', name: 'llama-swap', kind: 'local', address: 'localhost:8080' },
];
const ref = (provider: string, id: string): ModelRef => ({ provider, id });

describe('matchModel', () => {
  it('matches a glob against provider/id, id and name', () => {
    expect(matchModel(MODELS[4], '*flash*')).toBe(true);
    expect(matchModel(MODELS[4], 'google/*')).toBe(true);
    expect(matchModel(MODELS[4], '*sonnet*')).toBe(false);
    expect(matchModel(MODELS[0], 'claude-*-5-5')).toBe(true);
  });
  it('matches plain text fuzzily and everything for an empty query', () => {
    expect(matchModel(MODELS[0], 'snt')).toBe(true);
    expect(matchModel(MODELS[0], 'zzz')).toBe(false);
    expect(matchModel(MODELS[0], '   ')).toBe(true);
  });
  it('does not treat regular-expression characters in a glob as syntax', () => {
    expect(matchModel(MODELS[3], 'gpt-5.2*')).toBe(true);
    expect(matchModel(MODELS[3], 'gpt-5x2*')).toBe(false);
  });
});

describe('pickerSections', () => {
  it('shows repeated provider/model references and repeated pins once using stable model identities', () => {
    const list = [MODELS[0], MODELS[0], MODELS[1], MODELS[1]];
    const sections = pickerSections(english, {
      models: list,
      providers: PROVIDERS,
      pinned: [ref(MODELS[0].provider, MODELS[0].id), ref(MODELS[0].provider, MODELS[0].id)],
      query: '',
    });
    expect(visibleModels(sections)).toEqual([MODELS[0], MODELS[1]]);
  });
  it('groups llama.cpp and named llama-swap connections without changing model routing or pins', () => {
    const local = [
      model('ds4', 'shared'),
      model('glm', 'shared'),
      model('llama.cpp', 'gemma'),
      model('ollama', 'llama-4'),
    ];
    const providers: ModelProvider[] = [
      { id: 'ds4', name: 'DeepSeek (llama-swap)', kind: 'local', address: 'localhost:8080' },
      { id: 'glm', name: 'GLM (llama-swap)', kind: 'local', address: 'localhost:8080' },
      { id: 'llama.cpp', name: 'llama.cpp', kind: 'local', address: 'localhost:8081' },
      { id: 'ollama', name: 'Ollama', kind: 'local', address: 'localhost:11434' },
    ];
    const grouped = pickerSections(english, { models: local, providers, pinned: [ref('ds4', 'shared')], query: '' });
    expect(grouped.map((section) => section.key)).toEqual(['pinned', 'provider:llama.cpp', 'provider:ollama']);
    expect(grouped[1]).toMatchObject({ title: 'llama.cpp', provider: { address: 'localhost:8080, localhost:8081' } });
    expect(visibleModels(grouped).map((model) => [model.provider, model.id])).toEqual(
      local.map((model) => [model.provider, model.id]),
    );
    const searched = pickerSections(english, { models: local, providers, pinned: [], query: 'llama.cpp' });
    expect(searched.map((section) => section.key)).toEqual(['provider:llama.cpp']);
    expect(searched[0].models).toEqual(local.slice(0, 3));
  });
  it('puts Pinned first in cycling order, then one section per provider without the pinned models', () => {
    const sections = pickerSections(english, {
      models: MODELS,
      providers: PROVIDERS,
      pinned: [ref('llama-swap', 'gemma-4-26b'), ref('anthropic', 'claude-opus-5-5')],
      query: '',
    });
    expect(sections.map((s) => s.key)).toEqual([
      'pinned',
      'provider:anthropic',
      'provider:openrouter',
      'provider:google',
      'provider:mystery',
    ]);
    expect(sections[0].models.map((m) => m.id)).toEqual(['gemma-4-26b', 'claude-opus-5-5']);
    expect(sections[1].models.map((m) => m.id)).toEqual(['claude-sonnet-5-5', 'claude-haiku-5-5']);
    expect(sections[1].provider?.kind).toBe('subscription');
  });
  it('keeps an empty Pinned section while nothing is typed, so the person sees what ⌘⇧M cycles', () => {
    const sections = pickerSections(english, { models: MODELS, providers: PROVIDERS, pinned: [], query: '' });
    expect(sections[0]).toMatchObject({ key: 'pinned', models: [] });
    expect(visibleModels(sections)).toHaveLength(MODELS.length);
  });
  it('hides every section without a match while searching, Pinned included', () => {
    const sections = pickerSections(english, {
      models: MODELS,
      providers: PROVIDERS,
      pinned: [ref('anthropic', 'claude-opus-5-5')],
      query: '*flash*',
    });
    expect(sections.map((s) => s.key)).toEqual(['provider:google']);
    const pinnedHit = pickerSections(english, {
      models: MODELS,
      providers: PROVIDERS,
      pinned: [ref('anthropic', 'claude-opus-5-5')],
      query: '*opus*',
    });
    expect(pinnedHit.map((s) => s.key)).toEqual(['pinned']);
  });
  it('lists a provider the backend did not describe after the described ones, and shows each model once', () => {
    const sections = pickerSections(english, {
      models: MODELS,
      providers: PROVIDERS,
      pinned: [ref('mystery', 'x-1')],
      query: '',
    });
    expect(sections.at(-1)?.key).not.toBe('provider:mystery');
    const all = visibleModels(sections).map((m) => `${m.provider}/${m.id}`);
    expect(new Set(all).size).toBe(all.length);
    const plain = pickerSections(english, { models: MODELS, providers: PROVIDERS, pinned: [], query: '' });
    expect(plain.at(-1)).toMatchObject({ key: 'provider:mystery', title: 'mystery' });
  });
  it('ignores a pin whose model is not available', () => {
    expect(
      pinnedModels(MODELS, [ref('anthropic', 'gone'), ref('google', 'gemini-3.5-flash')]).map((m) => m.id),
    ).toEqual(['gemini-3.5-flash']);
  });
});

describe('pinning', () => {
  it('adds a model at the end and removes one that is in', () => {
    const one = togglePinned([], MODELS[0]);
    expect(one).toEqual([ref('anthropic', 'claude-sonnet-5-5')]);
    const two = togglePinned(one, MODELS[4]);
    expect(two.map((r) => r.id)).toEqual(['claude-sonnet-5-5', 'gemini-3.5-flash']);
    expect(togglePinned(two, MODELS[0])).toEqual([ref('google', 'gemini-3.5-flash')]);
  });
  it('writes provider/id, with the thinking level suffix a pin carries', () => {
    expect(pinPattern(ref('anthropic', 'claude-opus-5-5'))).toBe('anthropic/claude-opus-5-5');
    expect(pinPattern({ provider: 'anthropic', id: 'claude-opus-5-5', thinkingLevel: 'high' })).toBe(
      'anthropic/claude-opus-5-5:high',
    );
  });
});

describe('section heading', () => {
  it('names the state chip and the tile', () => {
    expect(stateChip(english, 'subscription')).toBe('subscription');
    expect(stateChip(english, 'api-key')).toBe('API key');
    expect(stateChip(english, 'environment')).toBe('env');
    expect(stateChip(english, 'local')).toBe('local');
    expect(stateChip(english, 'other')).toBeUndefined();
    expect(tileLetters('Anthropic')).toBe('A');
    expect(tileLetters('OpenRouter')).toBe('OR');
    expect(tileLetters('llama-swap')).toBe('L');
  });
});

describe('usage words', () => {
  const sub = {
    windows: [
      { name: '5 h', used: 38, resets: '2026-10-17T14:30:00' },
      { name: 'week', used: 12.4 },
      { name: 'Opus week', used: 3 },
    ],
  };
  it('reads "38 % of 5 h · 12 % of week" and shows the credit', () => {
    expect(providerUsageLine(english, sub)).toBe('38 % of 5 h · 12 % of week');
    expect(providerUsageLine(english, { windows: [], credit: '$41.20' })).toBe('credit $41.20');
    expect(providerUsageLine(english, null)).toBe('');
    expect(providerUsageLine(english, undefined)).toBe('');
  });
  it('bars the first window and warns from 80 %', () => {
    expect(providerUsageBar(sub)).toEqual({ used: 38, warn: false });
    expect(providerUsageBar({ windows: [{ name: '5 h', used: 80 }] })).toEqual({ used: 80, warn: true });
    expect(providerUsageBar({ windows: [], credit: '$1.00' })).toBeUndefined();
  });
  it('lists every window with its reset time in the tooltip', () => {
    const now = new Date('2026-10-17T09:00:00');
    expect(resetText('2026-10-17T14:30:00', now)).toBe('14:30');
    expect(resetText('2026-10-22T09:00:00', now)).toMatch(/^\w{3} 09:00$/);
    expect(resetText('garbage', now)).toBe('');
    expect(providerUsageTip(english, sub, now)).toBe('5 h 38 %, resets 14:30 · week 12 % · Opus week 3 %');
    expect(providerUsageTip(english, { windows: [], credit: '$41.20' }, now)).toBe('credit left $41.20');
  });
});

describe('the effort flask', () => {
  it('fills 0 / 30 / 50 / 65 / 80 percent for off / low / medium / high / xhigh', () => {
    expect([FLASK_FILL.off, FLASK_FILL.low, FLASK_FILL.medium, FLASK_FILL.high, FLASK_FILL.xhigh]).toEqual([
      0, 30, 50, 65, 80,
    ]);
    expect(FLASK_FILL.minimal).toBeGreaterThan(0);
    expect(FLASK_FILL.minimal).toBeLessThan(FLASK_FILL.low);
    expect(FLASK_FILL.max).toBe(100);
  });
  it('strokes muted when off, plain for low and medium, primary from high', () => {
    expect(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map((l) => flaskStroke(l as never))).toEqual([
      'muted',
      'base',
      'base',
      'base',
      'primary',
      'primary',
      'primary',
    ]);
  });
});
