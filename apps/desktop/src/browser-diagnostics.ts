import { randomUUID } from 'node:crypto';
import type { NativeImage, WebContents } from 'electron';
import { BrowserInspectionSchema, BrowserOperationError, DEFAULT_SCREENSHOT_FORMAT, DEFAULT_SCREENSHOT_QUALITY, type BrowserAction, type BrowserInspection, type BrowserLog, type BrowserResult } from '@pi-kit/protocol';

import { encodeScreenshot } from './screenshot-encoder';

interface RemoteResult { result: { value?: unknown; objectId?: string }; exceptionDetails?: { text: string } }

// Static code runs inside the sandboxed page; no application bridge or page-authored IPC is involved.
const describeElement = `function(scrollIntoView) {
  const el = this.nodeType === 1 ? this : this.parentElement;
  if (!el?.isConnected) throw new Error('The selected element is detached. Inspect it again.');
  if (scrollIntoView) el.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'});
  const r = el.getBoundingClientRect(), style = getComputedStyle(el), parts = [];
  for (let node = el; node && parts.length < 6; node = node.parentElement) {
    if (node.id) { parts.unshift('#' + CSS.escape(node.id)); break; }
    let part = node.localName;
    if (!part) break;
    if (node.parentElement) part += ':nth-child(' + (Array.prototype.indexOf.call(node.parentElement.children, node) + 1) + ')';
    parts.unshift(part);
  }
  const styles = {};
  for (const key of ['display','position','color','background-color','font-family','font-size','font-weight','line-height','padding','margin','gap','border','border-radius','box-shadow','width','height']) styles[key] = style.getPropertyValue(key).slice(0,200);
  return {selector: parts.join(' > ').slice(0,1000), tag: el.localName.slice(0,80), name: (el.getAttribute('aria-label') || el.innerText || el.textContent || el.getAttribute('alt') || '').trim().slice(0,500), role: (el.getAttribute('role') || el.localName).slice(0,80), bounds: {x:r.x+scrollX,y:r.y+scrollY,width:r.width,height:r.height}, viewport: {pageX:scrollX,pageY:scrollY,clientWidth:innerWidth,clientHeight:innerHeight}, styles};
}`;

/** Per-page diagnostics own navigation identity, native picking and bounded logs/captures. */
export class BrowserDiagnostics {
  documentId = randomUUID();
  inspecting = false;
  inspection?: BrowserInspection;
  readonly logs: BrowserLog[] = [];
  private selectedNode?: number;
  private generation = 0;
  private pixelCapture = Promise.resolve();
  readonly ready: Promise<void>;

  constructor(private readonly wc: WebContents, private readonly refs: Map<string, number>) {
    wc.on('did-start-navigation', (details) => {
      if (!details.isMainFrame) return;
      this.documentId = randomUUID();
      this.refs.clear();
      this.inspection = undefined;
      this.selectedNode = undefined;
      this.logs.length = 0;
      void this.cancelInspect();
    });
    wc.on('console-message', (details) => this.log(details.level, details.message, details.sourceId, details.lineNumber));
    wc.on('before-input-event', (event, input) => {
      if (this.inspecting && input.type === 'keyDown' && input.key === 'Escape') {
        event.preventDefault();
        void this.cancelInspect();
      }
    });
    wc.debugger.on('message', (_event, method, params) => {
      if (method === 'Overlay.inspectModeCanceled' && this.inspecting) void this.cancelInspect();
      if (method === 'Overlay.inspectNodeRequested' && this.inspecting) {
        const node = (params as { backendNodeId?: number }).backendNodeId;
        if (node) void this.select(node).catch(() => this.cancelInspect());
      }
      if (method === 'Runtime.exceptionThrown') {
        const detail = (params as { exceptionDetails: { text: string; exception?: { description?: string }; url?: string; lineNumber?: number; stackTrace?: { callFrames: { url: string; lineNumber: number }[] } } }).exceptionDetails;
        const frame = detail.stackTrace?.callFrames.find((item) => item.url);
        const line = detail.url ? detail.lineNumber : frame?.lineNumber;
        this.log('error', detail.exception?.description ?? detail.text, detail.url || frame?.url, line === undefined ? undefined : line + 1);
      }
    });
    this.ready = this.command('Runtime.enable').then(() => undefined);
    // The run path awaits readiness; also handle a page closed before the first action.
    void this.ready.catch(() => undefined);
  }

  private log(level: string, message: string, source?: string, line?: number): void {
    const kind = level === 'error' || level === 'warning' || level === 'debug' ? level : 'info';
    this.logs.push({ id: randomUUID(), documentId: this.documentId, time: Date.now(), level: kind, message: message.slice(0, 2000), ...(source ? { source: source.slice(0, 1000) } : {}), ...(line === undefined ? {} : { line }) });
    if (this.logs.length > 100) this.logs.shift();
  }

