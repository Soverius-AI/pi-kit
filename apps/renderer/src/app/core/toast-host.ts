import { TranslocoPipe } from '@pi-kit/i18n';
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { UpdateToast } from '@pi-kit/update/feature-update';
import { ToastStore } from '@pi-kit/data-access';

/** The window's toasts (daisyUI `toast`), bottom right above the status bar. */
@Component({
  selector: 'pk-toasts',
  imports: [UpdateToast, TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="toast toast-end mb-7 z-50" aria-live="polite">
      <pk-update-toast />
      @for (toast of toasts.items(); track toast.id) {
        <div
          role="status"
          class="alert alert-soft text-sm max-w-sm"
          [class.alert-info]="toast.level === 'info'"
          [class.alert-warning]="toast.level === 'warning'"
          [class.alert-error]="toast.level === 'error'"
          [class.alert-success]="toast.level === 'success'"
        >
          <span class="break-words min-w-0">{{ toast.text }}</span>
          @if (toast.action; as action) {
            <button type="button" class="btn btn-xs" data-testid="toast-action" (click)="toasts.act(toast.id)">
              {{ action.label }}
            </button>
          }
          <button type="button" class="btn btn-ghost btn-xs" (click)="toasts.dismiss(toast.id)">
            {{ 'shell.toastHost.dismiss' | transloco }}
          </button>
        </div>
      }
    </div>
  `,
})
export class ToastHost {
  protected readonly toasts = inject(ToastStore);
}
