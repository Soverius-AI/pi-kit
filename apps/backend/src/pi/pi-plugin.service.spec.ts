import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { EventBusController } from '@earendil-works/pi-coding-agent' with { 'resolution-mode': 'import' };
import { PLUGIN_CHANNELS, replyChannel } from '@pi-kit/protocol';
import { describe, expect, it, vi } from 'vitest';
import { PiPluginService, type PluginHost, type PluginReplyShape } from './pi-plugin.service';

const sdk = () => import('@earendil-works/pi-coding-agent');
/** Lets the host's deferred work, and every promise chain behind it, run to the end. */
const flush = (): Promise<void> => new Promise((done) => setImmediate(done));
const CLOSED = { ok: false, code: 'failed', error: 'The session closed before pi-kit answered.' };
const CANCELLED = { ok: false, code: 'failed', error: 'The request was cancelled before pi-kit answered.' };

/** The two ways a session's open requests end while pi-kit runs on: the session closes (unbound), or the person stops it (it stays bound). */
const ends = [
  { how: 'closing', end: (plugins: PiPluginService) => plugins.unbind('chat'), reason: CLOSED },
  { how: 'stopping', end: (plugins: PiPluginService) => plugins.cancel('chat'), reason: CANCELLED },
];

/** A host that answers nothing until `release`, and keeps the signal each request was given. */
function heldHost(): { host: PluginHost; signals: (AbortSignal | undefined)[]; release: (reply: PluginReplyShape) => void } {
  const signals: (AbortSignal | undefined)[] = [];
  let release: (reply: PluginReplyShape) => void = () => undefined;
  const host: PluginHost = (_thread, _channel, _payload, signal) => {
    signals.push(signal);
    return new Promise((done) => {
      release = done;
    });
  };
  return { host, signals, release: (reply) => release(reply) };
}

const repliesOn = (bus: EventBusController, channel: string): unknown[] => {
  const seen: unknown[] = [];
  bus.on(replyChannel(channel), (reply) => void seen.push(reply));
  return seen;
};

describe('plugin channel ownership', () => {
  it('routes through the latest channel owner and a stale unregister cannot remove its replacement', async () => {
    const { createEventBus } = await sdk();
    const bus = createEventBus();
    const plugins = new PiPluginService();
    const host = (name: string): PluginHost => async (_thread, _channel, payload) => ({ requestId: (payload as { requestId: string }).requestId, ok: true, name });
    plugins.setDefault(host('default'));
    plugins.bind('chat', bus);
    const unregisterOld = plugins.register([PLUGIN_CHANNELS.outcome], host('old'));
    const unregisterNew = plugins.register([PLUGIN_CHANNELS.outcome], host('new'));
    unregisterOld();
    const ask = (id: string) => new Promise<unknown>((done) => {
      const off = bus.on(replyChannel(PLUGIN_CHANNELS.outcome), (reply) => { off(); done(reply); });
      bus.emit(PLUGIN_CHANNELS.outcome, { requestId: id });
    });
    expect(await ask('one')).toEqual({ requestId: 'one', ok: true, name: 'new' });
    unregisterNew();
    expect(await ask('two')).toEqual({ requestId: 'two', ok: true, name: 'default' });
    plugins.setDefault(() => { throw new Error('Host failed synchronously'); });
    expect(await ask('three')).toEqual({ requestId: 'three', ok: false, code: 'failed', error: 'pi-kit could not answer the request.' });
    plugins.onModuleDestroy();
    bus.clear();
  });
});

