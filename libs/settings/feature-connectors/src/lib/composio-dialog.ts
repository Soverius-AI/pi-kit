import { Component, DestroyRef, ElementRef, computed, inject, signal, viewChild } from '@angular/core';
import { TranslocoPipe } from '@pi-kit/i18n';
import { PkChoice, PkIcon, PkTip } from '@pi-kit/design-system';
import type { ComposioToolkit } from '@pi-kit/protocol';
import { ComposioStore } from '@pi-kit/settings/api';

@Component({
  selector: 'pk-composio-dialog',
  imports: [PkChoice, PkIcon, PkTip, TranslocoPipe],
  template: `
    <div class="pk-wf" data-testid="composio-dialog">
      <button
        type="button"
        class="pk-backdrop"
        tabindex="-1"
        [attr.aria-label]="'settings.composio.close' | transloco"
        (click)="store.close()"
      ></button>
      <div
        #win
        class="win wide"
        role="dialog"
        aria-modal="true"
        [attr.aria-label]="'settings.composio.title' | transloco"
        tabindex="-1"
        (keydown.escape)="$event.preventDefault(); $event.stopPropagation(); store.close()"
      >
        <div class="head">
          <h2>{{ 'settings.composio.title' | transloco }}</h2>
          <span class="chip">{{ 'settings.composio.optional' | transloco }}</span>
          <button
            type="button"
            class="pk-close ml-auto"
            [pkTip]="'settings.composio.close' | transloco"
            [attr.aria-label]="'settings.composio.close' | transloco"
            (click)="store.close()"
          >
            <pk-icon name="close" />
          </button>
        </div>
        <div class="body">
          <div class="hint" data-testid="composio-about">{{ 'settings.composio.about' | transloco }}</div>
          @if (store.status(); as status) {
            @if (!status.configured) {
              <form class="pk-form" autocomplete="off" (submit)="keep($event)" data-testid="composio-key-form">
                <label for="composio-key">{{ 'settings.composio.apiKey' | transloco }}</label>
                <input
                  #key
                  id="composio-key"
                  name="apiKey"
                  type="password"
                  class="input input-sm mono"
                  autocomplete="off"
                  autocapitalize="off"
                  spellcheck="false"
                  data-testid="composio-key"
                />
                <div class="hint">{{ 'settings.composio.apiKeyHint' | transloco }}</div>
                <div>
                  <button type="submit" class="btn btn-sm btn-primary" [disabled]="store.loading()">
                    {{ 'settings.composio.keepKey' | transloco }}
                  </button>
                </div>
              </form>
            } @else {
              @if (store.connections().length) {
                <div class="lbl">{{ 'settings.composio.yourApps' | transloco }}</div>
                <ul class="pk-list m-0 p-0" data-testid="composio-connections">
                  @for (c of store.connections(); track c.server) {
                    <li class="flex items-center gap-2 py-1" [attr.data-testid]="'composio-connection-' + c.server">
                      <span class="mono t-sm">{{ c.server }}</span>
                      @if (c.readOnly) {
                        <span class="chip">{{ 'settings.composio.readOnly' | transloco }}</span>
                      }
                      @if (c.connected) {
                        <span class="chip ok">{{ 'settings.composio.signedIn' | transloco }}</span>
                      } @else if (c.signInUrl) {
                        <a
                          class="link link-hover t-sm ml-auto"
                          [href]="c.signInUrl"
                          target="_blank"
                          rel="noopener noreferrer"
                          [attr.data-testid]="'composio-signin-' + c.server"
                          >{{ 'settings.composio.signInTo' | transloco: { value1: c.name } }}</a
                        >
                        <button type="button" class="btn btn-xs btn-ghost" (click)="store.link(c.server)">
                          {{ 'settings.composio.checkAgain' | transloco }}
                        </button>
                      } @else {
                        <button
                          type="button"
                          class="btn btn-xs ml-auto"
                          [disabled]="store.loading()"
                          [attr.data-testid]="'composio-link-' + c.server"
                          (click)="store.link(c.server)"
                        >
                          {{ 'settings.composio.signIn' | transloco }}
                        </button>
                      }
                    </li>
                  }
                </ul>
              }
              <input
                type="search"
                class="input input-sm"
                [placeholder]="'settings.composio.searchApps' | transloco"
                [attr.aria-label]="'settings.composio.searchApps' | transloco"
                autocomplete="off"
                spellcheck="false"
                data-testid="composio-search"
                (input)="search($any($event.target).value)"
              />
              @if (chosen(); as t) {
                <div class="flex items-start gap-3" data-testid="composio-chosen">
                  <span class="pk-tile">{{ initial(t) }}</span>
                  <div class="flex-1">
                    <div class="lbl">{{ t.name }}</div>
                    <div class="hint">{{ t.description }}</div>
                    <label class="flex items-center gap-2 t-sm mt-2">
                      <input
                        type="checkbox"
                        class="checkbox checkbox-sm"
                        data-testid="composio-read-only"
                        [checked]="readOnly()"
                        (change)="readOnly.set($any($event.target).checked)"
                      />
                      {{ 'settings.composio.readOnlyChoice' | transloco }}
                    </label>
                  </div>
                </div>
                <div class="flex gap-2">
                  <button type="button" class="btn btn-sm btn-ghost" (click)="chosen.set(undefined)">
                    {{ 'settings.composio.back' | transloco }}
                  </button>
                  <button
                    type="button"
                    class="btn btn-sm btn-primary"
                    data-testid="composio-add"
                    [disabled]="store.loading()"
                    (click)="add(t)"
                  >
                    {{ 'settings.composio.add' | transloco }}
                  </button>
                </div>
              } @else {
                <div
                  class="pk-choices pk-gallery"
                  role="group"
                  [attr.aria-label]="'settings.composio.apps' | transloco"
                >
                  @for (t of store.toolkits(); track t.slug) {
                    <button pkChoice [attr.data-testid]="'composio-tile-' + t.slug" (click)="choose(t)">
                      <ng-container tile>{{ initial(t) }}</ng-container>
                      <ng-container t
                        >{{ t.name }}
                        @if (added(t)) {
                          <span class="chip ok">{{ 'settings.composio.added' | transloco }}</span>
                        }
                      </ng-container>
                      <ng-container d>{{ t.description }}</ng-container>
                    </button>
                  }
                </div>
              }
            }
          }
          @if (store.error(); as error) {
            <div class="alert alert-error t-sm" role="alert" data-testid="composio-error">{{ error }}</div>
          }
        </div>
        <div class="foot">
          @if (store.status()?.configured) {
            <button
              type="button"
              class="btn btn-sm btn-ghost"
              data-testid="composio-forget"
              [disabled]="store.loading() || store.connections().length > 0"
              [pkTip]="'settings.composio.forgetHint' | transloco"
              (click)="store.forgetKey()"
            >
              {{ 'settings.composio.forgetKey' | transloco }}
            </button>
          }
          <button type="button" class="btn btn-sm btn-ghost ml-auto" (click)="store.close()">
            {{ 'settings.composio.done' | transloco }}
          </button>
        </div>
      </div>
    </div>
  `,
})
export class ComposioDialog {
  protected readonly store = inject(ComposioStore);
  protected readonly chosen = signal<ComposioToolkit | undefined>(undefined);
  protected readonly readOnly = signal(true);
  private readonly win = viewChild<ElementRef<HTMLElement>>('win');
  private readonly key = viewChild<ElementRef<HTMLInputElement>>('key');
  private readonly servers = computed(() => new Set(this.store.connections().map((c) => c.toolkit)));
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    queueMicrotask(() => this.win()?.nativeElement.focus());
    inject(DestroyRef).onDestroy(() => clearTimeout(this.timer));
  }

  protected initial(toolkit: ComposioToolkit): string {
    return toolkit.name.slice(0, 1).toUpperCase();
  }

  protected added(toolkit: ComposioToolkit): boolean {
    return this.servers().has(toolkit.slug);
  }

  protected choose(toolkit: ComposioToolkit): void {
    this.readOnly.set(true);
    this.chosen.set(toolkit);
  }

  protected search(query: string): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.store.search(query), 250);
  }

  protected async keep(event: Event): Promise<void> {
    event.preventDefault();
    const input = this.key()?.nativeElement;
    const value = input?.value.trim() ?? '';
    if (input) input.value = '';
    if (value) await this.store.setKey(value);
  }

  protected async add(toolkit: ComposioToolkit): Promise<void> {
    if (await this.store.add(toolkit, this.readOnly())) this.chosen.set(undefined);
  }
}
