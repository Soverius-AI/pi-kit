import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { TranslocoPipe } from '@pi-kit/i18n';
import { ApiClient, localRuntimeRuntimeUpdates, unwrap } from '@pi-kit/api';
import type { LlamaRuntimeUpdates } from '@pi-kit/protocol';

@Component({
  selector: 'pk-llama-runtime-updates',
  imports: [TranslocoPipe, DatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="rounded-xl border border-base-300 p-4 flex flex-col gap-3" aria-labelledby="runtime-updates-title">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h4 id="runtime-updates-title" class="font-medium m-0">{{ 'settings.runtimeUpdates.title' | transloco }}</h4>
        <button type="button" class="btn btn-sm" [disabled]="checking()" (click)="check()">
          {{ (checking() ? 'settings.runtimeUpdates.checking' : 'settings.runtimeUpdates.check') | transloco }}
        </button>
      </div>
      <p class="t-sm muted m-0">{{ 'settings.runtimeUpdates.description' | transloco }}</p>
      @if (error()) {
        <p role="alert" class="t-sm m-0">{{ 'settings.runtimeUpdates.failed' | transloco }}</p>
      }
      @if (result(); as data) {
        <div class="t-xs muted">
          {{ 'settings.runtimeUpdates.checked' | transloco }} {{ data.checkedAt | date: 'short' }}
          @if (data.latest) {
            · {{ 'settings.runtimeUpdates.latest' | transloco }} {{ data.latest }}
          }
          ·
          <a class="link" [href]="data.releasesUrl" target="_blank" rel="noopener noreferrer">{{
            'settings.runtimeUpdates.releases' | transloco
          }}</a>
        </div>
        @if (data.error) {
          <p role="status" class="t-sm m-0">{{ 'settings.runtimeUpdates.failed' | transloco }}</p>
        }
        @for (runtime of data.runtimes; track runtime.path) {
          <div class="border border-base-300 rounded-lg p-3 flex flex-col gap-2">
            <div class="flex flex-wrap items-center gap-2">
              <b class="t-sm">{{ runtime.source }}</b>
              <span class="chip" [class.ok]="runtime.status === 'current'">{{
                'settings.runtimeUpdates.' + runtime.status | transloco
              }}</span>
            </div>
            <code class="t-xs break-all">{{ runtime.path }}</code>
            <span class="t-xs muted">{{
              runtime.version || ('settings.runtimeUpdates.unknownVersion' | transloco)
            }}</span>
            <p class="t-sm m-0">
              {{ 'settings.runtimeUpdates.models' | transloco }}
              {{ runtime.models.length ? runtime.models.join(', ') : ('settings.runtimeUpdates.unused' | transloco) }}
            </p>
            <p class="t-xs muted m-0">
              {{
                (runtime.source === 'Homebrew'
                  ? 'settings.runtimeUpdates.brewGuidance'
                  : 'settings.runtimeUpdates.sourceGuidance'
                ) | transloco
              }}
            </p>
          </div>
        } @empty {
          <p class="t-sm m-0">{{ 'settings.runtimeUpdates.empty' | transloco }}</p>
        }
      }
    </section>
  `,
})
export class LlamaRuntimeUpdatesPanel {
  private readonly api = inject(ApiClient);
  private readonly abort = new AbortController();
  protected readonly result = signal<LlamaRuntimeUpdates | undefined>(undefined);
  protected readonly checking = signal(false);
  protected readonly error = signal(false);
  constructor() {
    inject(DestroyRef).onDestroy(() => this.abort.abort());
  }
  protected async check(): Promise<void> {
    if (this.checking()) return;
    this.checking.set(true);
    this.error.set(false);
    try {
      this.result.set(await unwrap(localRuntimeRuntimeUpdates({ client: this.api.client, signal: this.abort.signal })));
    } catch {
      if (!this.abort.signal.aborted) this.error.set(true);
    } finally {
      this.checking.set(false);
    }
  }
}