describe('a session’s binding', () => {
  it.each([
    { how: 'unbinding the session', end: (plugins: PiPluginService) => plugins.unbind('chat'), reason: CLOSED, next: 'no owner' },
    { how: 'the backend quitting', end: (plugins: PiPluginService) => plugins.onModuleDestroy(), reason: CLOSED, next: 'no owner' },
    { how: 'stopping the session', end: (plugins: PiPluginService) => plugins.cancel('chat'), reason: CANCELLED, next: 'a signal of its own' },
  ])('$how aborts the request in flight, answers it as failed on its reply channel, keeps the host’s late answer off the bus, and the next request has $next', async ({ end, reason, next }) => {
    const { createEventBus } = await sdk();
    const bus = createEventBus();
    const plugins = new PiPluginService();
    const held = heldHost();
    plugins.register([PLUGIN_CHANNELS.attendant], held.host);
    plugins.bind('chat', bus);
    const replies = repliesOn(bus, PLUGIN_CHANNELS.attendant);
    bus.emit(PLUGIN_CHANNELS.attendant, { requestId: 'one' });
    await flush();
    expect(held.signals.map((signal) => signal?.aborted)).toEqual([false]);
    end(plugins);
    expect(held.signals[0]?.aborted).toBe(true);
    expect(replies).toEqual([{ requestId: 'one', ...reason }]);
    held.release({ requestId: 'one', ok: true, text: 'late' });
    await flush();
    expect(replies).toHaveLength(1);
    bus.emit(PLUGIN_CHANNELS.attendant, { requestId: 'two' });
    await flush();
    if (next === 'no owner') {
      // Nothing of the ended session is listened to: a further request has no owner and no answer.
      expect(held.signals).toHaveLength(1);
      expect(replies).toHaveLength(1);
    } else {
      // The stopped session stays bound: its next request is served with a signal the stop never touched, and its answer reaches the bus.
      expect(held.signals.map((signal) => signal?.aborted)).toEqual([true, false]);
      held.release({ requestId: 'two', ok: true });
      await flush();
      expect(replies).toEqual([{ requestId: 'one', ...reason }, { requestId: 'two', ok: true }]);
    }
    plugins.onModuleDestroy();
    bus.clear();
  });

  it.each(ends.flatMap((end) => ['before host dispatch', 'during acceptance'].map((when) => ({ ...end, when }))))('$how the session $when answers the request without starting its work', async ({ when, end, reason }) => {
    const bus = (await sdk()).createEventBus();
    const plugins = new PiPluginService();
    let calls = 0;
    plugins.register([PLUGIN_CHANNELS.attendant], async (_thread, _channel, payload) => { calls += 1; return { requestId: (payload as { requestId: string }).requestId, ok: true }; });
    plugins.bind('chat', bus);
    const replies = repliesOn(bus, PLUGIN_CHANNELS.attendant);
    if (when === 'during acceptance') {
      const off = bus.on(`${PLUGIN_CHANNELS.attendant}:accepted`, () => { off(); end(plugins); });
    }
    try {
      bus.emit(PLUGIN_CHANNELS.attendant, { requestId: 'queued' });
      if (when === 'before host dispatch') end(plugins);
      await flush();
      expect(calls).toBe(0);
      expect(replies).toEqual([{ requestId: 'queued', ...reason }]);
      if (reason === CANCELLED) {
        // A stop that lands inside the acceptance leaves the binding whole: the next request is served and answered once.
        bus.emit(PLUGIN_CHANNELS.attendant, { requestId: 'next' });
        await flush();
        expect(calls).toBe(1);
        expect(replies).toEqual([{ requestId: 'queued', ...reason }, { requestId: 'next', ok: true }]);
      }
    } finally { plugins.onModuleDestroy(); bus.clear(); }
  });

  it('a host that declines an accepted request answers it as unsupported instead of abandoning its caller', async () => {
    const bus = (await sdk()).createEventBus();
    const plugins = new PiPluginService();
    plugins.register([PLUGIN_CHANNELS.attendant], async () => undefined);
    plugins.bind('chat', bus);
    const replies = repliesOn(bus, PLUGIN_CHANNELS.attendant);
    try {
      bus.emit(PLUGIN_CHANNELS.attendant, { requestId: 'unsupported' });
      await flush();
      expect(replies).toEqual([{ requestId: 'unsupported', ok: false, code: 'invalid', error: 'pi-kit has no handler for this request.' }]);
    } finally { plugins.onModuleDestroy(); bus.clear(); }
  });

  it('binding the same thread again retires its earlier binding: the old request is failed there, and its late answer never reaches the new session', async () => {
    const { createEventBus } = await sdk();
    const first = createEventBus();
    const second = createEventBus();
    const plugins = new PiPluginService();
    const held = heldHost();
    plugins.register([PLUGIN_CHANNELS.attendant], held.host);
    plugins.bind('chat', first);
    const firstReplies = repliesOn(first, PLUGIN_CHANNELS.attendant);
    const secondReplies = repliesOn(second, PLUGIN_CHANNELS.attendant);
    first.emit(PLUGIN_CHANNELS.attendant, { requestId: 'old' });
    await flush();
    plugins.bind('chat', second);
    expect(held.signals[0]?.aborted).toBe(true);
    expect(firstReplies).toEqual([{ requestId: 'old', ...CLOSED }]);
    held.release({ requestId: 'old', ok: true, text: 'late' });
    await flush();
    expect(secondReplies).toEqual([]);
    expect(firstReplies).toHaveLength(1);
    // The new session is served by its own binding, with its own signal.
    second.emit(PLUGIN_CHANNELS.attendant, { requestId: 'new' });
    await flush();
    expect(held.signals.map((signal) => signal?.aborted)).toEqual([true, false]);
    held.release({ requestId: 'new', ok: true });
    await flush();
    expect(secondReplies).toEqual([{ requestId: 'new', ok: true }]);
    plugins.onModuleDestroy();
    first.clear();
    second.clear();
  });
});

