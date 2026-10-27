import { Component, DestroyRef, ElementRef, Injector, inject, input, signal, viewChild } from '@angular/core';
import { keepFocusInside, PkIcon, PkTip } from '@pi-kit/design-system';
import { TranslocoPipe } from '@pi-kit/i18n';
import type { ResourceItem } from '@pi-kit/protocol';
import { DialogStore } from '@pi-kit/data-access';
import { errorMessage } from '@pi-kit/api';
import { PackagesStore } from '@pi-kit/settings/api';

@Component({
  selector: 'pk-delete-skill-dialog',
  imports: [PkIcon, PkTip, TranslocoPipe],
  template: `
    <div class="pk-wf" data-testid="delete-skill-dialog">
      <button
        type="button"
        class="pk-backdrop"
        tabindex="-1"
        [attr.aria-label]="'settings.skillManagement.cancel' | transloco"
        [disabled]="busy()"
        (click)="dismiss()"
      ></button>
      <div
        #win
        class="win w-full max-w-lg"
        role="dialog"
        aria-modal="true"
        tabindex="-1"
        aria-labelledby="delete-skill-title"
        aria-describedby="delete-skill-warning"
        [attr.aria-busy]="busy()"
        data-testid="delete-skill-confirm"
        (keydown)="onKeydown($event)"
      >
        <div class="head">
          <pk-icon name="trash" class="text-error" />
          <h2 id="delete-skill-title">{{ 'settings.skillManagement.deleteTitle' | transloco }}</h2>
          <button
            type="button"
            class="pk-close ml-auto"
            [disabled]="busy()"
            [attr.aria-label]="'settings.editServerDialog.close' | transloco"
            [pkTip]="'settings.editServerDialog.closeEsc' | transloco"
            (click)="dismiss()"
          >
            <pk-icon name="close" />
          </button>
        </div>
        <div class="body flex flex-col gap-4">
          <div class="rounded-lg border border-base-300 bg-base-200 p-3 flex flex-col gap-2 min-w-0">
            <div class="flex items-center gap-2 min-w-0">
              <pk-icon name="skill" class="muted shrink-0" />
              <strong class="font-medium break-all">{{ skill().name }}</strong>
              <span class="chip off shrink-0">{{
                (skill().scope === 'project'
                  ? 'settings.extensionsSection.thisProject'
                  : 'settings.extensionsSection.forMe'
                ) | transloco
              }}</span>
            </div>
            <p class="mono t-sm muted break-all m-0">{{ skill().path }}</p>
          </div>
          <p id="delete-skill-warning" class="t-sm m-0">{{ 'settings.skillManagement.deleteWarning' | transloco }}</p>
          @if (error(); as text) {
            <p class="text-error t-sm break-words m-0" role="alert">{{ text }}</p>
          }
        </div>
        <div class="foot flex justify-end gap-2">
          <button
            type="button"
            class="btn btn-sm"
            data-testid="delete-skill-cancel"
            [disabled]="busy()"
            (click)="dismiss()"
          >
            {{ 'settings.skillManagement.cancel' | transloco }}
          </button>
          <button
            type="button"
            class="btn btn-sm btn-error"
            data-testid="delete-skill-yes"
            [disabled]="busy()"
            (click)="remove()"
          >
            @if (busy()) {
              <span class="loading loading-spinner loading-xs" aria-hidden="true"></span>
            }
            {{ 'settings.skillManagement.delete' | transloco }}
          </button>
        </div>
      </div>
    </div>
  `,
})
export class DeleteSkillDialog {
  readonly skill = input.required<ResourceItem>();
  readonly mtime = input.required<number>();
  readonly busy = signal(false);
  readonly error = signal('');
  private readonly dialogs = inject(DialogStore);
  private readonly pkgs = inject(PackagesStore);
  private readonly win = viewChild<ElementRef<HTMLElement>>('win');
  private readonly injector = inject(Injector);

  constructor() {
    keepFocusInside(this.injector, () => this.win()?.nativeElement);
    const previous = document.activeElement;
    inject(DestroyRef).onDestroy(() => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    });
  }

  protected dismiss(): void {
    if (!this.busy()) this.dialogs.close();
  }

  async remove(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    keepFocusInside(this.injector, () => this.win()?.nativeElement);
    try {
      const result = await this.pkgs.removeSkill(this.skill().path, this.mtime());
      if (result.ok) this.dialogs.close();
      else this.error.set(result.error);
    } catch (error) {
      this.error.set(errorMessage(error));
    } finally {
      this.busy.set(false);
    }
  }

  protected onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.dismiss();
    } else if (event.key === 'Tab') {
      const win = this.win()?.nativeElement;
      const buttons = Array.from(win?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
      const first = buttons[0];
      const last = buttons[buttons.length - 1];
      if (!first || (event.shiftKey && (document.activeElement === first || document.activeElement === win))) {
        event.preventDefault();
        (last ?? win)?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  }
}
