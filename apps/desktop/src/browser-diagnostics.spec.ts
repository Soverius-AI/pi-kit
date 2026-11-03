import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ nativeImage: {} }));
vi.mock('./screenshot-encoder', () => ({ encodeScreenshot: vi.fn() }));
import { BrowserDiagnostics } from './browser-diagnostics';
import { encodeScreenshot } from './screenshot-encoder';

beforeEach(() => { vi.mocked(encodeScreenshot).mockReset().mockResolvedValue({ data: 'encoded', mimeType: 'image/png' }); });

function capturePage(capture: ReturnType<typeof vi.fn>, timeoutMs?: number) {
  const sendCommand = vi.fn(async (method: string): Promise<unknown> => method === 'Page.getLayoutMetrics' ? {
    cssContentSize: { x: 0, y: 0, width: 800, height: 1800 },
    cssLayoutViewport: { pageX: 0, pageY: 100, clientWidth: 800, clientHeight: 600 },
    layoutViewport: { clientWidth: 800 },
  } : {});
  let destroyed = false;
  const wc = Object.assign(new EventEmitter(), {
    isDestroyed: () => destroyed, getZoomFactor: () => 1, capturePage: capture,
    close: vi.fn(() => { destroyed = true; wc.emit('destroyed'); }),
    debugger: Object.assign(new EventEmitter(), { isAttached: () => true, sendCommand }),
  });
  const refs = new Map<string, number>();
  return { wc, sendCommand, refs, diagnostics: new BrowserDiagnostics(wc as never, refs, timeoutMs) };
}