describe('the extensions on a session’s bus', () => {
  const packages = resolve(__dirname, '..', '..', '..', '..', 'packages');
  /** Each shipped extension, the channel its command asks first (where a held host catches it), and how it names a pi without pi-kit. */
  const extensions = [
    { name: '/score', file: 'pi-kit-meat-proxy/extensions/meat-proxy.ts', first: PLUGIN_CHANNELS.outcome, noHost: '/score needs pi-kit' },
    { name: '/learn', file: 'pi-kit-learn/extensions/learn.ts', first: PLUGIN_CHANNELS.transcript, noHost: '/learn needs pi-kit' },
  ];

  /** The real extension installed into a pi whose bus is the real one; returns its command, run with no arguments, and what it told the person. */
  async function install(file: string, bus: EventBusController): Promise<{ run: () => Promise<void>; notices: [string, string][] }> {
    const { default: register } = (await import(/* @vite-ignore */ pathToFileURL(resolve(packages, file)).href)) as { default: (pi: unknown) => void };
    let handler!: (args: string, ctx: unknown) => Promise<void>;
    register({ events: bus, registerCommand: (_name: string, command: { handler: typeof handler }) => void (handler = command.handler) });
    const notices: [string, string][] = [];
    const ctx = { ui: { notify: (text: string, level: string) => void notices.push([text, level]), confirm: async () => true } };
    return { run: () => handler('', ctx), notices };
  }

  it.each(extensions)('in a pi without pi-kit $name fails at once: nothing accepts its first request, and no clock is waited for', async ({ file, noHost }) => {
    const { createEventBus } = await sdk();
    const bus = createEventBus();
    const { run, notices } = await install(file, bus);
    // Observe settlement before the next task. Fake only legacy timeouts so the before-fix control can be cleaned up without waiting for them.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let completed = false;
    const running = run().then(() => { completed = true; });
    try {
      await flush();
      expect(completed).toBe(true);
      expect(notices.at(-1)).toEqual([expect.stringContaining(noHost), 'error']);
    } finally {
      try {
        await vi.runAllTimersAsync();
        await running;
      } finally {
        vi.useRealTimers();
        bus.clear();
      }
    }
  });

  it.each(extensions.flatMap((extension) => ends.map((end) => ({ ...extension, ...end }))))('$how the session mid-request ends $name with pi-kit’s answer, and the host hears the abort', async ({ file, first, end, reason }) => {
    const { createEventBus } = await sdk();
    const bus = createEventBus();
    const plugins = new PiPluginService();
    const held = heldHost();
    plugins.register([first], held.host);
    plugins.bind('chat', bus);
    const { run, notices } = await install(file, bus);
    const done = run();
    await flush();
    expect(held.signals.map((signal) => signal?.aborted)).toEqual([false]);
    end(plugins);
    await done;
    expect(held.signals[0]?.aborted).toBe(true);
    expect(notices.at(-1)).toEqual([reason.error, 'error']);
    plugins.onModuleDestroy();
    bus.clear();
  });
});
