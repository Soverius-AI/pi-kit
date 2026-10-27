import { Language } from '@pi-kit/i18n';
import { TranslocoPipe } from '@pi-kit/i18n';
import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { UpdateStore } from '@pi-kit/update/data';

/**
 * The update's progress toast and the "Restart to use …" toast. While the job runs it lists the rows that are
 * running and the last line of output, with Cancel; when pi or pi-kit waits for a restart it says so with the button. It sits inside
 * the window's toast stack (`ToastHost`).
 */
@Component({
  imports: [TranslocoPipe],
  selector: 'pk-update-toast',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (store.running()) {
      <div role="status" class="alert alert-soft alert-info text-sm max-w-sm" data-testid="update-progress">
        <div class="pk-update-toast">
          <div class="flex items-center gap-2">
            <span class="loading loading-spinner loading-xs"></span>
            <span class="font-medium">{{ 'update.updateToast.updating' | transloco: { value1: running() } }}</span>
            <button
              type="button"
              class="btn btn-ghost btn-xs ml-auto"
              [disabled]="store.loading()"
              (click)="store.cancel()"
            >
              {{ 'update.updateToast.cancel' | transloco }}
            </button>
          </div>
          <div class="line" [title]="last()">{{ last() || ('update.updateToast.starting' | transloco) }}</div>
        </div>
      </div>
    } @else if (store.restartNotice(); as notice) {
      <div role="status" class="alert alert-soft alert-success text-sm max-w-sm" data-testid="update-restart">
        <div class="pk-update-toast">
          <span>{{
            notice.kind === 'pi'
              ? ('update.updateToast.pi' | transloco) +
                notice.version +
                ('update.updateToast.isInstalledRestartToUseItYour' | transloco)
              : ('update.updateToast.piKit' | transloco) +
                notice.version +
                ('update.updateToast.isReadyRestartToInstallIt' | transloco)
          }}</span>
          <div class="flex gap-2">
            <button
              type="button"
              class="btn btn-primary btn-xs"
              [disabled]="store.loading()"
              (click)="notice.kind === 'pi' ? store.restartBackend() : store.installApp()"
            >
              {{
                notice.kind === 'pi'
                  ? ('update.updateToast.restartToUse' | transloco) + notice.version
                  : ('update.updateToast.restartToUpdatePiKit' | transloco)
              }}
            </button>
            <button type="button" class="btn btn-ghost btn-xs" (click)="store.dismissRestart()">
              {{ 'update.updateToast.later' | transloco }}
            </button>
          </div>
        </div>
      </div>
    }
  `,
})
export class UpdateToast {
  protected readonly i18n = inject(Language);
  protected readonly store = inject(UpdateStore);

  protected readonly running = computed(() => {
    const names: Record<string, string> = {
      pi: 'pi',
      packages: 'packages',
      models: this.i18n.t('update.updateToast.modelCatalogs'),
      app: 'pi-kit',
    };
    const rows = (this.store.status()?.rows ?? [])
      .filter((row) => row.state === 'running')
      .map((row) => names[row.target]);
    return rows.length > 0 ? rows.join(', ') : 'everything';
  });
  protected readonly last = computed(() => this.store.lines().at(-1)?.text ?? '');
}
