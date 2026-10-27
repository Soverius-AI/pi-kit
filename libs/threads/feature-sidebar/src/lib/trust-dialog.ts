import { Language } from '@pi-kit/i18n';
import { TranslocoPipe } from '@pi-kit/i18n';
import { ChangeDetectionStrategy, Component, ElementRef, effect, inject, viewChild } from '@angular/core';
import type { TrustResource } from '@pi-kit/protocol';
import { TrustStore } from '@pi-kit/threads/data';

/** Badge per resource kind: extensions are plain, skills info, MCP servers warning. */
const BADGE: Record<TrustResource['kind'], { className: string }> = {
  extension: { className: 'badge-outline' },
  skill: { className: 'badge-info badge-outline' },
  mcp: { className: 'badge-warning badge-outline' },
  prompt: { className: 'badge-outline' },
  theme: { className: 'badge-outline' },
  settings: { className: 'badge-outline' },
  'prompt-file': { className: 'badge-outline' },
};

/**
 * Project trust: shown the first time a folder with project resources is opened, before
 * any of them loads. The three buttons are pi's decisions: skip (nothing loads, asked again next launch), trust once
 * (until the app quits) and trust and remember (pi's `trust.json`). Esc or a click outside is "Skip this time".
 * `/trust` shows the same dialog for a folder that already has an answer and adds "Never trust".
 */
@Component({
  imports: [TranslocoPipe],
  selector: 'pk-trust-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (gate.prompt(); as prompt) {
      <dialog
        #dialog
        class="modal modal-open"
        aria-labelledby="trust-title"
        aria-describedby="trust-text"
        tabindex="-1"
        (keydown.escape)="skip()"
      >
        <div
          class="modal-box w-full p-0"
          [class.max-w-[440px]]="prompt.mode === 'first'"
          [class.max-w-[520px]]="prompt.mode === 'review'"
        >
          <div class="p-6 flex flex-col gap-4">
            <div>
              <div id="trust-title" class="t-xl">{{ 'threads.trustDialog.trustThisFolder' | transloco }}</div>
              <div class="muted mt-1 break-all">
                <code>{{ prompt.state.cwd }}</code>
              </div>
            </div>
            <p id="trust-text" class="t-sm">
              @if (prompt.mode === 'review') {
                {{ status(prompt.state) }}
              }
              {{ 'threads.trustDialog.itContainsProjectResourcesThatRunCode' | transloco }}
            </p>
            <ul class="t-sm flex flex-col gap-2" [attr.aria-label]="'threads.trustDialog.projectResources' | transloco">
              @for (resource of prompt.state.resources; track resource.path) {
                <li class="flex items-center gap-3 min-w-0">
                  <span class="badge badge-xs shrink-0" [class]="badge(resource).className">{{
                    'threads.trustDialog.resource.' + resource.kind | transloco
                  }}</span>
                  <code class="truncate" [title]="resource.path">{{ resource.path }}</code>
                  @if (resource.servers !== undefined) {
                    <span class="muted shrink-0"
                      >{{ resource.servers }}
                      {{
                        resource.servers === 1
                          ? ('threads.trustDialog.server' | transloco)
                          : ('threads.trustDialog.servers' | transloco)
                      }}</span
                    >
                  }
                </li>
              }
            </ul>
            <div class="flex flex-wrap justify-end gap-2 pt-2">
              @if (prompt.mode === 'review') {
                <button
                  type="button"
                  class="btn btn-sm btn-ghost text-error mr-auto"
                  [disabled]="gate.busy()"
                  (click)="gate.answer('never')"
                >
                  {{ 'threads.trustDialog.neverTrust' | transloco }}
                </button>
              }
              <button type="button" class="btn btn-sm btn-ghost" [disabled]="gate.busy()" (click)="skip()">
                {{ 'threads.trustDialog.skipThisTime' | transloco }}
              </button>
              <button type="button" class="btn btn-sm" [disabled]="gate.busy()" (click)="gate.answer('once')">
                {{ 'threads.trustDialog.trustOnce' | transloco }}
              </button>
              <button
                type="button"
                class="btn btn-sm btn-primary"
                [disabled]="gate.busy()"
                (click)="gate.answer('remember')"
              >
                {{ 'threads.trustDialog.trustAndRemember' | transloco }}
              </button>
            </div>
          </div>
        </div>
        <form method="dialog" class="modal-backdrop">
          <button type="button" (click)="skip()">{{ 'threads.trustDialog.close' | transloco }}</button>
        </form>
      </dialog>
    }
  `,
})
export class TrustDialog {
  protected readonly i18n = inject(Language);
  protected readonly gate = inject(TrustStore);
  private readonly dialog = viewChild<ElementRef<HTMLDialogElement>>('dialog');

  constructor() {
    // Focus moves into the dialog so that Esc reaches it.
    effect(() => {
      if (this.gate.prompt()) queueMicrotask(() => this.dialog()?.nativeElement.focus());
    });
  }

  protected skip(): void {
    void this.gate.answer('skip');
  }

  protected badge(resource: TrustResource): { className: string } {
    return BADGE[resource.kind];
  }

  protected status(state: { status: string; source: string }): string {
    const how =
      state.source === 'saved'
        ? 'remembered'
        : state.source === 'session'
          ? this.i18n.t('threads.trustDialog.untilTheAppQuits')
          : state.source === 'default'
            ? this.i18n.t('threads.trustDialog.byPiSDefault')
            : state.source === 'extension'
              ? this.i18n.t('threads.trustDialog.byAnExtension')
              : '';
    return this.i18n.t('threads.trustDialog.now', {
      value1:
        state.status === 'trusted'
          ? this.i18n.t('threads.trustDialog.trusted')
          : state.status === 'untrusted'
            ? this.i18n.t('threads.trustDialog.notTrusted')
            : this.i18n.t('threads.trustDialog.noAnswerYet'),
      value2: how ? `, ${how}` : '',
    });
  }
}
