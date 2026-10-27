import { afterEach, describe, expect, it, vi } from 'vitest';
import { DesktopBridge } from './desktop-bridge';

describe('DesktopBridge', () => {
  const realSend = process.send;
  const bridges: DesktopBridge[] = [];
  const createBridge = () => { const bridge = new DesktopBridge(); bridges.push(bridge); return bridge; };
  afterEach(() => {
    for (const bridge of bridges.splice(0)) bridge.onModuleDestroy();
    vi.useRealTimers();
    process.send = realSend;
    delete process.env['PI_KIT_DESKTOP'];
  });

  it('answers "not opened" with a reason when the backend was not started by the desktop app (dev:web, even with a fork channel)', async () => {
    process.send = vi.fn() as never; // the Nx dev server forks the backend with a channel, but no Electron is on the other end
    const bridge = createBridge();
    expect(bridge.available).toBe(false);
    expect(await bridge.openPath('/x/file.ts')).toEqual({ opened: false, reason: expect.stringContaining('desktop app') });
    expect(process.send).not.toHaveBeenCalled();
  });

  it('sends the path to Electron main and resolves with its answer', async () => {
    process.env['PI_KIT_DESKTOP'] = '1';
    const sent: { type: string; id: string; path: string }[] = [];
    process.send = ((message: { type: string; id: string; path: string }) => {
      sent.push(message);
      // Electron main: shell.openPath succeeded for the first request, failed for the second.
      queueMicrotask(() => process.emit('message', { type: 'desktop-answer', id: message.id, ...(sent.length === 2 ? { error: 'No application is set for this file type.' } : {}) } as never, undefined as never));
      return true;
    }) as never;
    const bridge = createBridge();
    expect(bridge.available).toBe(true);
    expect(await bridge.openPath('/work/a.ts')).toEqual({ opened: true });
    expect(await bridge.openPath('/work/b.xyz')).toEqual({ opened: false, reason: 'No application is set for this file type.' });
    expect(sent.map((m) => [m.type, m.path])).toEqual([['open-path', '/work/a.ts'], ['open-path', '/work/b.xyz']]);
  });

  it('correlates concurrent browser requests and cancels an aborted action in Electron', async () => {
    process.env['PI_KIT_DESKTOP'] = '1';
    const sent: { type: string; id: string; threadId?: string; request?: unknown }[] = [];
    process.send = ((message: typeof sent[number]) => { sent.push(message); return true; }) as never;
    const bridge = createBridge();
    const state = { available: true, threadId: 'chat', open: false, url: '', title: '', loading: false, canGoBack: false, canGoForward: false };
    const reading = bridge.browser('chat');
    const abort = new AbortController();
    const navigating = bridge.browser('chat', { action: 'navigate', url: 'http://localhost:3000' }, abort.signal);
    const rejected = expect(navigating).rejects.toThrow('cancelled');
    abort.abort();
    await rejected;
    expect(sent[2]).toEqual({ type: 'browser-cancel', id: sent[1].id });
    // A late action response must not settle the unrelated state request.
    process.emit('message', { type: 'desktop-answer', id: sent[1].id, result: { state: { ...state, open: true } } } as never, undefined as never);
    process.emit('message', { type: 'desktop-answer', id: sent[0].id, result: { state } } as never, undefined as never);
    expect(await reading).toEqual({ state });
    expect(sent[1].request).toEqual({ action: 'navigate', url: 'http://localhost:3000' });
    bridge.onModuleDestroy();
  });

  it.each(['destroy', 'disconnect'])('settles all pending requests and removes its listeners on %s', async (reason) => {
    vi.useFakeTimers();
    process.env['PI_KIT_DESKTOP'] = '1';
    process.send = vi.fn(() => true) as never;
    const before = process.listenerCount('message');
    const beforeDisconnect = process.listenerCount('disconnect');
    const bridge = createBridge();
    const browser = bridge.browser('chat');
    const update = bridge.appUpdate('check');
    const opened = bridge.openPath('/file');
    const all = Promise.allSettled([browser, update, opened]);
    if (reason === 'destroy') bridge.onModuleDestroy();
    else process.emit('disconnect');
    const results = await all;
    expect(results.slice(0, 2)).toEqual([
      expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ code: 'unavailable' }) }),
      expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ code: 'unavailable' }) }),
    ]);
    expect(results[2]).toEqual({ status: 'fulfilled', value: { opened: false, reason: 'The desktop connection closed.' } });
    expect(bridge.available).toBe(false);
    expect(process.listenerCount('message')).toBe(before);
    expect(process.listenerCount('disconnect')).toBe(beforeDisconnect);
    expect(vi.getTimerCount()).toBe(0);
    bridge.onModuleDestroy();
  });

  it('keeps a remote validation error distinct from a desktop timeout and send failure', async () => {
    vi.useFakeTimers();
    process.env['PI_KIT_DESKTOP'] = '1';
    process.send = vi.fn() as never;
    const bridge = createBridge();
    try {
      const invalid = bridge.browser('chat', { action: 'navigate', url: 'file:///secret' });
      const failed = expect(invalid).rejects.toMatchObject({ code: 'invalid', message: 'Blocked page' });
      const id = (process.send as ReturnType<typeof vi.fn>).mock.calls[0][0].id;
      process.emit('message', { type: 'desktop-answer', id, errorCode: 'invalid', error: 'Blocked page' } as never, undefined as never);
      await failed;
      const timeout = expect(bridge.browser('chat')).rejects.toMatchObject({ code: 'timeout' });
      await vi.advanceTimersByTimeAsync(30_000);
      await timeout;
      process.send = vi.fn(() => { throw new Error('EPIPE'); }) as never;
      await expect(bridge.browser('chat')).rejects.toMatchObject({ code: 'unavailable' });
      expect(vi.getTimerCount()).toBe(0);
    } finally { bridge.onModuleDestroy(); }
  });

});
