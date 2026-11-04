import type { BrowserWindow } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({
  windows: [] as {
    options: Record<string, unknown>;
    destroyed: boolean;
    destroy: ReturnType<typeof vi.fn>;
    contentView: { addChildView: ReturnType<typeof vi.fn>; removeChildView: ReturnType<typeof vi.fn> };
  }[],
  views: [] as { setBounds: ReturnType<typeof vi.fn> }[],
  pages: [] as {
    emit(name: string): boolean;
    close: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    loadURL: ReturnType<typeof vi.fn>;
    debugger: { sendCommand: ReturnType<typeof vi.fn> };
  }[],
  verifiers: [] as ((request: { hostname: string }, callback: (result: number) => void) => void)[],
  partitions: [] as string[],
}));
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    BrowserWindow: class {
      destroyed = false;
      readonly contentView = { addChildView: vi.fn(), removeChildView: vi.fn() };
      readonly webContents = { getZoomFactor: () => 1 };
      readonly destroy = vi.fn(() => {
        this.destroyed = true;
      });
      constructor(readonly options: Record<string, unknown> = {}) {
        native.windows.push(this);
      }
      isDestroyed() {
        return this.destroyed;
      }
      getContentSize() {
        return [1200, 900];
      }
    },
    WebContentsView: class {
      private destroyed = false;
      readonly webContents = Object.assign(new EventEmitter(), {
        session: {
          setCertificateVerifyProc: vi.fn((proc) => native.verifiers.push(proc)),
          setPermissionRequestHandler: vi.fn(),
          setPermissionCheckHandler: vi.fn(),
          on: vi.fn(),
        },
        setWindowOpenHandler: vi.fn(),
        isDestroyed: () => this.destroyed,
        close: vi.fn(() => {
          this.destroyed = true;
          this.webContents.emit('destroyed');
        }),
        stop: vi.fn(),
        loadURL: vi.fn(
          () =>
            new Promise(() => {
              /* navigation may never complete */
            }),
        ),
        getURL: () => 'http://localhost:3000/',
        getTitle: () => 'Project',
        isLoading: () => false,
        navigationHistory: { canGoBack: () => false, canGoForward: () => false },
        debugger: Object.assign(new EventEmitter(), {
          isAttached: () => true,
          attach: vi.fn(),
          sendCommand: vi.fn((name: string) =>
            name === 'Runtime.evaluate'
              ? new Promise(() => {
                  /* simulate a renderer which never answers */
                })
              : Promise.resolve(
                  name === 'Accessibility.getFullAXTree'
                    ? { nodes: [] }
                    : name === 'Page.getLayoutMetrics'
                      ? { cssLayoutViewport: { pageX: 0, pageY: 0 } }
                      : {},
                ),
          ),
        }),
      });
      constructor(options: { webPreferences: { partition: string } }) {
        native.views.push(this);
        native.pages.push(this.webContents);
        native.partitions.push(options.webPreferences.partition);
      }
      readonly setBounds = vi.fn();
    },
  };
});
import { BrowserWindow as NativeWindow } from 'electron';
import { BrowserArtifacts, browserUrl, isLoopbackHostname } from './browser';

afterEach(() => {
  native.windows.length = 0;
  native.views.length = 0;
  native.pages.length = 0;
  native.verifiers.length = 0;
  native.partitions.length = 0;
});

