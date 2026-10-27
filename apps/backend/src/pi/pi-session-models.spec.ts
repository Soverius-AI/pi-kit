import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { LiteLlmService } from '../setup/litellm.service';
import { PiPluginService } from './pi-plugin.service';
import { PiSessionService } from './pi-session.service';
import { TrustService } from './trust.service';

// Use the installed SDK through Vitest's loader; model listing and selection perform no inference.
vi.mock('./load-pi', () => ({
  loadPi: () => import('@earendil-works/pi-coding-agent'),
  loadPiMcp: () => import('@earendil-works/pi-mcp'),
}));

let base: string;
let agent: string;
let sessions: PiSessionService;
let threadId: string;
const settings = (enabledModels: string[]) => ({ defaultProvider: 'fixture', defaultModel: 'plain', enabledModels });

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), 'pk-session-models-'));
  agent = join(base, 'agent');
  mkdirSync(agent);
  vi.stubEnv('PI_CODING_AGENT_DIR', agent);
  vi.stubEnv('PI_OFFLINE', '1');
  writeFileSync(join(agent, 'models.json'), JSON.stringify({ providers: { fixture: {
    baseUrl: 'http://127.0.0.1:1/v1', api: 'openai-completions', apiKey: 'fixture',
    models: [
      { id: 'plain', name: 'Plain', reasoning: false, contextWindow: 8192 },
      { id: 'reasoning', name: 'Reasoning', reasoning: true, contextWindow: 32768 },
      { id: 'backup', name: 'Backup', reasoning: false, contextWindow: 16384 },
    ],
  } } }));
  writeFileSync(join(agent, 'settings.json'), JSON.stringify(settings(['fixture/plain', 'fixture/reasoning'])));
  sessions = new PiSessionService(new TrustService(), new PiPluginService(), { refreshCatalog: async () => undefined } as unknown as LiteLlmService);
  threadId = randomUUID();
  await sessions.open(threadId, { cwd: base });
});

afterEach(() => {
  sessions?.onModuleDestroy();
  vi.unstubAllEnvs();
  rmSync(base, { recursive: true, force: true });
});

it('refreshes persisted model pins for the picker and keyboard cycling in an open session', async () => {
  const initial = await sessions.models(threadId);
  expect(initial.current).toEqual({ provider: 'fixture', id: 'plain' });
  expect(initial.pinned.map((model) => model.id)).toEqual(['plain', 'reasoning']);
  expect(initial.models.find((model) => model.id === 'plain')).toMatchObject({ default: true, pinned: true, levels: ['off'] });
  await sessions.cycle(threadId, { target: 'model' });
  expect(sessions.stats(threadId).model?.id).toBe('reasoning');
  writeFileSync(join(agent, 'settings.json'), JSON.stringify(settings(['fixture/reasoning', 'fixture/backup'])));
  const updated = await sessions.models(threadId);
  expect(updated.pinned.map((model) => model.id)).toEqual(['reasoning', 'backup']);
  expect(updated.models.find((model) => model.id === 'plain')?.pinned).toBeUndefined();
  await sessions.cycle(threadId, { target: 'model' });
  expect(sessions.stats(threadId).model?.id).toBe('backup');
});

it('selects a model and effort, preserves them on an invalid selection, and resolves context windows', async () => {
  await sessions.setModel(threadId, { provider: 'fixture', modelId: 'reasoning', thinkingLevel: 'medium' });
  expect(sessions.stats(threadId)).toMatchObject({ model: { id: 'reasoning' }, thinkingLevel: 'medium', contextWindow: 32768 });
  const choices = await sessions.models(threadId);
  expect(choices.thinkingLevels).toContain('medium');
  expect(choices.models.find((model) => model.id === 'reasoning')?.levels).toContain('medium');
  await expect(sessions.setModel(threadId, { provider: 'fixture', modelId: 'missing' })).rejects.toThrow('Unknown model fixture/missing');
  expect(sessions.stats(threadId)).toMatchObject({ model: { id: 'reasoning' }, thinkingLevel: 'medium' });
  expect(sessions.contextWindowLookup(threadId)('fixture', 'plain')).toBe(8192);
  expect(await sessions.modelWindow('fixture', 'reasoning')).toBe(32768);
  expect(await sessions.modelWindow('fixture', 'missing')).toBeUndefined();
});
