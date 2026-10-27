import { randomUUID } from 'node:crypto';
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { BrowserOperationError, type BrowserFailureCode, type BrowserAction, type BrowserResult, type OpenPathResult, emptyBrowserState } from '@pi-kit/protocol';

const ANSWER_TIMEOUT_MS = 8000;

interface DesktopAnswer {
  type: 'desktop-answer';
  id: string;
  error?: string;
  errorCode?: BrowserFailureCode;
  result?: unknown;
}
interface PendingRequest {
  answer(message: DesktopAnswer): void;
  fail(error: BrowserOperationError): void;
}

/** What Electron main's electron-updater reports. */
export type AppUpdateAction = 'check' | 'download' | 'install';
export interface AppUpdateResult {
  available?: boolean;
  version?: string;
  downloaded?: boolean;
  unavailable?: string;
}
export type AppUpdateEvent =
  | { kind: 'checking' }
  | { kind: 'available'; version: string }
  | { kind: 'none' }
  | { kind: 'progress'; percent: number; bytesPerSecond: number }
  | { kind: 'downloaded'; version: string }
  | { kind: 'error'; message: string };

/** Owns correlated desktop IPC requests, cancellation and process-listener lifetime. */
@Injectable()
export class DesktopBridge implements OnModuleDestroy {
  private readonly waiting = new Map<string, PendingRequest>();
  private readonly updateListeners = new Set<(event: AppUpdateEvent) => void>();
  private stopped = false;
  private readonly message = (message: unknown): void => this.onMessage(message);
  private readonly disconnected = (): void => this.onModuleDestroy();

  constructor() {
    if (this.available) {
      process.on('message', this.message);
      process.on('disconnect', this.disconnected);
    }
  }

  get available(): boolean {
    return !this.stopped && process.env['PI_KIT_DESKTOP'] === '1' && typeof process.send === 'function' && process.connected !== false;
  }

  browser(threadId: string, request?: BrowserAction, signal?: AbortSignal): Promise<BrowserResult> {
    if (!this.available) return Promise.resolve({ state: emptyBrowserState(threadId, false) });
    return this.exchange('browser', { threadId, ...(request ? { request } : {}) }, 30_000, signal, true);
  }

  openPath(path: string): Promise<OpenPathResult> {
    return this.open('open-path', path, 'Opening a file in your editor needs the desktop app.');
  }

  revealPath(path: string): Promise<OpenPathResult> {
    return this.open('reveal-path', path, 'Revealing a file in the file manager needs the desktop app.');
  }

  appUpdate(action: AppUpdateAction): Promise<AppUpdateResult> {
    if (!this.available) return Promise.resolve({ unavailable: 'pi-kit updates itself in the desktop app, not in the browser.' });
    return this.exchange('app-update', { action }, action === 'download' ? 30 * 60_000 : 60_000).then((result) => (result ?? {}) as AppUpdateResult);
  }

  onAppUpdate(listener: (event: AppUpdateEvent) => void): () => void {
    this.updateListeners.add(listener);
    return () => this.updateListeners.delete(listener);
  }

  onModuleDestroy(): void {
    if (this.stopped) return;
    this.stopped = true;
    process.off('message', this.message);
    process.off('disconnect', this.disconnected);
    const error = new BrowserOperationError('unavailable', 'The desktop connection closed.');
    for (const request of [...this.waiting.values()]) request.fail(error);
    this.updateListeners.clear();
  }

  private async open(type: 'open-path' | 'reveal-path', path: string, unavailable: string): Promise<OpenPathResult> {
    if (!this.available) return { opened: false, reason: unavailable };
    try {
      await this.exchange(type, { path }, ANSWER_TIMEOUT_MS);
      return { opened: true };
    } catch (error) {
      return { opened: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  private exchange<T>(type: string, payload: Record<string, unknown>, timeout: number, signal?: AbortSignal, cancellable = false): Promise<T> {
    if (signal?.aborted) return Promise.reject(new BrowserOperationError('cancelled', 'Browser action cancelled.'));
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const cancelInDesktop = (): void => {
        if (cancellable && process.connected !== false) {
          try { process.send?.({ type: 'browser-cancel', id }, () => undefined); } catch { /* disconnected */ }
        }
      };
      const finish = (error?: BrowserOperationError, answer?: DesktopAnswer): void => {
        if (!this.waiting.delete(id)) return;
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
        if (error) reject(error);
        else resolve(answer?.result as T);
      };
      const cancel = (): void => {
        cancelInDesktop();
        finish(new BrowserOperationError('cancelled', 'Browser action cancelled.'));
      };
      const timer = setTimeout(() => {
        cancelInDesktop();
        finish(new BrowserOperationError('timeout', 'The desktop app did not answer in time.'));
      }, timeout);
      timer.unref();
      this.waiting.set(id, {
        answer: (answer) => finish(answer.error ? new BrowserOperationError(answer.errorCode ?? 'failed', answer.error) : undefined, answer),
        fail: (error) => { cancelInDesktop(); finish(error); },
      });
      signal?.addEventListener('abort', cancel, { once: true });
      try {
        process.send?.({ type, id, ...payload }, (cause: Error | null) => {
          if (cause) finish(new BrowserOperationError('unavailable', 'The desktop connection closed.', { cause }));
        });
      } catch (cause) {
        finish(new BrowserOperationError('unavailable', 'The desktop connection closed.', { cause }));
      }
    });
  }

  private onMessage(message: unknown): void {
    const event = message as { type?: string; event?: AppUpdateEvent } | undefined;
    if (event?.type === 'app-update-event' && event.event) {
      for (const listener of this.updateListeners) listener(event.event);
      return;
    }
    const answer = message as Partial<DesktopAnswer> | undefined;
    if (answer?.type !== 'desktop-answer' || typeof answer.id !== 'string') return;
    this.waiting.get(answer.id)?.answer(answer as DesktopAnswer);
  }
}