describe('browser artifact navigation boundary', () => {
  it('accepts project servers and web pages but rejects application and privileged URLs', () => {
    expect(browserUrl('localhost:3000')).toBe('http://localhost:3000/');
    expect(browserUrl('https://example.com/demo')).toBe('https://example.com/demo');
    for (const url of [
      'file:///tmp/app.html',
      'file:/tmp/app.html',
      'app://pi-kit/',
      'javascript:alert(1)',
      'data:text/html,hi',
      'http://127.0.0.1:4300/api',
    ]) {
      expect(() => browserUrl(url, ['http://127.0.0.1:4300'])).toThrow();
    }
  });

  it('recognizes only literal loopback certificate hosts', () => {
    for (const host of ['localhost', 'LOCALHOST', '127.0.0.1', '127.255.255.255', '::1', '[::1]'])
      expect(isLoopbackHostname(host)).toBe(true);
    for (const host of [
      'localhost.example.com',
      'example.localhost',
      '127.0.0.1.example.com',
      '127.256.0.1',
      '192.168.0.1',
      '0.0.0.0',
      'example.com',
      '::',
    ])
      expect(isLoopbackHostname(host)).toBe(false);
  });

  it('defaults to normal TLS, accepts only opted-in loopback hosts and drops sessions when the option changes', async () => {
    const browser = new BrowserArtifacts();
    const create = async (id: string) => {
      const controller = new AbortController();
      const pending = browser.run(id, { action: 'evaluate', code: 'pending' }, controller.signal);
      const failed = expect(pending).rejects.toThrow('cancelled');
      const expected = native.pages.length + 1;
      await vi.waitFor(() => expect(native.pages).toHaveLength(expected));
      controller.abort();
      await failed;
      return native.verifiers.at(-1)!;
    };
    const verify = await create('chat');
    const result = vi.fn();
    verify({ hostname: 'localhost' }, result);
    expect(result).toHaveBeenLastCalledWith(-3);
    browser.setAllowInvalidLocalCertificates(true);
    expect(native.pages[0].close).toHaveBeenCalled();
    const allowed = await create('chat');
    allowed({ hostname: 'localhost' }, result);
    expect(result).toHaveBeenLastCalledWith(0);
    allowed({ hostname: '127.0.0.1' }, result);
    expect(result).toHaveBeenLastCalledWith(0);
    allowed({ hostname: 'example.com' }, result);
    expect(result).toHaveBeenLastCalledWith(-3);
    browser.setAllowInvalidLocalCertificates(false);
    expect(native.pages[1].close).toHaveBeenCalled();
    const strict = await create('chat');
    strict({ hostname: 'localhost' }, result);
    expect(result).toHaveBeenLastCalledWith(-3);
    expect(new Set(native.partitions).size).toBe(3);
  });

  it.each(['abort', 'renderer crash'])(
    'releases the per-chat queue after %s interrupts an unresponsive command',
    async (reason) => {
      const browser = new BrowserArtifacts();
      const controller = new AbortController();
      const pending = browser.run('chat', { action: 'evaluate', code: 'new Promise(() => {})' }, controller.signal);
      const failed = expect(pending).rejects.toThrow(reason === 'abort' ? 'cancelled' : 'page stopped');
      await vi.waitFor(() => expect(native.pages).toHaveLength(1));
      if (reason === 'abort') {
        controller.abort();
        expect(native.pages[0].stop).toHaveBeenCalled();
        expect(native.pages[0].debugger.sendCommand).toHaveBeenCalledWith('Runtime.terminateExecution', {});
      } else native.pages[0].emit('render-process-gone');
      await failed;
      // A stuck CDP response must not block all subsequent actions in this chat.
      expect((await browser.run('chat', { action: 'close' })).state.open).toBe(false);
    },
  );
});

describe('browser action deadlines', () => {
  it.each(['evaluate', 'navigate'] as const)(
    'bounds a permanently pending %s and permits a fresh action afterward',
    async (action) => {
      const browser = new BrowserArtifacts(undefined, 8, 30);
      await expect(
        browser.run(
          'chat',
          action === 'navigate' ? { action, url: 'http://localhost:3000' } : { action, code: 'new Promise(() => {})' },
        ),
      ).rejects.toMatchObject({ code: 'timeout' });
      expect(native.pages[0].stop).toHaveBeenCalledOnce();
      expect(native.pages[0].close).toHaveBeenCalledOnce();
      expect(browser.state('chat').open).toBe(false);
      await browser.run('chat', { action: 'snapshot' });
      expect(native.pages).toHaveLength(2);
      browser.dispose();
    },
  );
});

describe('browser cancellation and disposal', () => {
  it('retires a cancelled page before the next action can reuse its references', async () => {
    const browser = new BrowserArtifacts();
    const cancel = new AbortController();
    const old = browser.run('chat', { action: 'evaluate', code: 'pending' }, cancel.signal);
    const rejected = expect(old).rejects.toMatchObject({ code: 'cancelled' });
    await vi.waitFor(() => expect(native.pages).toHaveLength(1));
    cancel.abort();
    await rejected;
    expect(native.pages[0].close).toHaveBeenCalledOnce();
    await browser.run('chat', { action: 'snapshot' });
    expect(native.pages).toHaveLength(2);
    browser.dispose();
  });

  it('cancels a queued request immediately without interrupting the active request', async () => {
    const browser = new BrowserArtifacts();
    const active = new AbortController();
    const old = browser.run('chat', { action: 'evaluate', code: 'pending' }, active.signal);
    const oldRejected = expect(old).rejects.toMatchObject({ code: 'cancelled' });
    await vi.waitFor(() => expect(native.pages).toHaveLength(1));
    const queued = new AbortController();
    const next = browser.run('chat', { action: 'snapshot' }, queued.signal);
    const queuedRejected = expect(next).rejects.toMatchObject({ code: 'cancelled' });
    queued.abort();
    await queuedRejected;
    expect(native.pages[0].close).not.toHaveBeenCalled();
    expect(native.pages[0].stop).not.toHaveBeenCalled();
    active.abort();
    await oldRejected;
    browser.dispose();
  });

  it('does not recreate hidden windows from queued work after disposal', async () => {
    const browser = new BrowserArtifacts();
    const running = browser.run('chat', { action: 'evaluate', code: 'pending' });
    const rejected = expect(running).rejects.toMatchObject({ code: 'unavailable' });
    await vi.waitFor(() => expect(native.pages).toHaveLength(1));
    const queued = browser.run('chat', { action: 'snapshot' });
    const queuedRejected = expect(queued).rejects.toMatchObject({ code: 'cancelled' });
    browser.dispose();
    await rejected;
    await queuedRejected;
    await expect(browser.run('new-chat', { action: 'snapshot' })).rejects.toMatchObject({ code: 'unavailable' });
    expect(native.pages).toHaveLength(1);
    expect(native.windows.every((window) => window.destroyed)).toBe(true);
  });
});

