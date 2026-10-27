import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AttendantModel, type ModelChoice } from './attendant-model';

// The backend loads pi through a native `import()` that a test runner's sandbox does not offer. That load is the first step of a request's setup: `onLoad` lets a test act during it.
const loading = vi.hoisted(() => ({ count: 0, onLoad: undefined as (() => void) | undefined }));
vi.mock('../pi/load-pi', () => ({
  loadPi: async () => {
    loading.count += 1;
    loading.onLoad?.();
    return import('@earendil-works/pi-coding-agent');
  },
}));

const { startFakeModel } = await import(new URL('../../../../e2e/support/fake-model.mjs', import.meta.url).href);

const prompt = { system: 'Answer briefly.', user: 'What is 2 + 2?' };
const choice: ModelChoice = { provider: 'fixture', id: 'local', price: 0, reasoning: false };

let base: string;
let model: AttendantModel;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'pk-attendant-model-'));
  const agent = join(base, 'agent');
  mkdirSync(agent, { recursive: true });
  // A provider pi can select but never reach: a request that got as far as the model would fail on the connection, not on its abort.
  writeFileSync(join(agent, 'models.json'), JSON.stringify({ providers: { fixture: { baseUrl: 'http://127.0.0.1:1/v1', api: 'openai-completions', apiKey: 'fixture', models: [{ id: 'local', contextWindow: 8192 }] } } }));
  vi.stubEnv('PI_CODING_AGENT_DIR', agent);
  vi.stubEnv('PI_OFFLINE', '1');
  loading.count = 0;
  loading.onLoad = undefined;
  model = new AttendantModel({ defaultCwd: base });
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(base, { recursive: true, force: true });
});

it('a signal that is aborted already makes no request: pi is not even loaded, and nothing is counted', async () => {
  const caller = new AbortController();
  caller.abort();
  await expect(model.ask(prompt, choice, caller.signal)).rejects.toThrow(/aborted/);
  expect(model.calls).toBe(0);
  expect(loading.count).toBe(0);
});

it('an abort that lands while pi sets the session up ends the request before anything is sent', async () => {
  const caller = new AbortController();
  loading.onLoad = () => caller.abort();
  await expect(model.ask(prompt, choice, caller.signal)).rejects.toThrow(/aborted/);
  expect(model.calls).toBe(1);
}, 15_000);


it('aborting an HTTP request in flight reports cancellation, and a later request can still answer', async () => {
  let enter!: () => void;
  let release!: (text: string) => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const held = new Promise<string>((resolve) => { release = resolve; });
  const server = await startFakeModel({ answer: () => { enter(); return held; } });
  writeFileSync(join(base, 'agent', 'models.json'), JSON.stringify({ providers: { fixture: { baseUrl: server.url, api: 'openai-completions', apiKey: 'fixture', models: [{ id: 'local', contextWindow: 8192 }] } } }));
  const caller = new AbortController();
  const pending = model.ask(prompt, choice, caller.signal);
  const outcome = pending.then(() => undefined, (error: unknown) => error);
  try {
    await Promise.race([entered, outcome.then((error) => { throw error ?? new Error('Answered before the server was released.'); })]);
    caller.abort();
    await expect(pending).rejects.toThrow('The model request was aborted.');
    release('4');
    expect(await model.ask(prompt, choice)).toMatchObject({ text: '4', model: 'fixture/local' });
    expect(server.requests).toHaveLength(2);
  } finally {
    caller.abort();
    release('4');
    await outcome;
    await server.stop();
  }
}, 15_000);
