import { randomUUID } from 'node:crypto';
import { BrowserWindow, WebContentsView, type WebContents } from 'electron';
import {
  BROWSER_STEP_TIMEOUT_MS,
  BrowserActionSchema,
  BrowserOperationError,
  type BrowserAction,
  type BrowserResult,
  type BrowserState,
  type BrowserViewport,
  emptyBrowserState,
} from '@pi-kit/protocol';
import { BrowserDiagnostics } from './browser-diagnostics';
import { browserStep } from './browser-step';

interface BrowserPage {
  view: WebContentsView;
  refs: Map<string, number>;
  diagnostics: BrowserDiagnostics;
  error?: string;
  /** Actual native parent, independent of the renderer's requested viewport. */
  host?: BrowserWindow;
  fallback?: BrowserWindow;
}
interface RemoteResult {
  result: { value?: unknown; objectId?: string; description?: string };
  exceptionDetails?: { text: string; exception?: { description?: string } };
}
interface AxNode {
  ignored?: boolean;
  backendDOMNodeId?: number;
  role?: { value?: string };
  name?: { value?: string };
  value?: { value?: unknown };
}

export function browserUrl(value: string, blockedOrigins: readonly string[] = []): string {
  const source = value.trim();
  const local = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])(?::|\/|$)/i.test(source);
  const explicitScheme = /^[a-z][a-z\d+.-]*:/i.test(source) && !local && !/^[^/\s]+:\d+(?:\/|$)/.test(source);
  let url: URL;
  try {
    url = new URL(explicitScheme ? source : `${local ? 'http' : 'https'}://${source}`);
  } catch (cause) {
    throw new BrowserOperationError('invalid', 'Enter a valid HTTP(S) project address.', { cause });
  }
  if (!['http:', 'https:'].includes(url.protocol) || blockedOrigins.includes(url.origin))
    throw new BrowserOperationError('invalid', 'Open an HTTP(S) project page, not a pi-kit application page.');
  return url.href;
}

/** Literal loopback destinations only: never LAN hosts, wildcard binds, or names merely containing localhost. */
export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host === '::1' || host === '[::1]') return true;
  const parts = host.split('.');
  return (
    parts.length === 4 && parts[0] === '127' && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  );
}

/** Sandboxed, per-chat Chromium pages. The app's renderer, preload and backend token never enter these pages. */
export class BrowserArtifacts {
  private readonly pages = new Map<string, BrowserPage>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private viewport?: BrowserViewport & { window: BrowserWindow };
  private allowInvalidLocalCertificates = false;
  private disposed = false;

  /** Trusted renderer only; never exposed as an agent browser action. Drop sessions to clear cached TLS exceptions. */
  setAllowInvalidLocalCertificates(enabled: boolean): void {
    if (this.allowInvalidLocalCertificates === enabled) return;
    this.allowInvalidLocalCertificates = enabled;
    for (const id of this.pages.keys()) this.close(id);
  }

  constructor(
    private readonly blockedOrigins: () => readonly string[] = () => [],
    private readonly maxPages = 8,
    private readonly stepTimeoutMs = BROWSER_STEP_TIMEOUT_MS,
  ) {}

  state(threadId: string): BrowserState {
    const page = this.pages.get(threadId);
    if (!page || page.view.webContents.isDestroyed()) return emptyBrowserState(threadId, true);
    const wc = page.view.webContents;
    return {
      available: true,
      threadId,
      open: true,
      url: wc.getURL(),
      title: wc.getTitle(),
      loading: wc.isLoading(),
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
      documentId: page.diagnostics.documentId,
      inspecting: page.diagnostics.inspecting,
      inspection: page.diagnostics.inspection,
      consoleCount: page.diagnostics.logs.length,
      ...(page.error ? { error: page.error } : {}),
    };
  }

  /** Layout updates may move only the selected chat's view. An old component cannot hide a newer viewport. */
  layout(window: BrowserWindow, viewport: BrowserViewport): void {
    if (!viewport.bounds && this.viewport?.owner !== viewport.owner) return;
    if (
      this.viewport &&
      (!viewport.bounds || this.viewport.threadId !== viewport.threadId || this.viewport.owner !== viewport.owner)
    )
      void this.pages.get(this.viewport.threadId)?.diagnostics.cancelInspect();
    this.viewport = viewport.bounds ? { ...viewport, window } : undefined;
    this.attach();
  }

