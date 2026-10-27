import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ nativeImage: {} }));
vi.mock('./screenshot-encoder', () => ({ encodeScreenshot: vi.fn() }));
import { BrowserDiagnostics } from './browser-diagnostics';
import { encodeScreenshot } from './screenshot-encoder';

beforeEach(() => { vi.mocked(encodeScreenshot).mockReset().mockResolvedValue({ data: 'encoded', mimeType: 'image/png' }); });

function capturePage(capture: ReturnType<typeof vi.fn>) {
  const sendCommand = vi.fn(async (method: string): Promise<unknown> => method === 'Page.getLayoutMetrics' ? {
    cssContentSize: { x: 0, y: 0, width: 800, height: 1800 },
    cssLayoutViewport: { pageX: 0, pageY: 100, clientWidth: 800, clientHeight: 600 },
    layoutViewport: { clientWidth: 800 },
  } : {});
  const wc = Object.assign(new EventEmitter(), {
    isDestroyed: () => false, getZoomFactor: () => 1, capturePage: capture,
    debugger: Object.assign(new EventEmitter(), { isAttached: () => true, sendCommand }),
  });
  const refs = new Map<string, number>();
  return { wc, sendCommand, refs, diagnostics: new BrowserDiagnostics(wc as never, refs) };
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
  it('restores metrics and scrolling when raw full-page capture fails', async () => {
    const { diagnostics, sendCommand } = capturePage(vi.fn(async () => { throw new Error('Capture failed'); }));
    await expect(diagnostics.capture('fullpage')).rejects.toThrow('Capture failed');
    expect(sendCommand).toHaveBeenCalledWith('Emulation.clearDeviceMetricsOverride', {});
    expect(sendCommand).toHaveBeenLastCalledWith('Runtime.evaluate', expect.objectContaining({ expression: expect.stringContaining('top:100') }));
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

  it('finishes cancelled raw capture cleanup before changing metrics for another capture', async () => {
    let finish!: (image: unknown) => void;
    const raw = new Promise((resolve) => { finish = resolve; });
    const capture = vi.fn().mockReturnValueOnce(raw).mockResolvedValue({});
    const { diagnostics, sendCommand } = capturePage(capture);
    const controller = new AbortController();
    const first = diagnostics.capture('fullpage', 'png', 80, controller.signal);
    const rejected = expect(first).rejects.toThrow('cancelled');
    await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(1));
    controller.abort();
    const next = diagnostics.capture('fullpage');
    await Promise.resolve();
    expect(sendCommand.mock.calls.filter(([method]) => method === 'Emulation.setDeviceMetricsOverride')).toHaveLength(1);
    finish({});
    await rejected;
    expect(await next).toEqual({ data: 'encoded', mimeType: 'image/png' });
    const metrics = sendCommand.mock.calls.map(([method]) => method).filter((method) => method.startsWith('Emulation.'));
    expect(metrics).toEqual(['Emulation.setDeviceMetricsOverride', 'Emulation.clearDeviceMetricsOverride', 'Emulation.setDeviceMetricsOverride', 'Emulation.clearDeviceMetricsOverride']);
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
