import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { it } from 'node:test';

// Observe the actual scratch files in a fresh process, just as the E2E runner imports its environment.
const worldFiles = (modelId = '') => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import {readFileSync} from 'node:fs';
    import {join} from 'node:path';
    import {createWorld} from './e2e/support/env.mjs';
    const world = createWorld();
    try {
      const settings = JSON.parse(readFileSync(join(world.agent, 'settings.json'), 'utf8'));
      const models = JSON.parse(readFileSync(join(world.agent, 'models.json'), 'utf8'));
      console.log(JSON.stringify({settings, provider: models.providers['llama-swap']}));
    } finally { world.dispose(); }
  `], { encoding: 'utf8', cwd: new URL('..', import.meta.url), env: {
    ...process.env, E2E_MODEL_ID: modelId, E2E_MODEL_NAME: '', E2E_MODEL_URL: 'http://127.0.0.1:8080/v1',
  } });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
};

it('preserves the default scratch model and the distinct model-picker fixtures', () => {
  const { settings, provider } = worldFiles();
  assert.equal(settings.defaultProvider, 'llama-swap');
  assert.equal(settings.defaultModel, 'gemma-4-26b');
  assert.deepEqual(provider.models.map((model) => model.id), ['gemma-4-26b', 'llama3.2', 'qwen3.8-27b']);
});

it('keeps the scratch model names whatever real model answers them (the e2e runner proxies them to it)', () => {
  const { settings, provider } = worldFiles('user-selected-27b');
  assert.equal(settings.defaultModel, 'gemma-4-26b');
  assert.equal(provider.baseUrl, 'http://127.0.0.1:8080/v1');
  assert.deepEqual(settings.enabledModels, ['llama-swap/gemma-4-26b', 'llama-swap/llama3.2']);
  assert.deepEqual(provider.models.map((model) => model.id), ['gemma-4-26b', 'llama3.2', 'qwen3.8-27b']);
});