  private command<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!this.wc.debugger.isAttached()) this.wc.debugger.attach('1.3');
    return this.wc.debugger.sendCommand(method, params) as Promise<T>;
  }

  assertDocument(expected: string | undefined): void {
    if (this.wc.isDestroyed() || (expected && expected !== this.documentId)) throw new BrowserOperationError('cancelled', 'The browser navigated. Capture fresh context from the current page.');
  }

  async inspect(action: BrowserAction): Promise<void> {
    if (action.ref) {
      const node = this.refs.get(action.ref);
      if (!node) throw new BrowserOperationError('invalid', 'Unknown or stale element reference. Take a new snapshot first.');
      await this.select(node);
      return;
    }
    if (action.enabled === false) return this.cancelInspect();
    const generation = ++this.generation;
    await this.command('DOM.enable');
    if (generation !== this.generation) return;
    await this.command('Overlay.enable');
    if (generation !== this.generation) return;
    this.inspecting = true;
    try {
      await this.command('Overlay.setInspectMode', { mode: 'searchForNode', highlightConfig: { showInfo: true, showStyles: true, contentColor: { r: 85, g: 150, b: 240, a: 0.25 }, borderColor: { r: 85, g: 150, b: 240, a: 0.8 } } });
    } catch (error) { this.inspecting = false; throw error; }
  }

  async cancelInspect(): Promise<void> {
    this.generation++;
    const active = this.inspecting;
    this.inspecting = false;
    if (active && !this.wc.isDestroyed() && this.wc.debugger.isAttached()) {
      await this.command('Overlay.setInspectMode', { mode: 'none' }).catch(() => undefined);
      await this.command('Overlay.hideHighlight').catch(() => undefined);
    }
  }

  private async describe(node: number, scrollIntoView = false): Promise<unknown> {
    const resolved = await this.command<{ object: { objectId: string } }>('DOM.resolveNode', { backendNodeId: node });
    const objectId = resolved.object.objectId;
    try {
      const result = await this.command<RemoteResult>('Runtime.callFunctionOn', { objectId, functionDeclaration: describeElement, arguments: [{ value: scrollIntoView }], returnByValue: true });
      if (result.exceptionDetails) throw new BrowserOperationError('invalid', 'The selected element is detached. Inspect it again.');
      return result.result.value;
    } finally { await this.command('Runtime.releaseObject', { objectId }).catch(() => undefined); }
  }

  private async select(node: number): Promise<void> {
    await this.cancelInspect();
    const generation = this.generation;
    const documentId = this.documentId;
    const ref = `${randomUUID()}:selected`;
    const result = BrowserInspectionSchema.parse({ ...await this.describe(node) as object, ref, documentId });
    this.assertDocument(documentId);
    if (generation !== this.generation) return;
    this.refs.set(ref, node);
    this.selectedNode = node;
    this.inspection = result;
  }

  async capture(scope: BrowserAction['scope'] = 'viewport', format: BrowserAction['format'] = DEFAULT_SCREENSHOT_FORMAT, quality: BrowserAction['quality'] = DEFAULT_SCREENSHOT_QUALITY, signal?: AbortSignal): Promise<NonNullable<BrowserResult['screenshot']>> {
    const documentId = this.documentId;
    const lifetime = new AbortController();
    const destroyed = (): void => lifetime.abort();
    this.wc.once('destroyed', destroyed);
    const cancelled = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
    const check = (): void => {
      this.assertDocument(documentId);
      if (cancelled.aborted) throw new BrowserOperationError('cancelled', 'Browser capture cancelled.');
    };
    try {
      check();
      await this.cancelInspect();
      // Native captures include the inspector overlay; disable it before requesting page pixels.
      await this.command('Overlay.disable').catch(() => undefined);
      const image = await this.capturePixels(scope, check);
      check();
      const result = await encodeScreenshot(image, format, quality, cancelled);
      check();
      return result;
    } finally {
      this.wc.off('destroyed', destroyed);
    }
  }

  private async capturePixels(scope: BrowserAction['scope'], check: () => void): Promise<NativeImage> {
    // Cancellation releases the action queue immediately. Finish restoring an older capture's
    // virtual viewport before another capture can change it.
    const pending = this.pixelCapture.then(() => { check(); return this.captureNativePixels(scope, check); });
    this.pixelCapture = pending.then(() => undefined, () => undefined);
    return pending;
  }

  private async captureNativePixels(scope: BrowserAction['scope'], check: () => void): Promise<NativeImage> {
    if (scope === 'viewport') return this.wc.capturePage(undefined, { stayHidden: true, stayAwake: true });
    const metrics = await this.command<{
      cssContentSize: { x: number; y: number; width: number; height: number };
      cssLayoutViewport: { pageX: number; pageY: number; clientWidth: number; clientHeight: number };
      layoutViewport: { clientWidth: number };
    }>('Page.getLayoutMetrics');
    check();
    let clip = metrics.cssContentSize;
    if (scope === 'selection') {
      if (!this.selectedNode || !this.inspection) throw new BrowserOperationError('invalid', 'Inspect an element before capturing its selection.');
      const node = this.selectedNode;
      const ref = this.inspection.ref;
      const describe = async (scrollIntoView = false): Promise<void> => {
        const value = await this.describe(node, scrollIntoView) as { viewport: typeof metrics.cssLayoutViewport };
        clip = BrowserInspectionSchema.parse({ ...value, ref, documentId: this.documentId }).bounds;
        metrics.cssLayoutViewport = value.viewport;
      };
      await describe();
      const originalViewport = metrics.cssLayoutViewport;
      let scrolled = false;
      try {
        const outside = (): boolean => clip.x < metrics.cssLayoutViewport.pageX || clip.y < metrics.cssLayoutViewport.pageY || clip.x + clip.width > metrics.cssLayoutViewport.pageX + metrics.cssLayoutViewport.clientWidth || clip.y + clip.height > metrics.cssLayoutViewport.pageY + metrics.cssLayoutViewport.clientHeight;
        if (outside()) {
          scrolled = true;
          await describe(true);
          check();
        }
        const viewport = metrics.cssLayoutViewport;
        const zoom = this.wc.getZoomFactor();
        // DOM bounds use document CSS pixels; capturePage rectangles use viewport DIP coordinates.
        // Changing the virtual viewport moves fixed/sticky elements away from the measured crop.
        const x = (clip.x - viewport.pageX) * zoom;
        const y = (clip.y - viewport.pageY) * zoom;
        // Scroll positions are rounded CSS pixels, whereas DOM rectangles can have fractional edges.
        if (clip.width <= 0 || clip.height <= 0 || clip.x < viewport.pageX - 1 || clip.y < viewport.pageY - 1 || clip.x + clip.width > viewport.pageX + viewport.clientWidth + 1 || clip.y + clip.height > viewport.pageY + viewport.clientHeight + 1) throw new BrowserOperationError('invalid', 'The selected element does not fit in the viewport. Zoom out or capture the whole page.');
        const left = Math.max(0, Math.floor(x));
        const top = Math.max(0, Math.floor(y));
        const right = Math.min(Math.ceil(viewport.clientWidth * zoom), Math.ceil(x + clip.width * zoom));
        const bottom = Math.min(Math.ceil(viewport.clientHeight * zoom), Math.ceil(y + clip.height * zoom));
        check();
        return await this.wc.capturePage({ x: left, y: top, width: right - left, height: bottom - top }, { stayHidden: true, stayAwake: true });
      } finally {
        if (scrolled && !this.wc.isDestroyed()) await this.command('Runtime.evaluate', { expression: `window.scrollTo({left:${originalViewport.pageX},top:${originalViewport.pageY},behavior:'instant'})` });
      }
    }
    if (clip.width <= 0 || clip.height <= 0 || clip.x < 0 || clip.y < 0 || clip.width * clip.height > 16_000_000 || clip.width > 10_000 || clip.height > 16_000) throw new BrowserOperationError('invalid', 'This capture is too large or has no visible area. Choose the viewport or a smaller element.');
    check();
    const viewport = metrics.cssLayoutViewport;
    const density = metrics.layoutViewport.clientWidth / viewport.clientWidth;
    const scale = Math.min(1, 1440 / (clip.width * density));
    try {
      // Raw capture avoids Page.captureScreenshot: its PNG codec also runs on Chromium's UI thread.
      // Expand the virtual surface so content outside the viewport is painted, then restore it before encoding.
      await this.command('Emulation.setDeviceMetricsOverride', {
        width: Math.ceil(Math.max(viewport.clientWidth, clip.x + clip.width)),
        height: Math.ceil(Math.max(viewport.clientHeight, clip.y + clip.height)),
        deviceScaleFactor: 0,
        mobile: false,
        viewport: { ...clip, scale },
      });
      check();
      return await this.wc.capturePage(undefined, { stayHidden: true, stayAwake: true });
    } finally {
      if (!this.wc.isDestroyed()) {
        await this.command('Emulation.clearDeviceMetricsOverride');
        if (viewport.pageX || viewport.pageY) await this.command('Runtime.evaluate', {
          expression: `window.scrollTo({left:${viewport.pageX},top:${viewport.pageY},behavior:'instant'})`,
        });
      }
    }
  }
}
