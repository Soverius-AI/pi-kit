import { Language } from '@pi-kit/i18n';
import { TranslocoPipe } from '@pi-kit/i18n';
import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { UpdateStore } from '@pi-kit/update/data';

/**
 * The update's toasts in the window's toast stack (`ToastHost`): the running job with its last output line and Cancel, "Restart to
 * use …" when pi or pi-kit waits for a restart, and the offer of a newer pi-kit with GitHub's release notes.
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
    } @else if (store.appOffer(); as offer) {
      <div role="status" class="alert alert-soft alert-info text-sm max-w-sm" data-testid="update-offer">
        <div class="pk-update-toast">
          <span class="font-medium">{{
            'update.updateToast.piKitIsAvailable' | transloco: { value1: offer.latest }
          }}</span>
          @if (offer.notes?.length) {
            <!-- Links inside are anchors, so the keyboard reaches them; the handler only reroutes their click. -->
            <!-- eslint-disable-next-line @angular-eslint/template/click-events-have-key-events, @angular-eslint/template/interactive-supports-focus -->
            <div class="pk-release-notes" data-testid="update-notes" (click)="openLink($event)">
              @for (note of offer.notes; track note.version) {
                @if (offer.notes!.length > 1) {
                  <div class="version">{{ note.version }}</div>
                }
                <div [innerHTML]="note.html"></div>
              }
            </div>
          }
          <label class="flex items-center gap-2 cursor-pointer">
            <input #always type="checkbox" class="checkbox checkbox-xs" />
            {{ 'update.updateToast.downloadUpdatesAutomaticallyFromNowOn' | transloco }}
          </label>
          <div class="flex gap-2">
            <button
              type="button"
              class="btn btn-primary btn-xs"
              [disabled]="store.loading()"
              (click)="download(always.checked)"
            >
              {{ 'update.updateToast.download' | transloco }}
            </button>
            <button type="button" class="btn btn-ghost btn-xs" (click)="store.dismissOffer()">
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

  /** With the box ticked, turning automatic downloads on also starts this download. */
  protected download(always: boolean): void {
    void (always ? this.store.setAutoDownload(true) : this.store.update(['app']));
  }

  /** A link in the notes opens in the browser (Electron main sends `window.open` there), never in the app window. */
  protected openLink(event: MouseEvent): void {
    const link = (event.target as HTMLElement).closest('a');
    if (!link?.href.startsWith('https://')) return;
    event.preventDefault();
    window.open(link.href, '_blank', 'noopener,noreferrer');
  }
}
