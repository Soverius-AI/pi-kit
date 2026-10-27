import { randomUUID } from 'node:crypto';
import type { PendingDialog, PiUiEvent } from '@pi-kit/pi-adapter';
import { type CompleteResponse, type ComposerRegistration, ComposerRegistrationSchema, type PiDialogRequest } from '@pi-kit/protocol';
import { type AutocompleteProviderFactory, type CompleteOptions, completeThroughChain } from './autocomplete';
import { extensionNameFromStack } from './caller';

/** What a client answers a dialog with: a value, or "dismissed". */
export type DialogAnswer = { status: 'resolved'; confirmed?: boolean; value?: string } | { status: 'cancelled' };

interface Pending {
  id: string;
  request: PiDialogRequest;
  /** Delivered to a client in an interrupt already (the next `list()` only returns what is new). */
  reported: boolean;
  settle: (answer: DialogAnswer) => void;
}

interface DialogOptions {
  signal?: AbortSignal;
  timeout?: number;
}

/**
 * The host side of pi's `ExtensionUIContext` for one thread. pi has no events for
 * extension dialogs: an extension calls `ctx.ui.confirm(...)` and awaits. Here those calls become
 * pending interrupts (a promise per dialog); `PiAgent` ends the run with them, and the answer that
 * arrives with the next run resolves the promise and pi carries on. `notify`, `setStatus`,
 * `setWidget` and `setTitle` are passed on to whoever is listening (the current run).
 *
 * pi's `timeout` option is not enforced here on purpose: there may be no run attached to show a countdown, and an
 * approval that silently expires is worse than one that waits. It travels with the request instead (`timeoutMs`, `expiresAt`): the
 * question block shows the countdown and, if the user has not answered by then, answers "cancelled" itself, which is what pi's own
 * timeout would have returned. An `AbortSignal` still dismisses a dialog.
 *
 * This file does not import pi: `session-ui.ts` completes the object with pi's theme and
 * passes it to `bindExtensions({ uiContext })`.
 */
export class UiBridge {
  private readonly pending = new Map<string, Pending>();
  private readonly uiListeners = new Set<(event: PiUiEvent) => void>();
  private readonly dialogListeners = new Set<() => void>();
  /** Called whenever the set of pending dialogs changes (one opened, one answered or dismissed): the sidebar's "waiting" state follows it. */
  private readonly changeListeners = new Set<() => void>();
  /** Latest value of each status key and widget, so a late listener can be brought up to date. */
  readonly statuses = new Map<string, string>();
  private abortedWhileWaiting = false;
  /** The tool call that is running now (`session-ui.ts` keeps it from the session's events), so a dialog opened by a `tool_call` hook can say which tool. */
  activeTool: () => string | undefined = () => undefined;
  activeToolCallId: () => string | undefined = () => undefined;
  /** Autocomplete providers extensions added with `addAutocompleteProvider`, in the order they were added (cleared on reload). */
  private autocompleteFactories: AutocompleteProviderFactory[] = [];
  /** The toolbar actions and suggestions extensions registered, by id (latest wins), so a late client can be brought up to date. */
  private readonly composerById = new Map<string, Extract<ComposerRegistration, { op: 'action' | 'suggestion' }>>();
  /** Ids registered before a reload that no extension has registered again (yet); `reloading()` removes what is left. */
  private staleComposerIds: Set<string> | undefined;
  /** Called for an event that no listener was there to receive (no run is attached), so it can still reach the replay log. */
  private readonly unattachedListeners = new Set<(event: PiUiEvent) => void>();

  // ---- dialogs (promises pi awaits)

  select = (title: string, options: string[], opts?: DialogOptions): Promise<string | undefined> =>
    this.ask({ method: 'select', title, options }, opts, (a) => (a.status === 'resolved' ? a.value : undefined), undefined);

  confirm = (title: string, message: string, opts?: DialogOptions): Promise<boolean> =>
    this.ask({ method: 'confirm', title, message }, opts, (a) => a.status === 'resolved' && a.confirmed === true, false);

  input = (title: string, placeholder?: string, opts?: DialogOptions): Promise<string | undefined> =>
    this.ask({ method: 'input', title, ...(placeholder ? { placeholder } : {}) }, opts, (a) => (a.status === 'resolved' ? a.value : undefined), undefined);

  editor = (title: string, prefill?: string): Promise<string | undefined> =>
    this.ask({ method: 'editor', title, ...(prefill ? { prefill } : {}) }, undefined, (a) => (a.status === 'resolved' ? a.value : undefined), undefined);

