import { Language } from '@pi-kit/i18n';
import { TranslocoPipe } from '@pi-kit/i18n';
import { ChangeDetectionStrategy, Component, effect, inject, signal, untracked } from '@angular/core';
import { UpdateStore } from '@pi-kit/update/api';

/**
 * Settings › Advanced: "Use previous release". pi-kit runs the newest compatible pi; this pins it to an older managed
 * release or to the copy bundled with pi-kit, for the case where an update misbehaves. It changes which pi pi-kit loads at its next start
 * and nothing about the `pi` command or pi's own symlink.
 */
@Component({
  imports: [TranslocoPipe],
  selector: 'pk-advanced',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="flex flex-col gap-5" data-testid="advanced">
      <section class="pk-group" [attr.aria-label]="'settings.advancedBlock.piRelease' | transloco">
        <header>
          <div>
            <h4>{{ 'settings.advancedBlock.piRelease' | transloco }}</h4>
            <p>{{ 'settings.advancedBlock.whichPiPiKitRunsItsThreads' | transloco }}</p>
          </div>
        </header>
        <div class="row">
          <div>
            <div class="lbl">
              {{ 'settings.advancedBlock.running' | transloco }}
              <span class="mono">{{ store.resolution()?.version }}</span>
              <span class="chip">{{ source() }}</span>
            </div>
            <div class="hint">
              @if (store.status()?.pinned; as pinned) {
                {{
                  'settings.advancedBlock.pinnedToPiKitDoesNotFollow'
                    | transloco
                      : {
                          value1:
                            pinned === 'bundled'
                              ? ('settings.advancedBlock.theBundledCopy' | transloco)
                              : ('settings.advancedBlock.pi' | transloco) + pinned,
                        }
                }}
              } @else {
                {{ 'settings.advancedBlock.piKitRunsTheNewestCompatibleRelease' | transloco }}
              }
            </div>
          </div>
          <div class="ctl ctl-w">
            @if (store.status()?.pinned) {
              <button type="button" class="btn btn-sm" [disabled]="store.loading()" (click)="store.pin(null)">
                {{ 'settings.advancedBlock.followTheNewest' | transloco }}
              </button>
            }
          </div>
        </div>
        <div class="row">
          <div>
            <div class="lbl">{{ 'settings.advancedBlock.usePreviousRelease' | transloco }}</div>
            <div class="hint">
              {{ 'settings.advancedBlock.onlyChangesWhichPiPiKitLoads' | transloco }} <code>pi</code>
              {{ 'settings.advancedBlock.commandAndPiSInstalledReleasesStay' | transloco }}
            </div>
          </div>
          <div class="ctl ctl-w">
            <select
              class="select select-sm"
              [attr.aria-label]="'settings.advancedBlock.releaseToUse' | transloco"
              [disabled]="store.releases().length === 0"
              (change)="choice.set($any($event.target).value)"
            >
              @if (store.releases().length === 0) {
                <option value="">{{ 'settings.advancedBlock.noOtherRelease' | transloco }}</option>
              }
              @for (release of store.releases(); track release.release) {
                <option [value]="release.release" [selected]="release.release === choice()">{{ release.label }}</option>
              }
            </select>
            <button
              type="button"
              class="btn btn-sm"
              data-testid="use-previous"
              [disabled]="store.loading() || !choice()"
              (click)="store.pin(choice())"
            >
              {{ 'settings.advancedBlock.useIt' | transloco }}
            </button>
          </div>
        </div>
        @if (store.piRestart(); as restart) {
          <div class="row">
            <div class="hint">
              {{ 'settings.advancedBlock.piIsChosenForTheNextStart' | transloco: { value1: restart.version } }}
            </div>
            <div class="ctl ctl-w">
              <button
                type="button"
                class="btn btn-sm btn-primary"
                [disabled]="store.loading()"
                (click)="store.restartBackend()"
              >
                {{ 'settings.advancedBlock.restartToUse' | transloco: { value1: restart.version } }}
              </button>
            </div>
          </div>
        }
      </section>
    </div>
  `,
})
export class PkAdvanced {
  protected readonly i18n = inject(Language);
  protected readonly store = inject(UpdateStore);
  protected readonly choice = signal('');

  constructor() {
    // The choices are read when the section opens and after every pin.
    void this.store.loadReleases();
    effect(() => {
      const first = this.store.releases()[0]?.release ?? '';
      if (!this.store.releases().some((r) => r.release === untracked(() => this.choice())))
        untracked(() => this.choice.set(first));
    });
  }

  protected source(): string {
    const source = this.store.resolution()?.source;
    return source === 'managed'
      ? this.i18n.t('settings.advancedBlock.managedInstall')
      : source === 'env'
        ? 'PI_KIT_PI_DIR'
        : this.i18n.t('settings.advancedBlock.bundled');
  }
}
