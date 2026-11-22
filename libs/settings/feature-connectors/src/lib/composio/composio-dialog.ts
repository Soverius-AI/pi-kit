import { Component, ElementRef, inject, viewChild } from '@angular/core';
import { PkIcon, PkTip } from '@pi-kit/design-system';
import { TranslocoPipe } from '@pi-kit/i18n';
import { ComposioStore } from '@pi-kit/settings/api';
import { ComposioConnect } from './composio-connect';
import { ComposioKeyPanel } from './composio-key-panel';

/** Composio: apps through the browser sign-in first, the API-key way folded below. */
@Component({
  selector: 'pk-composio-dialog',
  imports: [ComposioConnect, ComposioKeyPanel, PkIcon, PkTip, TranslocoPipe],
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
          <p class="hint m-0">{{ 'settings.composio.connectAbout' | transloco }}</p>
          <pk-composio-connect />
          <details [open]="!!store.status()?.configured" data-testid="composio-key-section">
            <summary class="lbl">{{ 'settings.composio.keyTitle' | transloco }}</summary>
            <pk-composio-key-panel />
          </details>
          @if (store.error(); as error) {
            <div class="alert alert-error t-sm" role="alert" data-testid="composio-error">{{ error }}</div>
          }
        </div>
        <div class="foot">
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
  private readonly win = viewChild<ElementRef<HTMLElement>>('win');

  constructor() {
    queueMicrotask(() => this.win()?.nativeElement.focus());
  }
}