  async run(threadId: string, input: BrowserAction, signal?: AbortSignal): Promise<BrowserResult> {
    const action = BrowserActionSchema.parse(input);
    if (this.disposed)
      throw new BrowserOperationError('unavailable', 'The browser was closed with its desktop window.');
    const request = new AbortController();
    const requestSignal = signal ? AbortSignal.any([signal, request.signal]) : request.signal;
    const previous = this.queues.get(threadId) ?? Promise.resolve();
    const pending = previous
      .catch(() => undefined)
      .then(async () => {
        if (this.disposed || requestSignal.aborted)
          throw new BrowserOperationError('cancelled', 'Browser action cancelled.');
        if (action.action === 'close') {
          this.close(threadId);
          return { state: this.state(threadId) };
        }
        const page = this.page(threadId);
        const wc = page.view.webContents;
        let interrupt!: (error: Error) => void;
        const interrupted = new Promise<never>((_resolve, reject) => {
          interrupt = reject;
        });
        const lifetime = new AbortController();
        const activeSignal = AbortSignal.any([requestSignal, lifetime.signal]);
        const stopped = (): void =>
          interrupt(
            new BrowserOperationError(
              'unavailable',
              'The browser page stopped. Navigate to the project again to continue.',
            ),
          );
        wc.once('render-process-gone', stopped);
        wc.once('destroyed', stopped);
        try {
          return await browserStep(
            () =>
              Promise.race([
                interrupted,
                (async () => {
                  page.diagnostics.assertDocument(action.documentId);
                  if (action.action !== 'navigate' && !wc.getURL())
                    throw new BrowserOperationError('invalid', 'Navigate to a project page first.');
                  const documentId = page.diagnostics.documentId;
                  const text = await this.act(page, action, activeSignal);
                  await page.diagnostics.ready;
                  if (activeSignal.aborted) throw new BrowserOperationError('cancelled', 'Browser action cancelled.');
                  const screenshot =
                    action.action === 'screenshot'
                      ? await page.diagnostics.capture(action.scope, action.format, action.quality, activeSignal)
                      : undefined;
                  if (screenshot) page.diagnostics.assertDocument(documentId);
                  return {
                    state: this.state(threadId),
                    ...(text !== undefined ? { text } : {}),
                    ...(screenshot ? { screenshot } : {}),
                    ...(action.action === 'console' ? { logs: [...page.diagnostics.logs] } : {}),
                  };
                })(),
              ]),
            'The browser action stalled. Navigate to the project again to retry.',
            {
              signal: requestSignal,
              timeoutMs: this.stepTimeoutMs,
              interrupted: () => {
                lifetime.abort();
                if (!wc.isDestroyed()) {
                  wc.stop();
                  if (wc.debugger.isAttached())
                    void this.command(wc, 'Runtime.terminateExecution').catch(() => undefined);
                }
                // CDP/native promises can outlive any cancelled action (not just capture).
                // Never let its late continuation change the next action's page or references.
                if (this.pages.get(threadId) === page) this.close(threadId);
              },
            },
          );
        } finally {
          wc.off('render-process-gone', stopped);
          wc.off('destroyed', stopped);
        }
      });
    this.queues.set(threadId, pending);
    const settled = (): void => {
      if (this.queues.get(threadId) === pending) this.queues.delete(threadId);
    };
    void pending.then(settled, settled);
    // Queue waiting belongs to the same deadline. Cancelling a queued action does not
    // remove its sequencing slot or interrupt the different action ahead of it.
    return browserStep(() => pending, 'The browser action took too long. Navigate to the project again to retry.', {
      signal,
      timeoutMs: this.stepTimeoutMs,
      interrupted: () => request.abort(),
    });
  }

  close(threadId: string): void {
    const page = this.pages.get(threadId);
    if (!page) return;
    // Delete first: native destruction events can re-enter cleanup.
    this.pages.delete(threadId);
    this.releaseHost(page);
    if (!page.view.webContents.isDestroyed()) page.view.webContents.close();
  }

  dispose(): void {
    this.disposed = true;
    this.viewport = undefined;
    for (const id of this.pages.keys()) this.close(id);
  }

