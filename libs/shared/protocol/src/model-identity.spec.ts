import { describe, expect, it } from 'vitest';
import { modelIdentity } from './model-identity';

describe('model identity', () => {
  it('has a stable hash for the exact provider and model strings', () => {
    expect(modelIdentity('llama-swap', 'org/model:Q4_K_M')).toBe('model-4a364786426f8f21');
    expect(modelIdentity('litellm', 'org/model:Q4_K_M')).not.toBe(modelIdentity('llama-swap', 'org/model:Q4_K_M'));
    expect(modelIdentity('llama-swap', 'org/model:Q8_0')).not.toBe(modelIdentity('llama-swap', 'org/model:Q4_K_M'));
  });
  it('does not confuse tuple boundaries, punctuation or Unicode', () => {
    const identities = [['a/b', 'c'], ['a', 'b/c'], ['a', 'b_c'], ['a', '模型'], ['a', '模型2'], ['a\0b', 'c'], ['a', 'b\0c']].map(([provider, model]) => modelIdentity(provider, model));
    expect(new Set(identities).size).toBe(identities.length);
  });
});
