import { ChangeDetectionStrategy, Component, DestroyRef, inject, output, signal } from '@angular/core';
import { Language, TranslocoPipe } from '@pi-kit/i18n';
import { PkScrollArea } from '@pi-kit/design-system';
import { LiteLlmStore } from '@pi-kit/settings/api';
import type { LiteLlmConnection } from '@pi-kit/protocol';

/**
 * The LiteLLM step of the “Add a provider” wizard: the proxy's URL, which key to use (the saved one, a new one or
 * none), Discover/Refresh, which lists the models the proxy serves, and Save, which stores the connection through
 * `LiteLlmStore` and emits `saved`. The key typed here is kept only while the panel is open.
 */
@Component({
  selector: 'pk-litellm-connection',
  imports: [TranslocoPipe, PkScrollArea],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <form class="flex flex-col gap-3" data-testid="litellm-panel" (submit)="$event.preventDefault(); discover()">
      <label class="flex flex-col gap-1" for="litellm-url">
        <span class="lbl">{{ 'settings.litellm.url' | transloco }}</span>
        <input
          id="litellm-url"
          class="input input-sm w-full mono"
          type="url"
          required
          autocomplete="off"
          spellcheck="false"
          [placeholder]="'settings.litellm.urlPlaceholder' | transloco"
          [disabled]="busy()"
          [value]="url()"
          (input)="url.set($any($event.target).value); changed()"
        />
      </label>
      <div class="flex flex-col gap-1">
        <label class="lbl" for="litellm-auth">{{ 'settings.litellm.auth' | transloco }}</label>
        <select
          id="litellm-auth"
          class="select select-sm w-full"
          [disabled]="busy()"
          [value]="auth()"
          (change)="auth.set($any($event.target).value); changed()"
        >
          @if (hasSavedKey()) {
            <option value="saved" [selected]="auth() === 'saved'">{{ 'settings.litellm.savedKey' | transloco }}</option>
          }
          <option value="key" [selected]="auth() === 'key'">{{ 'settings.litellm.newKey' | transloco }}</option>
          <option value="none" [selected]="auth() === 'none'">{{ 'settings.litellm.noKey' | transloco }}</option>
        </select>
      </div>
      @if (auth() === 'key') {
        <label class="flex flex-col gap-1" for="litellm-key">
          <span class="lbl">{{ 'settings.litellm.key' | transloco }}</span>
          <input
            id="litellm-key"
            class="input input-sm w-full"
            type="password"
            autocomplete="new-password"
            spellcheck="false"
            [disabled]="busy()"
            [value]="key()"
            (input)="key.set($any($event.target).value); changed()"
          />
        </label>
      }
      <p class="hint m-0">{{ 'settings.litellm.keyHint' | transloco }}</p>
      <div class="flex flex-wrap gap-2">
        <button type="submit" class="btn btn-sm" data-testid="litellm-discover" [disabled]="busy() || !valid()">
          {{ (configured() ? 'settings.litellm.refresh' : 'settings.litellm.discover') | transloco }}
        </button>
        <button
          type="button"
          class="btn btn-sm btn-primary ml-auto"
          data-testid="litellm-save"
          [disabled]="busy() || !valid()"
          (click)="save()"
        >
          {{ 'settings.litellm.save' | transloco }}
        </button>
      </div>
      @if (busy()) {
        <p class="hint m-0" role="status">{{ 'settings.litellm.busy' | transloco }}</p>
      }
      @if (error()) {
        <p class="text-error t-sm m-0" role="alert">{{ error() }}</p>
      }
      @if (connection(); as c) {
        <div class="lbl">{{ 'settings.litellm.models' | transloco: { count: c.models.length } }}</div>
        <pk-scroll-area class="block" maxHeight="16rem" [label]="'settings.litellm.title' | transloco">
          <div class="flex flex-col gap-2" data-testid="litellm-models">
            @for (m of c.models; track m.id) {
              <div class="box flex flex-col gap-1">
                <strong class="t-sm break-words">{{ m.name }}</strong>
                @if (m.name !== m.id) {
                  <span class="mono hint break-words">{{ m.id }}</span>
                }
                <div class="hint flex flex-wrap gap-2">
                  @if (m.contextWindow) {
                    <span>{{ 'settings.litellm.context' | transloco: { count: m.contextWindow } }}</span>
                  }
                  @if (m.vision) {
                    <span class="chip">{{ 'settings.litellm.vision' | transloco }}</span>
                  }
                  @if (m.reasoning) {
                    <span class="chip">{{ 'settings.litellm.reasoning' | transloco }}</span>
                  }
                </div>
              </div>
            } @empty {
              <p class="hint m-0">{{ 'settings.litellm.empty' | transloco }}</p>
            }
          </div>
        </pk-scroll-area>
      }
    </form>
  `,
})
export class LiteLlmConnectionPanel {
  private readonly store = inject(LiteLlmStore);
  private readonly i18n = inject(Language);
  private readonly abort = new AbortController();
  readonly saved = output<void>();
  protected readonly url = signal('http://localhost:4000/v1');
  protected readonly key = signal('');
  protected readonly auth = signal<'saved' | 'key' | 'none'>('key');
  protected readonly busy = signal(true);
  protected readonly error = signal<string | undefined>(undefined);
  protected readonly hasSavedKey = signal(false);
  protected readonly configured = signal(false);
  protected readonly connection = signal<LiteLlmConnection | undefined>(undefined);

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.abort.abort();
      this.key.set('');
    });
    void this.store
      .load(this.abort.signal)
      .then((c) => {
        this.hasSavedKey.set(c.hasApiKey);
        this.configured.set(c.configured);
        this.url.set(c.baseUrl);
        this.connection.set(c);
        this.auth.set(c.hasApiKey ? 'saved' : c.configured ? 'none' : 'key');
      })
      .catch(() => this.error.set(this.i18n.t('settings.litellm.loadError')))
      .finally(() => this.busy.set(false));
  }

  protected changed(): void {
    this.error.set(undefined);
    this.connection.set(undefined);
  }
  protected valid(): boolean {
    return !!this.url().trim() && (this.auth() !== 'key' || !!this.key().trim());
  }
  private input() {
    return {
      baseUrl: this.url().trim(),
      ...(this.auth() === 'saved' ? {} : { apiKey: this.auth() === 'key' ? this.key().trim() : '' }),
    };
  }
  protected async discover(): Promise<void> {
    await this.run(false);
  }
  protected async save(): Promise<void> {
    await this.run(true);
  }
  private async run(save: boolean): Promise<void> {
    if (this.busy() || !this.valid()) return;
    this.busy.set(true);
    this.error.set(undefined);
    try {
      const c = await (save
        ? this.store.save(this.input(), this.abort.signal)
        : this.store.discover(this.input(), this.abort.signal));
      this.connection.set(c);
      if (save) {
        this.key.set('');
        this.saved.emit();
      }
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.busy.set(false);
    }
  }
}
