import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { LiteLlmService } from '../setup/litellm.service';
import { PiPluginService } from './pi-plugin.service';
import { PiSessionService, QueueStaleError } from './pi-session.service';
import { TrustService } from './trust.service';

// The installed SDK queues and delivers messages; the shared HTTP fixture only answers model requests.
vi.mock('./load-pi', () => ({
  loadPi: () => import('@earendil-works/pi-coding-agent'),
  loadPiMcp: () => import('@earendil-works/pi-mcp'),
}));
const { startFakeModel } = await import(new URL('../../../../e2e/support/fake-model.mjs', import.meta.url).href);

let base: string;
let sessions: PiSessionService;
let id: string;
let model: { url: string; requests: unknown[]; stop(): Promise<void> };
const image = { mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=' };
const secondImage = { mimeType: 'image/gif', data: 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7' };
interface UserMessage {
  role: string;
  content: string | { type: string; text?: string; image_url?: { url: string } }[];
}
const delivered = () => (model.requests.at(-1) as { messages: UserMessage[] }).messages.filter((message) => message.role === 'user');
const imagesOf = (message: UserMessage) => typeof message.content === 'string' ? [] : message.content.filter((part) => part.type === 'image_url').map((part) => part.image_url?.url);
const textOf = (message: UserMessage) => typeof message.content === 'string' ? message.content : message.content.filter((part) => part.type === 'text').map((part) => part.text).join('');
const imageUrl = `data:image/png;base64,${image.data}`;
/** Whether `promise` settles before the next macrotask: a queue edit, or a message no extension holds, waits for nothing but microtasks. */
const settlesNow = (promise: Promise<unknown>): Promise<boolean> =>
  Promise.race([promise.then(() => true, () => true), new Promise<boolean>((resolve) => setImmediate(() => resolve(false)))]);

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), 'pk-session-queue-'));
  const agent = join(base, 'agent');
  mkdirSync(agent);
  mkdirSync(join(agent, 'prompts'));
  writeFileSync(join(agent, 'prompts', 'picture.md'), 'Expanded picture');
  // An input extension that asks before it lets a message through, the way one that confirms or looks something up holds every send.
  mkdirSync(join(agent, 'extensions'));
  writeFileSync(join(agent, 'extensions', 'hold.ts'), `
    export default function (pi) {
      pi.on('input', async (event, ctx) => {
        if (event.source !== 'interactive' || !event.text.startsWith('Hold')) return { action: 'continue' };
        return (await ctx.ui.confirm('Send it?', event.text)) ? { action: 'continue' } : { action: 'handled' };
      });
    }
  `);
  vi.stubEnv('PI_CODING_AGENT_DIR', agent);
  vi.stubEnv('PI_OFFLINE', '1');
  model = await startFakeModel({ answer: () => 'Done.' });
  writeFileSync(join(agent, 'models.json'), JSON.stringify({ providers: { fixture: {
    baseUrl: model.url, api: 'openai-completions', apiKey: 'fixture',
    models: [{ id: 'queue', input: ['text', 'image'], contextWindow: 8192 }],
  } } }));
  writeFileSync(join(agent, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'queue' }));
  sessions = new PiSessionService(new TrustService(), new PiPluginService(), { refreshCatalog: async () => undefined } as unknown as LiteLlmService);
  id = randomUUID();
  await sessions.open(id, { cwd: base });
});

afterEach(async () => {
  sessions?.onModuleDestroy();
  await model?.stop();
  vi.unstubAllEnvs();
  rmSync(base, { recursive: true, force: true });
});

it.each(['plain', 'template'])('preserves a retained %s message image when another queued message is removed', async (kind) => {
  const text = kind === 'template' ? '/picture' : 'Keep this picture';
  const queued = kind === 'template' ? 'Expanded picture' : text;
  await sessions.steer(id, text, [image]);
  await sessions.steer(id, 'Remove this message');
  expect(await sessions.removeQueued(id, { kind: 'steer', index: 1, text: 'Remove this message' })).toEqual({ steering: [queued], followUp: [] });
  await sessions.prompt(id, 'Begin.');
  expect(delivered().flatMap(imagesOf)).toEqual([imageUrl]);
  expect(JSON.stringify(sessions.openTree(id))).toContain(image.data);
});

it.each(['steer', 'followUp'] as const)('merges %s text and images in delivery order instead of dropping attachments', async (kind) => {
  await sessions[kind](id, 'First picture', [image]);
  await sessions.followUp(id, 'Then this instruction', [secondImage]);
  const text = 'First picture\n\nThen this instruction';
  expect(await sessions.mergeQueued(id)).toEqual(kind === 'steer' ? { steering: [text], followUp: [] } : { steering: [], followUp: [text] });
  await sessions.prompt(id, 'Begin.');
  expect(delivered().flatMap(imagesOf)).toEqual([imageUrl, `data:image/gif;base64,${secondImage.data}`]);
  expect(JSON.stringify(sessions.openTree(id))).toContain(image.data);
});

