import type { Translate } from '@pi-kit/i18n';
import { Language } from '@pi-kit/i18n';
import { TranslocoPipe } from '@pi-kit/i18n';
import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import type { UpdateRow, UpdateTarget } from '@pi-kit/protocol';
import { UpdateStore } from '@pi-kit/update/api';

const ALL: UpdateTarget[] = ['pi', 'packages', 'models', 'app'];

/** "3 days ago" for the muted lines; `now` is read at render time, which is fine for a line nobody watches tick. */
function ago(translate: Translate, at: number | undefined): string {
  if (!at) return translate('settings.versionsBlock.neverFromPiKit');
  const minutes = Math.round((Date.now() - at) / 60_000);
  if (minutes < 1) return translate('settings.versionsBlock.justNow');
  if (minutes < 60) return translate('settings.versionsBlock.minAgo', { value1: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return translate('settings.versionsBlock.hAgo', { value1: hours });
  const days = Math.round(hours / 24);
  return translate(days === 1 ? 'settings.versionsBlock.dayAgo.one' : 'settings.versionsBlock.dayAgo.other', { days });
}

/**
 * Settings › General › Versions: pi, the installed packages, the model catalogs and
 * pi-kit, each with its own button, and one "Update all". It renders `UpdateStore` and forwards clicks; the work is the backend's job.
 */
@Component({
  imports: [TranslocoPipe],
  selector: 'pk-versions',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="pk-group" [attr.aria-label]="'settings.versionsBlock.versions' | transloco" data-testid="versions">
      <header>
        <div>
          <h4>{{ 'settings.versionsBlock.versions' | transloco }}</h4>
          <p>{{ 'settings.versionsBlock.whatIsInstalledAndWhetherAnythingHas' | transloco }}</p>
        </div>
        @if (!store.running()) {
          <button
            type="button"
            class="btn btn-ghost btn-xs ml-auto"
            [disabled]="store.loading() || !!store.status()?.checking"
            (click)="store.check()"
          >
            {{ 'settings.versionsBlock.checkAgain' | transloco }}
          </button>
        }
      </header>

      @if (store.status(); as status) {
        <div role="status" aria-live="polite" data-testid="pi-update">
          @if (status.skipped) {
            <p class="t-sm muted px-4 pt-3 m-0">
              {{
                'settings.versionsBlock.checkingForUpdatesIsTurnedOffIs'
                  | transloco
                    : {
                        value1:
                          status.skipped === 'offline'
                            ? ('settings.versionsBlock.pIOFFLINE' | transloco)
                            : ('settings.versionsBlock.pISKIPVERSIONCHECK' | transloco),
                      }
              }}
            </p>
          }
        </div>

        <!-- pi-kit -->
        <div class="row" data-testid="row-app">
          <div>
            <div class="lbl">
              {{ 'settings.versionsBlock.piKit' | transloco }} <span class="mono">{{ app()?.current ?? '…' }}</span>
              <span class="chip" [class]="chip(app()).tone">{{ chip(app()).text }}</span>
            </div>
            <div class="hint">{{ appHint() }}</div>
            @if (app()?.error) {
              <div class="hint text-error">{{ app()?.error }}</div>
            }
          </div>
          <div class="ctl ctl-w">
            @if (store.appRestart()) {
              <button
                type="button"
                class="btn btn-sm btn-primary"
                [disabled]="store.loading()"
                (click)="store.installApp()"
              >
                {{ 'settings.versionsBlock.restartToUpdate' | transloco }}
              </button>
            } @else if (app()?.state === 'outdated') {
              <button type="button" class="btn btn-sm" [disabled]="store.running()" (click)="store.update(['app'])">
                {{ 'settings.versionsBlock.updatePiKit' | transloco }}
              </button>
            }
          </div>
        </div>

        <!-- pi -->
        <div class="row" data-testid="row-pi">
          <div>
            <div class="lbl">
              {{ 'settings.versionsBlock.pi' | transloco }} <span class="mono">{{ status.resolution.version }}</span>
              <span class="chip" [class]="chip(pi()).tone" data-testid="pi-chip">{{ chip(pi()).text }}</span>
            </div>
            <div class="hint" data-testid="pi-source">{{ sourceLine() }}</div>
            @for (note of status.resolution.notes; track $index) {
              <div class="hint text-warning" data-testid="pi-note">{{ note }}</div>
            }
            @if (pi()?.detail) {
              <div class="hint">{{ pi()?.detail }}</div>
            }
            @if (pi()?.error) {
              <div class="hint text-error">{{ pi()?.error }}</div>
            }
          </div>
          <div class="ctl ctl-w">
            @if (store.piRestart(); as restart) {
              <button
                type="button"
                class="btn btn-sm btn-primary"
                [disabled]="store.loading()"
                (click)="store.restartBackend()"
              >
                {{ 'settings.versionsBlock.restartToUse' | transloco: { value1: restart.version } }}
              </button>
            } @else {
              @if (needsCommand()) {
                <button
                  type="button"
                  class="btn btn-sm btn-ghost"
                  [disabled]="store.loading()"
                  (click)="store.installCommand()"
                >
                  {{ 'settings.versionsBlock.installThePiCommand' | transloco }}
                </button>
              }
              @if (pi()?.state === 'outdated') {
                <button type="button" class="btn btn-sm" [disabled]="store.running()" (click)="store.update(['pi'])">
                  {{ 'settings.versionsBlock.updatePi' | transloco }}
                </button>
              }
            }
          </div>
        </div>

        <!-- packages -->
        <div class="row" data-testid="row-packages">
          <div>
            <div class="lbl">
              {{ 'settings.versionsBlock.extensionsAndPackages' | transloco }}
              <span class="chip" [class]="chip(packages()).tone">{{
                packages()?.state === 'outdated'
                  ? packages()?.outdated + ('settings.versionsBlock.outdated' | transloco)
                  : chip(packages()).text
              }}</span>
            </div>
            <div class="hint">{{ packages()?.detail ?? '' }}</div>
            @if (packages()?.error) {
              <div class="hint text-error">{{ packages()?.error }}</div>
            }
          </div>
          <div class="ctl ctl-w">
            @if (packages()?.state === 'outdated') {
              <button
                type="button"
                class="btn btn-sm"
                [disabled]="store.running()"
                (click)="store.update(['packages'])"
              >
                {{ 'settings.versionsBlock.updatePackages' | transloco }}
              </button>
            }
          </div>
        </div>

        <!-- model catalogs -->
        <div class="row" data-testid="row-models">
          <div>
            <div class="lbl">
              {{ 'settings.versionsBlock.modelCatalogs' | transloco }}
              <span class="chip" [class]="chip(models()).tone">{{ chip(models()).text }}</span>
            </div>
            <div class="hint">
              {{ 'settings.versionsBlock.refreshedPiAlsoRefreshesThemItselfIn' | transloco: { value1: agoText() } }}
            </div>
          </div>
          <div class="ctl ctl-w">
            <button type="button" class="btn btn-sm" [disabled]="store.running()" (click)="store.update(['models'])">
              {{ 'settings.versionsBlock.refresh' | transloco }}
            </button>
          </div>
        </div>

        <!-- everything -->
        <div class="row" data-testid="row-all">
          <div>
            <div class="lbl">{{ 'settings.versionsBlock.updateEverything' | transloco }}</div>
            <div class="hint">
              {{ 'settings.versionsBlock.piPackagesModelCatalogsAndPiKit' | transloco }}
            </div>
          </div>
          <div class="ctl ctl-w">
            @if (store.running()) {
              <button type="button" class="btn btn-sm btn-ghost" [disabled]="store.loading()" (click)="store.cancel()">
                {{ 'settings.versionsBlock.cancel' | transloco }}
              </button>
            }
            <button
              type="button"
              class="btn btn-sm btn-primary"
              data-testid="update-all"
              [disabled]="store.running() || store.loading()"
              (click)="store.update(allTargets())"
            >
              {{ 'settings.versionsBlock.updateAll' | transloco }}
            </button>
          </div>
        </div>

        @if (progress().length > 0) {
          <pre
            class="t-xs muted whitespace-pre-wrap break-all max-h-40 overflow-auto m-0 px-4 pb-3"
            data-testid="update-log"
            [attr.aria-label]="'settings.versionsBlock.updateOutput' | transloco"
            >{{ progress().join('\\n') }}</pre>
        }
        @if (status.job?.logPath) {
          <p class="t-xs muted px-4 pb-3 break-all">
            {{ 'settings.versionsBlock.theLogIs' | transloco }} <code>{{ status.job.logPath }}</code>
          </p>
        }
      } @else {
        <p class="t-sm muted px-4 py-3">
          {{
            store.connected()
              ? ('settings.versionsBlock.readingTheVersions' | transloco)
              : ('settings.versionsBlock.theVersionsAppearOnceTheBackendAnswers' | transloco)
          }}
        </p>
      }
    </section>
  `,
})
export class PkVersions {
  protected readonly i18n = inject(Language);
  protected readonly store = inject(UpdateStore);

  protected readonly pi = this.store.pi;
  protected readonly packages = this.store.packages;
  protected readonly models = this.store.models;
  protected readonly app = this.store.app;

  protected readonly progress = computed(() =>
    this.store
      .lines()
      .slice(-6)
      .map((l) => l.text),
  );
  protected readonly needsCommand = computed(() => {
    const status = this.store.status();
    return !!status && !status.command.onPath && !!status.resolution.managed?.current;
  });

  protected allTargets(): UpdateTarget[] {
    // The app row only takes part where pi-kit can update itself.
    return ALL.filter((target) => target !== 'app' || this.store.app()?.state !== 'unavailable');
  }

  protected agoText(): string {
    return ago(this.i18n.t, this.store.models()?.updatedAt);
  }

  protected sourceLine(): string {
    const resolution = this.store.status()?.resolution;
    if (!resolution) return '';
    const where =
      resolution.source === 'managed'
        ? this.i18n.t('settings.versionsBlock.managedInstallSharedWithThePiCommand')
        : resolution.source === 'env'
          ? this.i18n.t('settings.versionsBlock.loadedFromPIKITPIDIR')
          : this.i18n.t('settings.versionsBlock.bundledWithPiKit', {
              value1: resolution.managed ? '' : this.i18n.t('settings.versionsBlock.thereIsNoManagedInstallYet'),
            });
    return this.i18n.t('settings.versionsBlock.updatesRunInTheBackgroundThroughPi', { value1: where });
  }

  protected appHint(): string {
    const status = this.store.status();
    if (!status) return '';
    if (this.app()?.state === 'unavailable') return this.app()?.detail ?? '';
    return this.i18n.t('settings.versionsBlock.updatesComeFromTheProjectSGitHub', {
      value1: status.desktop
        ? this.i18n.t('settings.versionsBlock.desktopApp')
        : this.i18n.t('settings.versionsBlock.browserDevelopment'),
    });
  }

  protected chip(row: UpdateRow | undefined): { text: string; tone: string } {
    switch (row?.state) {
      case 'outdated':
        return {
          text: row.latest
            ? this.i18n.t('settings.versionsBlock.available', { value1: row.latest })
            : this.i18n.t('settings.versionsBlock.updateAvailable'),
          tone: 'warn',
        };
      case 'current':
        return { text: this.i18n.t('settings.versionsBlock.upToDate'), tone: 'ok' };
      case 'running':
        return { text: this.i18n.t('settings.versionsBlock.updating'), tone: '' };
      case 'done':
        return { text: this.i18n.t('settings.versionsBlock.updated'), tone: 'ok' };
      case 'failed':
        return { text: this.i18n.t('settings.versionsBlock.failed'), tone: 'err' };
      case 'cancelled':
        return { text: this.i18n.t('settings.versionsBlock.cancelled'), tone: '' };
      case 'unavailable':
        return { text: this.i18n.t('settings.versionsBlock.notHere'), tone: '' };
      default:
        return { text: this.i18n.t('settings.versionsBlock.notChecked'), tone: '' };
    }
  }
}
