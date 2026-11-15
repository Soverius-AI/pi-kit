import { DatePipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { ApiClient, errorMessage, sessionCompact, unwrap } from '@pi-kit/api';
import { UiStore } from '@pi-kit/data-access';
import { Language, TranslocoPipe } from '@pi-kit/i18n';
import type { ExternalSession } from '@pi-kit/protocol';
import { ThreadsStore } from '@pi-kit/threads/api';

/** One project’s on-demand import review. Imports finish before optional compaction, so a model failure never loses a snapshot. */
@Component({
  selector: 'pk-session-imports',
  imports: [DatePipe, TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section
      class="pk-group"
      data-testid="session-imports"
      [attr.aria-label]="'settings.sessionImports.title' | transloco"
    >
      <header>
        <div>
          <h4>{{ 'settings.sessionImports.title' | transloco }}</h4>
          <p>{{ 'settings.sessionImports.description' | transloco }}</p>
        </div>
        <button
          type="button"
          class="btn btn-sm btn-ghost"
          data-testid="check-imports"
          [disabled]="loading() || busy()"
          (click)="check()"
        >
          {{ (loading() ? 'settings.sessionImports.checking' : 'settings.sessionImports.check') | transloco }}
        </button>
      </header>
      <p class="hint px-4 py-3">{{ 'settings.sessionImports.warning' | transloco }}</p>
      @if (error()) {
        <div class="px-4 py-3 text-error" role="alert">{{ error() }}</div>
      }
      @if (unavailable()) {
        <div class="hint px-4 py-3">
          {{ 'settings.sessionImports.unavailable' | transloco: { sources: unavailable() } }}
        </div>
      }
      @if (skipped()) {
        <div class="hint px-4 py-3">{{ 'settings.sessionImports.skipped' | transloco: { count: skipped() } }}</div>
      }
      @for (session of sessions(); track session.key) {
        <div class="row" [attr.data-testid]="'import-session-' + session.key">
          <label class="flex min-w-0 flex-1 items-start gap-3">
            <input
              type="checkbox"
              class="checkbox checkbox-sm mt-1"
              [disabled]="busy() || session.status === 'imported'"
              [checked]="selected().has(session.key)"
              (change)="toggle(session.key, $any($event.target).checked)"
            />
            <span class="min-w-0">
              <span class="lbl break-words">{{ session.title }}</span>
              <span class="hint block"
                >{{ sourceName(session.source) }} · {{ session.updatedAt | date: 'short' }} ·
                {{ statusName(session.status) }}</span
              >
            </span>
          </label>
          <div class="ctl ctl-w">
            @if (session.importedThreadId; as id) {
              <button type="button" class="btn btn-sm btn-ghost" [disabled]="busy()" (click)="open(id)">
                {{ 'settings.sessionImports.open' | transloco }}
              </button>
            }
          </div>
          @if (failures()[session.key]; as failure) {
            <div class="basis-full text-sm text-error" role="alert">{{ failure.message }}</div>
            @if (failure.threadId; as id) {
              <button
                type="button"
                class="btn btn-sm btn-ghost"
                [attr.data-testid]="'retry-compact-' + session.key"
                [disabled]="busy()"
                (click)="retryCompact(session.key, id)"
              >
                {{ 'settings.sessionImports.retryCompact' | transloco }}
              </button>
            }
          }
        </div>
      } @empty {
        @if (!loading() && !error()) {
          <div class="hint px-4 py-3">{{ 'settings.sessionImports.empty' | transloco }}</div>
        }
      }
      @if (sessions().length) {
        <div class="row">
          <div class="min-w-0">
            <div class="lbl">{{ 'settings.sessionImports.compact' | transloco }}</div>
            <p class="hint">{{ 'settings.sessionImports.compactHint' | transloco }}</p>
          </div>
          <div class="ctl ctl-w">
            <label class="flex items-center gap-2">
              <input
                type="checkbox"
                class="checkbox checkbox-sm"
                data-testid="compact-imports"
                [disabled]="busy()"
                [checked]="compact()"
                (change)="compact.set($any($event.target).checked)"
              />
              <span>{{ 'settings.sessionImports.compact' | transloco }}</span>
            </label>
            <button
              type="button"
              class="btn btn-sm btn-primary"
              data-testid="import-selected"
              [disabled]="busy() || loading() || !selected().size"
              (click)="importSelected()"
            >
              {{
                (busy() ? 'settings.sessionImports.importing' : 'settings.sessionImports.importSelected') | transloco
              }}
            </button>
          </div>
        </div>
      }
    </section>
  `,
})
export class SessionImports {
  readonly cwd = input.required<string>();
  protected readonly sessions = signal<ExternalSession[]>([]);
  protected readonly selected = signal(new Set<string>());
  protected readonly loading = signal(false);
  protected readonly busy = signal(false);
  protected readonly compact = signal(false);
  protected readonly error = signal('');
  protected readonly unavailable = signal('');
  protected readonly skipped = signal(0);
  protected readonly failures = signal<Record<string, { message: string; threadId?: string }>>({});
  private readonly threads = inject(ThreadsStore);
  private readonly api = inject(ApiClient);
  private readonly ui = inject(UiStore);
  private readonly translate = inject(Language).t;
  private readonly destroy = inject(DestroyRef);
  private epoch = 0;

  constructor() {
    effect(() => {
      this.cwd();
      untracked(() => void this.check());
    });
  }

  protected sourceName(source: ExternalSession['source']): string {
    return this.translate(source === 'codex' ? 'settings.sessionImports.codex' : 'settings.sessionImports.claude');
  }

  protected statusName(status: ExternalSession['status']): string {
    return this.translate(`settings.sessionImports.${status}`);
  }

  protected async check(): Promise<void> {
    const cwd = this.cwd();
    const epoch = ++this.epoch;
    this.loading.set(true);
    this.busy.set(false);
    this.error.set('');
    this.sessions.set([]);
    this.selected.set(new Set());
    this.failures.set({});
    this.unavailable.set('');
    this.skipped.set(0);
    try {
      const result = await this.threads.findExternalSessions(cwd);
      if (!this.current(cwd, epoch)) return;
      this.sessions.set(result.sessions);
      this.selected.set(
        new Set(result.sessions.filter((session) => session.status === 'new').map((session) => session.key)),
      );
      this.unavailable.set(result.unavailable.map((source) => this.sourceName(source)).join(', '));
      this.skipped.set(result.skipped);
    } catch (error) {
      if (this.current(cwd, epoch)) this.error.set(errorMessage(error));
    } finally {
      if (this.current(cwd, epoch)) this.loading.set(false);
    }
  }

  protected toggle(key: string, checked: boolean): void {
    this.selected.update((value) => {
      const next = new Set(value);
      if (checked) next.add(key);
      else next.delete(key);
      return next;
    });
  }

  protected async importSelected(): Promise<void> {
    if (this.busy() || this.loading()) return;
    const cwd = this.cwd();
    const epoch = this.epoch;
    const selected = this.sessions().filter(
      (session) => this.selected().has(session.key) && session.status !== 'imported',
    );
    const compact = this.compact();
    this.busy.set(true);
    for (const session of selected) {
      if (!this.current(cwd, epoch)) break;
      this.clearFailure(session.key);
      let threadId: string;
      try {
        const request = { key: session.key, fingerprint: session.fingerprint };
        threadId = (await this.threads.importExternalSession(cwd, request)).id;
      } catch (error) {
        if (this.current(cwd, epoch)) this.fail(session.key, errorMessage(error));
        continue;
      }
      if (this.current(cwd, epoch)) {
        this.sessions.update((values) =>
          values.map((value) =>
            value.key === session.key ? { ...value, status: 'imported', importedThreadId: threadId } : value,
          ),
        );
        this.toggle(session.key, false);
      }
      if (compact) await this.compactImported(cwd, epoch, session.key, threadId);
    }
    if (this.current(cwd, epoch)) this.busy.set(false);
  }

  protected async retryCompact(key: string, threadId: string): Promise<void> {
    if (this.busy()) return;
    const cwd = this.cwd();
    const epoch = this.epoch;
    this.busy.set(true);
    await this.compactImported(cwd, epoch, key, threadId);
    if (this.current(cwd, epoch)) this.busy.set(false);
  }

  /** The import is already saved: a failed compaction only leaves a retry on its row. */
  private async compactImported(cwd: string, epoch: number, key: string, threadId: string): Promise<void> {
    try {
      await unwrap(sessionCompact({ client: this.api.client, path: { id: threadId }, body: {} }));
      if (this.current(cwd, epoch)) this.clearFailure(key);
    } catch (error) {
      const message = this.translate('settings.sessionImports.compactFailed', { message: errorMessage(error) });
      if (this.current(cwd, epoch)) this.fail(key, message, threadId);
    }
  }

  protected open(id: string): void {
    this.threads.select(id);
    this.ui.closeSettings();
  }

  private current(cwd: string, epoch: number): boolean {
    return !this.destroy.destroyed && this.cwd() === cwd && epoch === this.epoch;
  }

  private fail(key: string, message: string, threadId?: string): void {
    this.failures.update((values) => ({ ...values, [key]: { message, ...(threadId ? { threadId } : {}) } }));
  }

  private clearFailure(key: string): void {
    this.failures.update((values) => {
      const next = { ...values };
      delete next[key];
      return next;
    });
  }
}