it('keeps distinct attachments on repeated text while editing another queue item', async () => {
  await sessions.steer(id, 'Same text');
  await sessions.steer(id, 'Same text', [image]);
  await sessions.followUp(id, 'Remove this');
  await sessions.removeQueued(id, { kind: 'followUp', index: 0, text: 'Remove this' });
  await sessions.prompt(id, 'Begin.');
  expect(delivered().slice(1).map(imagesOf)).toEqual([[], [imageUrl]]);
});

it('does not attach a delivered picture to a later message with the same text', async () => {
  await sessions.steer(id, 'Same text', [image]);
  await sessions.prompt(id, 'First turn.');
  expect(imagesOf(delivered().at(-1)!)).toEqual([imageUrl]);
  await sessions.steer(id, 'Same text');
  await sessions.followUp(id, 'Remove this');
  await sessions.removeQueued(id, { kind: 'followUp', index: 0, text: 'Remove this' });
  await sessions.prompt(id, 'Second turn.');
  expect(imagesOf(delivered().at(-1)!)).toEqual([]);
});

it('clears the queue while an input extension holds a message, which then queues with its picture once the extension lets it through', async () => {
  await sessions.steer(id, 'Alpha');
  const asked = new Promise<void>((resolve) => sessions.onDialogRequested(id, resolve));
  const held = sessions.steer(id, 'Hold this picture', [image]);
  try {
    await asked;
    const [dialog] = sessions.pendingDialogs(id);
    expect(dialog?.request).toMatchObject({ method: 'confirm', title: 'Send it?' });
    // The held message is not in pi's queue yet: a message sent after it passes it, and the clear has nothing to wait for.
    const later = sessions.steer(id, 'Bravo');
    expect(await settlesNow(later)).toBe(true);
    expect(await later).toBe('queued');
    expect(sessions.queue(id)).toEqual({ steering: ['Alpha', 'Bravo'], followUp: [] });
    const cleared = sessions.clearQueued(id);
    expect(await settlesNow(cleared)).toBe(true);
    expect(await cleared).toEqual({ steering: [], followUp: [] });
    expect(sessions.pendingDialogs(id).map((pending) => pending.id)).toEqual([dialog!.id]);
  } finally {
    // The extension gets its answer whatever happened above, so a failing run does not leave pi holding the message.
    for (const dialog of sessions.pendingDialogs(id)) sessions.answerDialog(id, dialog.id, { status: 'resolved', confirmed: true });
  }
  expect(await held).toBe('queued');
  expect(sessions.queue(id)).toEqual({ steering: ['Hold this picture'], followUp: [] });
  // Removing another message rebuilds pi's queue from the mirror: the held message keeps the picture it queued with, nothing else gets it.
  await sessions.followUp(id, 'Charlie');
  await sessions.steer(id, 'Delta');
  expect(await sessions.removeQueued(id, { kind: 'steer', index: 1, text: 'Delta' })).toEqual({ steering: ['Hold this picture'], followUp: ['Charlie'] });
  await sessions.prompt(id, 'Begin.');
  expect(delivered().map((message) => [textOf(message), imagesOf(message)])).toEqual([['Begin.', []], ['Hold this picture', [imageUrl]], ['Charlie', []]]);
});

it('serializes edits and incoming messages, rejects a stale target and keeps later operations usable', async () => {
  await sessions.steer(id, 'Alpha');
  await sessions.steer(id, 'Bravo');
  await sessions.followUp(id, 'Charlie');
  const target = { kind: 'followUp' as const, index: 0, text: 'Charlie' };
  const outcomes = await Promise.allSettled([sessions.promoteQueued(id, target), sessions.removeQueued(id, target), sessions.steer(id, 'Delta')]);
  expect(outcomes[0]).toEqual({ status: 'fulfilled', value: { steering: ['Alpha', 'Bravo', 'Charlie'], followUp: [] } });
  expect(outcomes[1]).toMatchObject({ status: 'rejected', reason: expect.any(QueueStaleError) });
  expect(outcomes[2]).toEqual({ status: 'fulfilled', value: 'queued' });
  expect(await sessions.removeQueued(id, { kind: 'steer', index: 1, text: 'Bravo' })).toEqual({ steering: ['Alpha', 'Charlie', 'Delta'], followUp: [] });
  expect(await sessions.clearQueued(id)).toEqual({ steering: [], followUp: [] });
  expect(sessions.queue('closed-thread')).toEqual({ steering: [], followUp: [] });
});