describe('native browser inspection', () => {
  it.each(['DOM.enable', 'Overlay.enable'])('honors cancellation while %s is still starting', async (pendingMethod) => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const sendCommand = vi.fn((method: string) => method === pendingMethod ? pending : Promise.resolve({}));
    const wc = Object.assign(new EventEmitter(), {
      isDestroyed: () => false,
      debugger: Object.assign(new EventEmitter(), { isAttached: () => true, sendCommand }),
    });
    const diagnostics = new BrowserDiagnostics(wc as never, new Map());
    const starting = diagnostics.inspect({ action: 'inspect', enabled: true });
    await vi.waitFor(() => expect(sendCommand).toHaveBeenCalledWith(pendingMethod, {}));
    await diagnostics.cancelInspect();
    finish();
    await starting;
    expect(diagnostics.inspecting).toBe(false);
    expect(sendCommand).not.toHaveBeenCalledWith('Overlay.setInspectMode', expect.objectContaining({ mode: 'searchForNode' }));
  });

  it('turns off the native overlay when Stop or Escape cancels an active picker', async () => {
    const sendCommand = vi.fn(async () => ({}));
    const wc = Object.assign(new EventEmitter(), {
      isDestroyed: () => false,
      debugger: Object.assign(new EventEmitter(), { isAttached: () => true, sendCommand }),
    });
    const diagnostics = new BrowserDiagnostics(wc as never, new Map());
    await diagnostics.inspect({ action: 'inspect', enabled: true });
    expect(diagnostics.inspecting).toBe(true);
    await diagnostics.inspect({ action: 'inspect', enabled: false });
    expect(diagnostics.inspecting).toBe(false);
    expect(sendCommand).toHaveBeenCalledWith('Overlay.setInspectMode', { mode: 'none' });
    expect(sendCommand).toHaveBeenLastCalledWith('Overlay.hideHighlight', {});
    await diagnostics.inspect({ action: 'inspect', enabled: true });
    const preventDefault = vi.fn();
    wc.emit('before-input-event', { preventDefault }, { type: 'keyDown', key: 'Escape' });
    expect(preventDefault).toHaveBeenCalled();
    expect(diagnostics.inspecting).toBe(false);
    expect(sendCommand).toHaveBeenCalledWith('Overlay.setInspectMode', { mode: 'none' });
    await vi.waitFor(() => expect(sendCommand).toHaveBeenLastCalledWith('Overlay.hideHighlight', {}));
  });
  it('primes a tiny compositor frame before reading native pixels, preserving encoding preferences', async () => {
    const capture = vi.fn(async () => ({}));
    const { diagnostics, sendCommand } = capturePage(capture);
    let prime!: () => void;
    const primed = new Promise<void>((resolve) => { prime = resolve; });
    const original = sendCommand.getMockImplementation();
    sendCommand.mockImplementation(async (method) => method === 'Page.captureScreenshot' ? primed : original?.(method));
    const result = diagnostics.capture('viewport', 'jpeg', 45);
    await vi.waitFor(() => expect(sendCommand).toHaveBeenCalledWith('Page.captureScreenshot', {
      format: 'jpeg', quality: 10, fromSurface: true, captureBeyondViewport: false,
      clip: { x: 0, y: 100, width: 1, height: 1, scale: 1 },
    }));
    expect(capture).not.toHaveBeenCalled();
    prime();
    await result;
    expect(capture).toHaveBeenCalledOnce();
    expect(encodeScreenshot).toHaveBeenCalledWith(expect.anything(), 'jpeg', 45, expect.any(AbortSignal));
  });

  it('retires a broken compositor instead of leaking UnknownVizError to the user', async () => {
    const { diagnostics, wc } = capturePage(vi.fn(async () => { throw new Error('UnknownVizError'); }));
    await expect(diagnostics.capture('fullpage')).rejects.toMatchObject({ code: 'failed', message: expect.stringContaining('rendered pixels') });
    expect(wc.close).toHaveBeenCalledOnce();
    expect(encodeScreenshot).not.toHaveBeenCalled();
  });

  it('crops a selected element in viewport coordinates after scrolling without emulating a different viewport', async () => {
    const capture = vi.fn(async () => ({}));
    const { diagnostics, refs, sendCommand } = capturePage(capture);
    const original = sendCommand.getMockImplementation();
    const bounds = { x: 20.4, y: 250.4, width: 120, height: 80 };
    sendCommand.mockImplementation(async (method) => {
      if (method === 'DOM.resolveNode') return { object: { objectId: 'fixed' } };
      if (method === 'Runtime.callFunctionOn') return { result: { value: { selector: '#fixed', tag: 'button', name: 'Fixed', role: 'button', bounds, viewport: { pageX: 0, pageY: 100, clientWidth: 800, clientHeight: 600 }, styles: {} } } };
      return original?.(method) ?? {};
    });
    refs.set('fixed', 1);
    await diagnostics.inspect({ action: 'inspect', ref: 'fixed' });
    await diagnostics.capture('selection');
    expect(capture).toHaveBeenCalledWith({ x: 20, y: 150, width: 121, height: 81 }, { stayHidden: true, stayAwake: true });
    expect(sendCommand.mock.calls.some(([method]) => method.startsWith('Emulation.'))).toBe(false);
  });

  it('cancels a permanently stuck native capture without waiting for it or reusing its metrics', async () => {
    const capture = vi.fn(() => new Promise(() => { /* native capture never answers */ }));
    const { diagnostics, wc, sendCommand } = capturePage(capture);
    const controller = new AbortController();
    const first = diagnostics.capture('fullpage', 'png', 80, controller.signal);
    const rejected = expect(first).rejects.toMatchObject({ code: 'cancelled' });
    await vi.waitFor(() => expect(capture).toHaveBeenCalledOnce());
    controller.abort();
    await rejected;
    expect(wc.close).toHaveBeenCalledOnce();
    await expect(diagnostics.capture('fullpage')).rejects.toMatchObject({ code: 'cancelled' });
    expect(capture).toHaveBeenCalledOnce();
    expect(sendCommand.mock.calls.filter(([method]) => method === 'Emulation.setDeviceMetricsOverride')).toHaveLength(1);
    // A replacement page has a separate capture queue and clean virtual viewport.
    const replacement = capturePage(vi.fn(async () => ({})));
    expect(await replacement.diagnostics.capture('fullpage')).toEqual({ data: 'encoded', mimeType: 'image/png' });
    expect(replacement.sendCommand).toHaveBeenCalledWith('Emulation.clearDeviceMetricsOverride', {});
  });

  it('times out native pixels before encoding, closes the page and ignores a late native reply', async () => {
    let finish!: (image: unknown) => void;
    const capture = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    const { diagnostics, wc } = capturePage(capture, 50);
    await expect(diagnostics.capture('viewport')).rejects.toMatchObject({ code: 'timeout' });
    expect(wc.close).toHaveBeenCalledOnce();
    finish({});
    await Promise.resolve();
    expect(encodeScreenshot).not.toHaveBeenCalled();
  });

  it('also bounds stalled layout/CDP responses, not just screenshot encoding', async () => {
    const { diagnostics, wc, sendCommand } = capturePage(vi.fn(), 50);
    sendCommand.mockImplementation(async (method) => method === 'Page.getLayoutMetrics' ? new Promise(() => { /* CDP never settles */ }) : {});
    await expect(diagnostics.capture('fullpage')).rejects.toMatchObject({ code: 'timeout' });
    expect(wc.close).toHaveBeenCalledOnce();
    expect(encodeScreenshot).not.toHaveBeenCalled();
  });

  it('rejects an encoded result if the page navigated while the worker was running', async () => {
    let finish!: (result: { data: string; mimeType: 'image/png' }) => void;
    vi.mocked(encodeScreenshot).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const { diagnostics, wc } = capturePage(vi.fn(async () => ({})));
    const pending = diagnostics.capture('viewport');
    const rejected = expect(pending).rejects.toThrow('navigated');
    await vi.waitFor(() => expect(encodeScreenshot).toHaveBeenCalled());
    wc.emit('did-start-navigation', { isMainFrame: true });
    finish({ data: 'old document', mimeType: 'image/png' });
    await rejected;
  });

});
