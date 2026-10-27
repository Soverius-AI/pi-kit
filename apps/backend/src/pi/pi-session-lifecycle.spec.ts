import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiteLlmService } from '../setup/litellm.service';
import { PiPluginService, type PluginReplyShape } from './pi-plugin.service';
import { PLUGIN_CHANNELS, replyChannel } from '@pi-kit/protocol';
import { PiSessionService } from './pi-session.service';
import { TrustService } from './trust.service';

// Vitest's VM cannot execute the managed-install loader's native dynamic import.
// Resolve the real installed SDK at that adapter boundary; session behavior stays real.
vi.mock('./load-pi', () => ({
  loadPi: () => import('@earendil-works/pi-coding-agent'),
  loadPiMcp: () => import('@earendil-works/pi-mcp'),
}));

afterEach(() => vi.unstubAllEnvs());

it('rejects a session which finishes opening after shutdown instead of retaining it', async () => {
  const base = mkdtempSync(join(tmpdir(), 'pk-session-shutdown-'));
  vi.stubEnv('PI_CODING_AGENT_DIR', base);
  vi.stubEnv('PI_OFFLINE', '1');
  let enter!: () => void;
  let release!: (trusted: boolean) => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const trust = { resolveForOpen: () => { enter(); return new Promise<boolean>((resolve) => { release = resolve; }); } } as unknown as TrustService;
  const sessions = new PiSessionService(trust, new PiPluginService(), { refreshCatalog: async () => undefined } as unknown as LiteLlmService);
  const id = randomUUID();
  try {
    const opening = sessions.open(id, { cwd: base });
    const outcome = opening.then(() => undefined, (error: unknown) => error);
    await Promise.race([entered, outcome.then((error) => { throw error ?? new Error('Opened before trust was answered.'); })]);
    sessions.onModuleDestroy();
    release(false);
    expect(await outcome).toMatchObject({ message: 'The backend is shutting down.' });
    expect(sessions.has(id)).toBe(false);
    await expect(sessions.open(randomUUID(), { cwd: base })).rejects.toThrow('shutting down');
  } finally {
    sessions.onModuleDestroy();
    rmSync(base, { recursive: true, force: true });
  }
}, 15_000);


