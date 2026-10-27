import { afterEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({
  pages: [] as { emit(name: string): boolean; close: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; debugger: { sendCommand: ReturnType<typeof vi.fn> } }[],
  verifiers: [] as ((request: { hostname: string }, callback: (result: number) => void) => void)[],
  partitions: [] as string[],
}));
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    BrowserWindow: class {},
    WebContentsView: class {
      readonly webContents = Object.assign(new EventEmitter(), {
        session: { setCertificateVerifyProc: vi.fn((proc) => native.verifiers.push(proc)), setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn(), on: vi.fn() },
        setWindowOpenHandler: vi.fn(), isDestroyed: () => false, close: vi.fn(), stop: vi.fn(),
        getURL: () => 'http://localhost:3000/',
        debugger: Object.assign(new EventEmitter(), { isAttached: () => true, attach: vi.fn(), sendCommand: vi.fn((name: string) => name === 'Runtime.evaluate' ? new Promise(() => { /* simulate a renderer which never answers */ }) : Promise.resolve({})) }),
      });
      constructor(options: { webPreferences: { partition: string } }) { native.pages.push(this.webContents); native.partitions.push(options.webPreferences.partition); }
      setBounds() { /* no native view in unit tests */ }
    },
  };
});
import { BrowserArtifacts, browserUrl, isLoopbackHostname } from './browser';

afterEach(() => { native.pages.length = 0; native.verifiers.length = 0; native.partitions.length = 0; });

describe('browser artifact navigation boundary', () => {
  it('accepts project servers and web pages but rejects application and privileged URLs', () => {
    expect(browserUrl('localhost:3000')).toBe('http://localhost:3000/');
    expect(browserUrl('https://example.com/demo')).toBe('https://example.com/demo');
    for (const url of ['file:///tmp/app.html', 'file:/tmp/app.html', 'app://pi-kit/', 'javascript:alert(1)', 'data:text/html,hi', 'http://127.0.0.1:4300/api']) {
      expect(() => browserUrl(url, ['http://127.0.0.1:4300'])).toThrow();
    }
  });

  it('recognizes only literal loopback certificate hosts', () => {
    for (const host of ['localhost', 'LOCALHOST', '127.0.0.1', '127.255.255.255', '::1', '[::1]']) expect(isLoopbackHostname(host)).toBe(true);
    for (const host of ['localhost.example.com', 'example.localhost', '127.0.0.1.example.com', '127.256.0.1', '192.168.0.1', '0.0.0.0', 'example.com', '::']) expect(isLoopbackHostname(host)).toBe(false);
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

  it.each(['abort', 'renderer crash'])('releases the per-chat queue after %s interrupts an unresponsive command', async (reason) => {
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
  });
});