  private ask<T>(request: PiDialogRequest, opts: DialogOptions | undefined, parse: (answer: DialogAnswer) => T, dismissed: T): Promise<T> {
    if (opts?.signal?.aborted) return Promise.resolve(dismissed);
    const id = randomUUID();
    request = { ...request, ...this.originOf(opts?.timeout) };
    return new Promise<T>((resolve) => {
      const onAbort = () => finish({ status: 'cancelled' });
      const finish = (answer: DialogAnswer) => {
        opts?.signal?.removeEventListener('abort', onAbort);
        this.pending.delete(id);
        resolve(parse(answer));
        this.notifyChange();
      };
      opts?.signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, { id, request, reported: false, settle: finish });
      for (const listener of [...this.dialogListeners]) listener();
      this.notifyChange();
    });
  }

  /** Who is asking and how long they wait: the extension from the call site, the tool that is running, pi's timeout. */
  private originOf(timeout: number | undefined): Partial<PiDialogRequest> {
    const limit = Error.stackTraceLimit;
    Error.stackTraceLimit = 40;
    const stack = new Error().stack;
    Error.stackTraceLimit = limit;
    const source = extensionNameFromStack(stack);
    const tool = this.activeTool();
    const toolCallId = this.activeToolCallId();
    const timed = typeof timeout === 'number' && Number.isFinite(timeout) && timeout > 0;
    return {
      ...(source ? { source } : {}),
      ...(tool ? { tool } : {}),
      ...(toolCallId ? { toolCallId } : {}),
      ...(timed ? { timeoutMs: Math.round(timeout), expiresAt: Date.now() + Math.round(timeout) } : {}),
    };
  }

  // ---- host side

  /** Dialogs pi is waiting on. With `onlyNew`, those no client has been told about yet. */
  list(onlyNew = false): PendingDialog[] {
    return [...this.pending.values()].filter((p) => !onlyNew || !p.reported).map(({ id, request }) => ({ id, request }));
  }

  get size(): number {
    return this.pending.size;
  }

  markReported(ids: readonly string[]): void {
    for (const id of ids) {
      const p = this.pending.get(id);
      if (p) p.reported = true;
    }
  }

  /** Delivers an answer; false if the dialog is gone (already answered, or pi gave up on it). */
  answer(id: string, answer: DialogAnswer): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    p.settle(answer);
    return true;
  }

  /** Dismisses every dialog, so a stopped run does not leave an extension awaiting forever. */
  cancelAll(): void {
    if (this.pending.size > 0) this.abortedWhileWaiting = true;
    for (const p of [...this.pending.values()]) p.settle({ status: 'cancelled' });
  }

  /** True once if `cancelAll()` dismissed dialogs since the last call: the next resume is the end of a stopped run. */
  takeAborted(): boolean {
    const aborted = this.abortedWhileWaiting;
    this.abortedWhileWaiting = false;
    return aborted;
  }

  onUi(listener: (event: PiUiEvent) => void): () => void {
    this.uiListeners.add(listener);
    return () => this.uiListeners.delete(listener);
  }

  /** Called whenever a dialog opens or closes (it was answered, dismissed or aborted). */
  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  private notifyChange(): void {
    for (const listener of [...this.changeListeners]) {
      try {
        listener();
      } catch {
        // a listener must not break the dialog
      }
    }
  }

  /** Called whenever an extension opens a dialog. */
  onDialog(listener: () => void): () => void {
    this.dialogListeners.add(listener);
    return () => this.dialogListeners.delete(listener);
  }

  /** Receives the events that came while no run was listening (an extension registering at `session_start`, say). */
  onUnattached(listener: (event: PiUiEvent) => void): () => void {
    this.unattachedListeners.add(listener);
    return () => this.unattachedListeners.delete(listener);
  }

  private emit(event: PiUiEvent): void {
    if (this.uiListeners.size === 0) {
      for (const listener of [...this.unattachedListeners]) listener(event);
      return;
    }
    for (const listener of [...this.uiListeners]) listener(event);
  }

  // ---- autocomplete (`AutocompleteProviderFactory`)

  addAutocompleteProvider = (factory: AutocompleteProviderFactory): void => {
    if (typeof factory === 'function') this.autocompleteFactories.push(factory);
  };

  get autocompleteProviders(): number {
    return this.autocompleteFactories.length;
  }

  /** The suggestions of the extensions' provider chain at `cursor` in `text`, each with the text and caret that applying it gives. */
  complete(text: string, cursor: number, options?: CompleteOptions): Promise<CompleteResponse> {
    return completeThroughChain(this.autocompleteFactories, text, cursor, options);
  }

  // ---- toolbar actions and suggestions (the `pi-kit:composer` channel of pi's event bus)

  /**
   * Validates what an extension emitted and relays it as a `composer` event. Returns false for a payload that is not a valid
   * registration (dropped, never thrown into the extension). A registration identical to the one already held is not repeated.
   */
  registerComposer(payload: unknown): boolean {
    const parsed = ComposerRegistrationSchema.safeParse(payload);
    if (!parsed.success) return false;
    const registration = parsed.data;
    this.staleComposerIds?.delete(registration.id);
    if (registration.op === 'remove') {
      if (!this.composerById.delete(registration.id)) return true;
    } else {
      const held = this.composerById.get(registration.id);
      if (held && JSON.stringify(held) === JSON.stringify(registration)) return true;
      this.composerById.set(registration.id, registration);
    }
    this.emit({ kind: 'composer', registration });
    return true;
  }

  /** What the extensions have registered now (registration order; a re-registered id keeps its place). */
  composerRegistrations(): ComposerRegistration[] {
    return [...this.composerById.values()];
  }

  // ---- extension lifetime

  /**
   * Runs pi's `reload()`: the extensions are loaded again and register everything again, so what the old ones added is
   * dropped first (autocomplete providers would otherwise pile up). Toolbar actions and suggestions the reloaded extensions do
   * not register again are removed afterwards.
   */
  async reloading(reload: () => Promise<void>): Promise<void> {
    this.autocompleteFactories = [];
    this.staleComposerIds = new Set(this.composerById.keys());
    try {
      await reload();
    } finally {
      const stale = this.staleComposerIds;
      this.staleComposerIds = undefined;
      for (const id of stale) this.registerComposer({ op: 'remove', id });
    }
  }

  /** The session is closed: nothing an extension added outlives it. */
  clearExtensions(): void {
    this.autocompleteFactories = [];
    this.composerById.clear();
    this.staleComposerIds = undefined;
  }

  // ---- fire-and-forget methods

  notify = (message: string, type?: 'info' | 'warning' | 'error'): void => this.emit({ kind: 'notify', message, level: type });

  setStatus = (key: string, text: string | undefined): void => {
    // Preserve extension colours for the renderer, including persisted status events.
    if (text === undefined) this.statuses.delete(key);
    else this.statuses.set(key, text);
    this.emit({ kind: 'status', key, text });
  };

  setTitle = (title: string): void => this.emit({ kind: 'title', title });

  setWidget = (key: string, content: unknown, options?: { placement?: 'aboveEditor' | 'belowEditor' }): void => {
    // Component factories need a terminal; only string lists can be shown.
    if (content !== undefined && !Array.isArray(content)) return;
    this.emit({ kind: 'widget', key, lines: content as string[] | undefined, placement: options?.placement });
  };

  /**
   * The object handed to pi. TUI-only methods are no-ops (as in pi's own RPC mode); the `theme` and
   * theme methods are supplied by the caller because they come from pi.
   */
  context(extra: { theme: unknown }): Record<string, unknown> {
    const noop = (): void => undefined;
    return {
      select: this.select,
      confirm: this.confirm,
      input: this.input,
      editor: this.editor,
      notify: this.notify,
      setStatus: this.setStatus,
      setTitle: this.setTitle,
      setWidget: this.setWidget,
      onTerminalInput: () => noop,
      setWorkingMessage: noop,
      setWorkingVisible: noop,
      setWorkingIndicator: noop,
      setHiddenThinkingLabel: noop,
      setFooter: noop,
      setHeader: noop,
      custom: () => Promise.resolve(undefined),
      pasteToEditor: noop,
      setEditorText: noop,
      getEditorText: () => '',
      addAutocompleteProvider: this.addAutocompleteProvider,
      setEditorComponent: noop,
      getEditorComponent: () => undefined,
      get theme() {
        return extra.theme;
      },
      getAllThemes: () => [],
      getTheme: () => undefined,
      setTheme: () => ({ success: false, error: 'Theme switching is not supported here.' }),
      getToolsExpanded: () => false,
      setToolsExpanded: noop,
    };
  }
}