describe('open session ownership', () => {
  let base: string;
  let sessions: PiSessionService;
  let trust: TrustService;
  let plugins: PiPluginService;
  let starts: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'pk-session-ownership-'));
    const agent = join(base, 'agent');
    mkdirSync(join(agent, 'extensions'), { recursive: true });
    starts = join(base, 'starts.jsonl');
    writeFileSync(starts, '');
    writeFileSync(join(agent, 'extensions', 'lifecycle.ts'), `
      import { appendFileSync } from 'node:fs';
      export default function (pi) {
        pi.on('session_start', (_event, ctx) => appendFileSync(${JSON.stringify(starts)}, ctx.sessionManager.getSessionId() + '\\n'));
      }
    `);
    writeFileSync(join(agent, 'models.json'), JSON.stringify({ providers: { fixture: {
      baseUrl: 'http://127.0.0.1:1/v1', api: 'openai-completions', apiKey: 'fixture', models: [{ id: 'local', contextWindow: 8192 }],
    } } }));
    writeFileSync(join(agent, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'local' }));
    vi.stubEnv('PI_CODING_AGENT_DIR', agent);
    vi.stubEnv('PI_OFFLINE', '1');
    trust = new TrustService();
    plugins = new PiPluginService();
    sessions = new PiSessionService(trust, plugins, { refreshCatalog: async () => undefined } as unknown as LiteLlmService);
  });

  afterEach(() => {
    sessions.onModuleDestroy();
    plugins.onModuleDestroy();
    rmSync(base, { recursive: true, force: true });
  });

  const started = (path: string, id: string): number => readFileSync(path, 'utf8').split('\n').filter((value) => value === id).length;

  it('shares concurrent opens, disposes one session independently and initializes it again on reopen', async () => {
    const id = randomUUID();
    const other = randomUUID();
    const opened = await Promise.all([sessions.open(id, { cwd: base }), sessions.open(id, { cwd: base })]);
    expect(opened.map((info) => info.sessionId)).toEqual([id, id]);
    expect(started(starts, id)).toBe(1);
    await sessions.open(other, { cwd: base });
    sessions.dispose(id);
    expect(sessions.has(id)).toBe(false);
    expect(sessions.stats(other).sessionId).toBe(other);
    await sessions.open(id, { cwd: base });
    expect(started(starts, id)).toBe(2);
    expect(started(starts, other)).toBe(1);
  });

  it.each([
    { how: 'closing', end: (id: string): void | Promise<void> => sessions.dispose(id), reason: { ok: false, code: 'failed', error: 'The session closed before pi-kit answered.' }, stays: false },
    { how: 'stopping', end: (id: string): void | Promise<void> => sessions.abort(id), reason: { ok: false, code: 'failed', error: 'The request was cancelled before pi-kit answered.' }, stays: true },
  ])('$how a session aborts and answers the plugin work its real SDK extension command started', async ({ end, reason, stays }) => {
    // `/probe <requestId>` asks pi-kit over the session's bus the way /score and /learn do, keeps the answer in a file, and ends when it has it.
    const replies = join(base, 'plugin-replies');
    mkdirSync(replies);
    writeFileSync(join(base, 'agent', 'extensions', 'plugin-probe.ts'), `
      import { writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      export default function (pi) {
        pi.registerCommand('probe', {
          description: 'Asks pi-kit and keeps its answer',
          handler: (requestId) => new Promise((done) => {
            const off = pi.events.on(${JSON.stringify(replyChannel(PLUGIN_CHANNELS.attendant))}, (value) => {
              if (value.requestId !== requestId) return;
              off();
              writeFileSync(join(${JSON.stringify(replies)}, requestId + '.json'), JSON.stringify(value));
              done();
            });
            pi.events.emit(${JSON.stringify(PLUGIN_CHANNELS.attendant)}, { requestId });
          }),
        });
      }
    `);
    const signals = new Map<string, AbortSignal | undefined>();
    let heard!: () => void;
    let release: ((reply: PluginReplyShape) => void) | undefined;
    const requested = new Promise<void>((resolve) => { heard = resolve; });
    plugins.register([PLUGIN_CHANNELS.attendant], (_thread, _channel, payload, signal) => {
      const { requestId } = payload as { requestId: string };
      signals.set(requestId, signal);
      heard();
      // The first request is held like a model call; any later one is answered at once.
      if (requestId === 'first') return new Promise((resolve) => { release = resolve; });
      return Promise.resolve({ requestId, ok: true });
    });
    try {
      const id = randomUUID();
      await sessions.open(id, { cwd: base });
      const first = sessions.prompt(id, '/probe first');
      await requested;
      expect(signals.get('first')?.aborted).toBe(false);
      await end(id);
      expect(signals.get('first')?.aborted).toBe(true);
      // The command got its answer, so the prompt that ran it is over.
      await first;
      expect(JSON.parse(readFileSync(join(replies, 'first.json'), 'utf8'))).toEqual({ requestId: 'first', ...reason });
      expect(sessions.has(id)).toBe(stays);
      if (stays) {
        // The same session goes on: its next request is served with a signal the stop never touched, and completes.
        await sessions.prompt(id, '/probe second');
        expect(signals.get('second')?.aborted).toBe(false);
        expect(JSON.parse(readFileSync(join(replies, 'second.json'), 'utf8'))).toEqual({ requestId: 'second', ok: true });
      }
    } finally { release?.({ requestId: 'first', ok: true }); }
  });

  it('allows retry after a trust-loader failure instead of retaining the rejected open', async () => {
    const id = randomUUID();
    vi.spyOn(trust, 'resolveForOpen').mockRejectedValueOnce(new Error('Trust unavailable.')).mockResolvedValue(false);
    await expect(sessions.open(id, { cwd: base })).rejects.toThrow('Trust unavailable.');
    expect(sessions.has(id)).toBe(false);
    expect((await sessions.open(id, { cwd: base })).sessionId).toBe(id);
    expect(sessions.has(id)).toBe(true);
    expect(started(starts, id)).toBe(1);
  });
});
