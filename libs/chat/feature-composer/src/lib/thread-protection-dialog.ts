import { Component, computed, DestroyRef, ElementRef, inject, Injector, input, signal, viewChild } from '@angular/core';
import { DialogStore } from '@pi-kit/data-access';
import { keepFocusInside } from '@pi-kit/design-system';
import { TranslocoPipe } from '@pi-kit/i18n';
type ThreadProtectionConsent = 'recoveryConsent' | 'windowsConsent';

export type ThreadProtectionDialogInputs = {
  title: 'confirmTitle' | 'setupTitle';
  confirmLabel: 'confirm' | 'setupConfirm';
  warnings: readonly ('recoveryWarning' | 'enableWarning' | 'bypassWarning' | 'setupWarning')[];
  consents: readonly ThreadProtectionConsent[];
  apply: () => void;
};

@Component({
  selector: 'pk-thread-protection-dialog',
  imports: [TranslocoPipe],
  template: `
    <div class="pk-wf">
      <button
        type="button"
        class="pk-backdrop"
        tabindex="-1"
        [attr.aria-label]="'chat.threadProtection.cancel' | transloco"
        (click)="dialogs.close()"
      ></button>
      <div
        #win
        class="win w-full max-w-lg"
        role="dialog"
        aria-modal="true"
        tabindex="-1"
        aria-labelledby="protection-title"
        aria-describedby="protection-warning"
        (keydown)="onKeydown($event)"
      >
        <div class="head">
          <h2 id="protection-title">{{ 'chat.threadProtection.' + title() | transloco }}</h2>
        </div>
        <div class="body flex flex-col gap-4">
          <div id="protection-warning" class="flex flex-col gap-2">
            @for (warning of warnings(); track warning) {
              <p [class.text-warning]="warning === 'recoveryWarning'">
                {{ 'chat.threadProtection.' + warning | transloco }}
              </p>
            }
          </div>
          @for (consent of consents(); track consent) {
            <label class="flex items-start gap-2">
              <input
                type="checkbox"
                [attr.data-consent]="consent"
                [checked]="accepted().includes(consent)"
                (change)="accept(consent, $any($event.target).checked)"
              />
              <span>{{ 'chat.threadProtection.' + consent | transloco }}</span>
            </label>
          }
        </div>
        <div class="foot flex justify-end gap-2">
          <button type="button" class="btn btn-sm" data-testid="protection-cancel" (click)="dialogs.close()">
            {{ 'chat.threadProtection.cancel' | transloco }}
          </button>
          <button
            type="button"
            class="btn btn-sm"
            data-testid="protection-confirm"
            [disabled]="!ready()"
            (click)="confirm()"
          >
            {{ 'chat.threadProtection.' + confirmLabel() | transloco }}
          </button>
        </div>
      </div>
    </div>
  `,
})
export class ThreadProtectionDialog {
  readonly title = input.required<ThreadProtectionDialogInputs['title']>();
  readonly confirmLabel = input.required<ThreadProtectionDialogInputs['confirmLabel']>();
  readonly warnings = input.required<ThreadProtectionDialogInputs['warnings']>();
  readonly consents = input.required<ThreadProtectionDialogInputs['consents']>();
  readonly apply = input.required<ThreadProtectionDialogInputs['apply']>();
  protected readonly dialogs = inject(DialogStore);
  protected readonly accepted = signal<readonly ThreadProtectionConsent[]>([]);
  protected readonly ready = computed(() => this.consents().every((consent) => this.accepted().includes(consent)));
  private readonly win = viewChild<ElementRef<HTMLElement>>('win');

  constructor() {
    keepFocusInside(inject(Injector), () => this.win()?.nativeElement);
    const previous = document.activeElement;
    inject(DestroyRef).onDestroy(() => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    });
  }

  protected accept(consent: ThreadProtectionConsent, checked: boolean): void {
    this.accepted.update((accepted) => [...accepted.filter((c) => c !== consent), ...(checked ? [consent] : [])]);
  }

  protected confirm(): void {
    this.apply()();
    this.dialogs.close();
  }

  protected onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.dialogs.close();
      return;
    }
    if (event.key !== 'Tab') return;
    const win = this.win()?.nativeElement;
    const focusable = Array.from(
      win?.querySelectorAll<HTMLElement>('input:not(:disabled), button:not(:disabled)') ?? [],
    );
    const edge = event.shiftKey ? focusable[0] : focusable[focusable.length - 1];
    if (document.activeElement !== edge && !(event.shiftKey && document.activeElement === win)) return;
    event.preventDefault();
    (event.shiftKey ? focusable[focusable.length - 1] : focusable[0])?.focus();
  }
}