  private page(threadId: string): BrowserPage {
    const existing = this.pages.get(threadId);
    if (existing && !existing.view.webContents.isDestroyed()) return existing;
    if (existing) this.close(threadId);
    if (this.pages.size >= this.maxPages) {
      const idle = [...this.pages.keys()].find((id) => id !== this.viewport?.threadId && !this.queues.has(id));
      if (!idle)
        throw new BrowserOperationError('unavailable', 'Close an unused browser artifact before opening another.');
      this.close(idle);
    }
    const view = new WebContentsView({
      webPreferences: {
        partition: `pi-kit-browser-${threadId}-${randomUUID()}`,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    view.setBounds({ x: 0, y: 0, width: 1024, height: 768 });
    const refs = new Map<string, number>();
    const page: BrowserPage = {
      view,
      refs,
      diagnostics: new BrowserDiagnostics(view.webContents, refs, this.stepTimeoutMs),
    };
    this.pages.set(threadId, page);
    const wc = view.webContents;
    wc.once('destroyed', () => {
      if (this.pages.get(threadId) === page) this.pages.delete(threadId);
      this.releaseHost(page);
    });
    const allowLocal = this.allowInvalidLocalCertificates;
    wc.session.setCertificateVerifyProc((request, callback) => {
      // -3 delegates to Chromium's normal verification; 0 accepts only an explicitly opted-in loopback host.
      callback(allowLocal && isLoopbackHostname(request.hostname) ? 0 : -3);
    });
    wc.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    wc.session.setPermissionCheckHandler(() => false);
    wc.session.on('will-download', (event) => event.preventDefault());
    const allowed = (url: string): boolean => {
      try {
        return browserUrl(url, this.blockedOrigins()) === url;
      } catch {
        return false;
      }
    };
    // Protect the app itself on redirects and page-initiated navigations as well as agent calls.
    wc.on('will-navigate', (event, url) => {
      if (!allowed(url)) event.preventDefault();
    });
    wc.on('will-redirect', (event, url) => {
      if (!allowed(url)) event.preventDefault();
    });
    wc.setWindowOpenHandler(({ url }) => {
      if (allowed(url)) void wc.loadURL(url).catch(() => undefined);
      return { action: 'deny' };
    });
    wc.on('did-navigate', () => {
      page.refs.clear();
      page.error = undefined;
    });
    wc.on('did-navigate-in-page', () => page.refs.clear());
    wc.on('did-fail-load', (_event, code, description, _url, mainFrame) => {
      if (mainFrame && code !== -3) page.error = description;
    });
    wc.on('render-process-gone', () => {
      page.error = 'The browser page stopped. Reload to continue.';
    });
    this.attach();
    return page;
  }

  private releaseHost(page: BrowserPage): void {
    if (page.host && !page.host.isDestroyed()) page.host.contentView.removeChildView(page.view);
    page.host = undefined;
    if (page.fallback && !page.fallback.isDestroyed()) page.fallback.destroy();
    page.fallback = undefined;
  }

  /** Intersect in native coordinates; invalid/fully clipped requests never reach setBounds. */
  private visibleBounds(current: BrowserViewport & { window: BrowserWindow }): Electron.Rectangle | undefined {
    if (!current.bounds || current.window.isDestroyed()) return;
    const scale = current.window.webContents.getZoomFactor();
    const [width, height] = current.window.getContentSize();
    const { x, y, width: requestedWidth, height: requestedHeight } = current.bounds;
    if (
      ![x, y, requestedWidth, requestedHeight, scale, width, height].every(Number.isFinite) ||
      requestedWidth <= 0 ||
      requestedHeight <= 0 ||
      scale <= 0
    )
      return;
    const left = Math.max(0, Math.round(x * scale));
    const top = Math.max(0, Math.round(y * scale));
    const right = Math.min(width, Math.round((x + requestedWidth) * scale));
    const bottom = Math.min(height, Math.round((y + requestedHeight) * scale));
    if (![left, top, right, bottom].every(Number.isFinite) || right <= left || bottom <= top) return;
    return { x: left, y: top, width: right - left, height: bottom - top };
  }

  private attach(): void {
    const current = this.viewport;
    const bounds = current && this.visibleBounds(current);
    for (const [threadId, page] of this.pages) {
      const visible = current && bounds && current.threadId === threadId;
      if (!visible && (!page.fallback || page.fallback.isDestroyed())) {
        // Electron's paintWhenInitiallyHidden keeps a show:false renderer active.
        // Hidden native capture may still need a CDP surface prime (see diagnostics).
        // Keep a normal composited view: offscreen views cannot be assumed to embed visibly.
        page.fallback = new BrowserWindow({
          width: 1024,
          height: 768,
          useContentSize: true,
          show: false,
          focusable: false,
          skipTaskbar: true,
          paintWhenInitiallyHidden: true,
          webPreferences: {
            contextIsolation: true,
            sandbox: true,
            nodeIntegration: false,
            backgroundThrottling: false,
          },
        });
      }
      const host = visible ? current.window : page.fallback;
      if (!host) continue;
      if (page.host !== host) {
        if (page.host && !page.host.isDestroyed()) page.host.contentView.removeChildView(page.view);
        page.host = host;
        page.view.setBounds(visible ? bounds : { x: 0, y: 0, width: 1024, height: 768 });
        host.contentView.addChildView(page.view);
      } else if (visible) {
        // Bounds-only updates must not detach/re-add: that churns Chromium surfaces.
        page.view.setBounds(bounds);
      }
      // The fallback is only needed while hidden; do not retain idle native windows.
      if (visible && page.fallback) {
        if (!page.fallback.isDestroyed()) page.fallback.destroy();
        page.fallback = undefined;
      }
    }
  }

  private async command<T>(wc: WebContents, method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
    return wc.debugger.sendCommand(method, params) as Promise<T>;
  }

  private value(answer: RemoteResult): unknown {
    if (answer.exceptionDetails)
      throw new BrowserOperationError(
        'invalid',
        answer.exceptionDetails.exception?.description ??
          answer.exceptionDetails.text ??
          'The browser expression failed.',
      );
    return answer.result.value;
  }

  private async evaluate(wc: WebContents, expression: string): Promise<unknown> {
    return this.value(
      await this.command<RemoteResult>(wc, 'Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
        timeout: BROWSER_STEP_TIMEOUT_MS,
      }),
    );
  }

  private async element(page: BrowserPage, ref: string, fn: string): Promise<unknown> {
    const backendNodeId = page.refs.get(ref);
    if (!backendNodeId)
      throw new BrowserOperationError('invalid', 'Unknown or stale element reference. Take a new snapshot first.');
    const resolved = await this.command<{ object: { objectId: string } }>(page.view.webContents, 'DOM.resolveNode', {
      backendNodeId,
    });
    const objectId = resolved.object.objectId;
    try {
      return this.value(
        await this.command<RemoteResult>(page.view.webContents, 'Runtime.callFunctionOn', {
          objectId,
          functionDeclaration: fn,
          returnByValue: true,
          userGesture: true,
        }),
      );
    } finally {
      await this.command(page.view.webContents, 'Runtime.releaseObject', { objectId });
    }
  }

  /** Register before history/reload starts so the next action observes the new document. */
  private loaded(wc: WebContents, navigate: () => void, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const finish = (error?: Error): void => {
        clearTimeout(timer);
        wc.off('did-stop-loading', done);
        wc.off('destroyed', stopped);
        wc.off('render-process-gone', stopped);
        signal?.removeEventListener('abort', cancelled);
        if (error) reject(error);
        else resolve();
      };
      const done = (): void => finish();
      const stopped = (): void =>
        finish(new BrowserOperationError('unavailable', 'The browser page stopped. Reload to continue.'));
      const cancelled = (): void => finish(new BrowserOperationError('cancelled', 'Browser action cancelled.'));
      const timer = setTimeout(() => {
        finish(new BrowserOperationError('timeout', 'The page took too long to load.'));
        wc.stop();
      }, BROWSER_STEP_TIMEOUT_MS);
      wc.once('did-stop-loading', done);
      wc.once('destroyed', stopped);
      wc.once('render-process-gone', stopped);
      signal?.addEventListener('abort', cancelled, { once: true });
      try {
        if (signal?.aborted) throw new BrowserOperationError('cancelled', 'Browser action cancelled.');
        navigate();
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private async act(page: BrowserPage, action: BrowserAction, signal?: AbortSignal): Promise<string | undefined> {
    const wc = page.view.webContents;
    switch (action.action) {
      case 'navigate':
        page.error = undefined;
        await wc.loadURL(browserUrl(action.url ?? '', this.blockedOrigins()));
        await page.diagnostics.render(signal);
        return 'Page loaded. Use snapshot to inspect its content and controls.';
      case 'back':
        if (wc.navigationHistory.canGoBack()) await this.loaded(wc, () => wc.navigationHistory.goBack(), signal);
        return;
      case 'forward':
        if (wc.navigationHistory.canGoForward()) await this.loaded(wc, () => wc.navigationHistory.goForward(), signal);
        return;
      case 'reload':
        await this.loaded(wc, () => wc.reload(), signal);
        return;
      case 'snapshot': {
        await page.diagnostics.render(signal);
        await this.command(wc, 'Accessibility.enable');
        const { nodes } = await this.command<{ nodes: AxNode[] }>(wc, 'Accessibility.getFullAXTree');
        page.refs.clear();
        const prefix = randomUUID();
        const lines: string[] = [];
        let length = 0;
        for (const node of nodes) {
          if (node.ignored || !node.role?.value) continue;
          const ref = `${prefix}:${page.refs.size + 1}`;
          if (node.backendDOMNodeId) page.refs.set(ref, node.backendDOMNodeId);
          const line = `${node.backendDOMNodeId ? `[${ref}] ` : ''}${node.role.value} ${JSON.stringify(node.name?.value ?? '')}${node.value?.value !== undefined ? ` value=${JSON.stringify(node.value.value)}` : ''}`;
          lines.push(line);
          length += line.length;
          if (length > 24_000) {
            lines.push('Snapshot truncated. Use evaluate for a focused query.');
            break;
          }
        }
        return lines.join('\n');
      }
      case 'click': {
        const point = (await this.element(
          page,
          action.ref ?? '',
          `function() { if (!this.isConnected || this.disabled) throw new Error('Element is detached or disabled.'); this.scrollIntoView({block:'center',inline:'center'}); const r = this.getBoundingClientRect(); if (!r.width || !r.height) throw new Error('Element is not visible.'); return {x:r.x+r.width/2,y:r.y+r.height/2}; }`,
        )) as { x: number; y: number };
        await page.diagnostics.render(signal);
        if (signal?.aborted) throw new BrowserOperationError('cancelled', 'Browser action cancelled.');
        await this.command(wc, 'Input.dispatchMouseEvent', {
          type: 'mousePressed',
          ...point,
          button: 'left',
          clickCount: 1,
        });
        await this.command(wc, 'Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          ...point,
          button: 'left',
          clickCount: 1,
        });
        return 'Clicked. Take a fresh snapshot to verify the result.';
      }
      case 'fill':
        await this.element(
          page,
          action.ref ?? '',
          `function() { if (!this.isConnected || this.disabled || this.readOnly) throw new Error('Element is not editable.'); this.scrollIntoView({block:'center'}); this.focus(); if (this.select) this.select(); else if (this.isContentEditable) { const r=document.createRange(); r.selectNodeContents(this); const s=getSelection(); s.removeAllRanges(); s.addRange(r); } else throw new Error('Use fill on a text field or editable element.'); }`,
        );
        if (signal?.aborted) throw new BrowserOperationError('cancelled', 'Browser action cancelled.');
        await this.command(wc, 'Input.insertText', { text: action.text ?? '' });
        return 'Field filled.';
      case 'press': {
        const parts = (action.key ?? '').split('+');
        const key = parts.pop() ?? '';
        if (key === 'Escape' && page.diagnostics.inspecting) {
          await page.diagnostics.cancelInspect();
          return 'Inspection cancelled.';
        }
        const masks: Record<string, number> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };
        const modifiers = parts.reduce((value, modifier) => value | (masks[modifier] ?? 0), 0);
        const codes: Record<string, number> = {
          Enter: 13,
          Tab: 9,
          Escape: 27,
          Backspace: 8,
          Delete: 46,
          ArrowLeft: 37,
          ArrowUp: 38,
          ArrowRight: 39,
          ArrowDown: 40,
          Home: 36,
          End: 35,
          PageUp: 33,
          PageDown: 34,
          Space: 32,
        };
        const windowsVirtualKeyCode = codes[key] ?? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
        await this.command(wc, 'Input.dispatchKeyEvent', {
          type: 'keyDown',
          key,
          modifiers,
          windowsVirtualKeyCode,
          ...(!(modifiers & 6) && (key.length === 1 || key === 'Enter' || key === 'Space')
            ? { text: key === 'Enter' ? '\r' : key === 'Space' ? ' ' : key }
            : {}),
        });
        await this.command(wc, 'Input.dispatchKeyEvent', { type: 'keyUp', key, modifiers, windowsVirtualKeyCode });
        return 'Key pressed.';
      }
      case 'scroll':
        await this.evaluate(wc, `window.scrollBy(0, ${JSON.stringify(action.deltaY)})`);
        return;
      case 'evaluate': {
        const answer = await this.evaluate(wc, action.code ?? '');
        return (JSON.stringify(answer) ?? 'undefined').slice(0, 24_000);
      }
      case 'inspect':
        await page.diagnostics.inspect(action);
        return page.diagnostics.inspection
          ? JSON.stringify(page.diagnostics.inspection)
          : page.diagnostics.inspecting
            ? 'Pick an element in the visible browser. Escape cancels.'
            : 'Inspection cancelled.';
      case 'console':
        return (
          page.diagnostics.logs
            .map(
              (entry) =>
                `${entry.level}: ${entry.message}${entry.source ? ` (${entry.source}:${entry.line ?? 0})` : ''}`,
            )
            .join('\n') || 'No console messages recorded.'
        );
      case 'clear-console':
        page.diagnostics.logs.length = 0;
        return 'Console cleared.';
      default:
        return;
    }
  }
}