describe('browser native render hosts', () => {
  const rect = { x: 20, y: 30, width: 600, height: 400 };
  const window = () => new NativeWindow({}) as BrowserWindow;

  it('hosts unattached pages at a positive size and enables AX before snapshots', async () => {
    const browser = new BrowserArtifacts();
    await browser.run('chat', { action: 'snapshot' });
    expect(native.windows[0].options).toMatchObject({
      show: false,
      focusable: false,
      paintWhenInitiallyHidden: true,
      width: 1024,
      height: 768,
    });
    expect(native.windows[0].contentView.addChildView).toHaveBeenCalledTimes(1);
    expect(native.views[0].setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 1024, height: 768 });
    const commands = native.pages[0].debugger.sendCommand.mock.calls.map(([name]) => name);
    expect(commands.indexOf('Accessibility.enable')).toBeLessThan(commands.indexOf('Accessibility.getFullAXTree'));
    browser.dispose();
    expect(native.windows[0].destroy).toHaveBeenCalledTimes(1);
  });

  it('updates same-host bounds without detaching and ignores stale owner cleanup', async () => {
    const browser = new BrowserArtifacts();
    const main = window();
    browser.layout(main, { threadId: 'chat', owner: 'first', bounds: rect });
    await browser.run('chat', { action: 'snapshot' });
    browser.layout(main, { threadId: 'chat', owner: 'second', bounds: { ...rect, width: 500 } });
    browser.layout(main, { threadId: 'chat', owner: 'first', bounds: null });
    expect(native.windows[0].contentView.addChildView).toHaveBeenCalledTimes(1);
    expect(native.windows[0].contentView.removeChildView).not.toHaveBeenCalled();
    expect(native.views[0].setBounds).toHaveBeenLastCalledWith({ ...rect, width: 500 });
    expect(native.windows).toHaveLength(1);
    browser.dispose();
  });

  it.each([
    { ...rect, width: 0 },
    { ...rect, height: -1 },
    { ...rect, x: 2000 },
    { ...rect, x: Number.NaN },
    { ...rect, width: Number.POSITIVE_INFINITY },
  ])('parks invalid or offscreen bounds without any zero native size: %j', async (bounds) => {
    const browser = new BrowserArtifacts();
    const main = window();
    browser.layout(main, { threadId: 'chat', owner: 'panel', bounds: rect });
    await browser.run('chat', { action: 'snapshot' });
    browser.layout(main, { threadId: 'chat', owner: 'panel', bounds });
    expect(native.windows).toHaveLength(2);
    for (const [value] of native.views[0].setBounds.mock.calls) {
      expect(value.width).toBeGreaterThan(0);
      expect(value.height).toBeGreaterThan(0);
    }
    browser.dispose();
    expect(native.windows[1].destroy).toHaveBeenCalledTimes(1);
  });

  it('intersects negative origins and migrates pages/owners with fallback cleanup', async () => {
    const browser = new BrowserArtifacts();
    const main = window();
    await browser.run('one', { action: 'snapshot' });
    const fallback = native.windows[1];
    browser.layout(main, { threadId: 'one', owner: 'one', bounds: { x: -20, y: -30, width: 100, height: 100 } });
    expect(native.views[0].setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 80, height: 70 });
    expect(fallback.destroy).toHaveBeenCalledTimes(1);
    await browser.run('two', { action: 'snapshot' });
    browser.layout(main, { threadId: 'two', owner: 'two', bounds: rect });
    browser.layout(main, { threadId: 'one', owner: 'one', bounds: null });
    expect(native.views[1].setBounds).toHaveBeenLastCalledWith(rect);
    browser.close('one');
    expect(native.windows.at(-1)!.destroy).toHaveBeenCalledTimes(1);
    browser.layout(main, { threadId: 'two', owner: 'two', bounds: null });
    native.pages[1].emit('destroyed');
    expect(native.windows.at(-1)!.destroy).toHaveBeenCalledTimes(1);
    browser.dispose();
    expect(native.windows.slice(1).every((host) => host.destroyed)).toBe(true);
  });
});
