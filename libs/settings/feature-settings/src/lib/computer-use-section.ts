import { TranslocoPipe } from '@pi-kit/i18n';
import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, computed, inject } from '@angular/core';
import type { ComputerUsePermission } from '@pi-kit/protocol';
import { ComputerUseStore, SettingsStore } from '@pi-kit/settings/data';
import { PkSetting } from '@pi-kit/settings/api';

/** How often the page asks again while macOS still lacks a permission (the window's focus coming back asks at once). */
const POLL_MS = 1500;

/**
 * Settings › Computer use (`@pi-kit/computer-use`): the switch that `/computer-use on | off` also writes, and on macOS the two permissions with their state, a button that
 * asks macOS and opens the right page of System Settings, which app macOS gives them to (pi-kit, Electron for a development build, or a terminal) and, once Screen
 * Recording was asked for, Relaunch, because macOS applies it only to an app that starts again. The state follows System Settings by itself: the page reads it every
 * 1.5 s while something is missing and when the window gets the focus back.
 */
@Component({
  selector: 'pk-computer-use-section',
  imports: [PkSetting, TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(window:focus)': 'cu.load()' },
  template: `
    <div class="flex flex-col gap-5" data-testid="section-computer-use">
      @if (cu.state(); as s) {
        @if (!s.installed) {
          <div role="status" class="alert alert-soft alert-warning text-sm" data-testid="computer-use-not-installed">
            <span>{{ 'settings.computerUseSection.notInstalled' | transloco }}</span>
          </div>
        } @else if (!s.supported) {
          <div role="status" class="alert alert-soft alert-warning text-sm">
            <span>{{ 'settings.computerUseSection.notSupported' | transloco: { value1: s.platform } }}</span>
          </div>
        }
        @if (settings.shows('computer-use')) {
          <section class="pk-group" [attr.aria-label]="'shared.catalog.computerUse' | transloco">
            <header>
              <div>
                <h4>{{ 'shared.catalog.computerUse' | transloco }}</h4>
              </div>
            </header>
            <div pkSetting="computer-use">
              <span
                chips
                class="chip"
                [class.ok]="s.enabled"
                [class.off]="!s.enabled"
                data-testid="computer-use-state"
                >{{
                  s.enabled
                    ? ('settings.computerUseSection.on' | transloco)
                    : ('settings.computerUseSection.off' | transloco)
                }}</span
              >
              <input
                type="checkbox"
                class="toggle toggle-primary"
                data-testid="computer-use-toggle"
                aria-labelledby="lbl-computer-use"
                aria-describedby="hint-computer-use"
                [checked]="s.enabled"
                [disabled]="cu.busy() || !s.installed || !s.supported"
                (change)="cu.setEnabled($any($event.target).checked)"
              />
            </div>
          </section>
        }

        @if (
          s.installed &&
          s.platform === 'darwin' &&
          settings.shows('computer-use-accessibility', 'computer-use-screen', 'computer-use-app')
        ) {
          <section
            class="pk-group"
            [attr.aria-label]="'shared.catalog.computerUsePermissions' | transloco"
            data-testid="computer-use-permissions"
          >
            <header>
              <div>
                <h4>{{ 'shared.catalog.computerUsePermissions' | transloco }}</h4>
                <p data-testid="computer-use-permissions-intro">
                  @if (!s.enabled) {
                    {{ 'settings.computerUseSection.turnOnToCheck' | transloco }}
                  } @else if (allGranted()) {
                    {{ 'settings.computerUseSection.allGranted' | transloco: { value1: s.host.name } }}
                  } @else {
                    {{ 'settings.computerUseSection.grantTo' | transloco: { value1: s.host.name } }}
                  }
                </p>
              </div>
            </header>
            @if (s.needsRelaunch) {
              <div class="banner" role="status" data-testid="computer-use-relaunch">
                <span>{{ 'settings.computerUseSection.relaunchNeeded' | transloco: { value1: s.host.name } }}</span>
                @if (cu.canRelaunch() && s.host.kind !== 'terminal') {
                  <button
                    type="button"
                    class="btn btn-xs btn-primary ml-auto"
                    data-testid="computer-use-relaunch-now"
                    (click)="cu.relaunch()"
                  >
                    {{ 'settings.computerUseSection.relaunch' | transloco: { value1: s.host.name } }}
                  </button>
                } @else {
                  <span class="ml-auto">{{
                    'settings.computerUseSection.quitAndReopen' | transloco: { value1: s.host.name }
                  }}</span>
                }
              </div>
            }
            @for (row of rows; track row.key) {
              <div [pkSetting]="row.setting">
                @if (granted(row.key) !== undefined) {
                  <span
                    chips
                    class="chip"
                    [class.ok]="granted(row.key) === true"
                    [class.err]="granted(row.key) === false"
                    [attr.data-testid]="'computer-use-' + row.key + '-state'"
                    >{{ grantLabel(row.key) | transloco }}</span
                  >
                }
                <button
                  type="button"
                  class="btn btn-sm"
                  [attr.data-testid]="'computer-use-' + row.key + '-open'"
                  [disabled]="cu.busy() || !s.enabled || granted(row.key) === true"
                  (click)="cu.open(row.key)"
                >
                  {{ 'settings.computerUseSection.openSystemSettings' | transloco }}
                </button>
              </div>
            }
            <div pkSetting="computer-use-app">
              <div sub class="flex flex-col gap-1 mt-2 t-sm" data-testid="computer-use-host-note">
                @switch (s.host.kind) {
                  @case ('development') {
                    <div>{{ 'settings.computerUseSection.developmentBuild' | transloco }}</div>
                  }
                  @case ('terminal') {
                    <div>{{ 'settings.computerUseSection.terminalHost' | transloco: { value1: s.host.name } }}</div>
                  }
                }
                @if (s.host.adHoc) {
                  <div>{{ 'settings.computerUseSection.adHocBuild' | transloco }}</div>
                }
              </div>
              <span class="mono" data-testid="computer-use-host">{{ s.host.name }}</span>
            </div>
          </section>
        } @else if (s.installed && s.platform === 'win32') {
          <p class="muted t-sm">{{ 'settings.computerUseSection.windowsNoPermissions' | transloco }}</p>
        } @else if (s.installed && s.platform === 'linux') {
          <p class="muted t-sm">{{ 'settings.computerUseSection.linuxNoPermissions' | transloco }}</p>
        }
      } @else if (cu.error()) {
        <div class="err" role="alert">
          {{ 'settings.computerUseSection.theBackendDidNotAnswer' | transloco: { value1: cu.error() } }}
        </div>
      } @else {
        <div class="muted">{{ 'settings.computerUseSection.askingTheBackend' | transloco }}</div>
      }
    </div>
  `,
})
export class ComputerUseSection implements OnInit, OnDestroy {
  protected readonly cu = inject(ComputerUseStore);
  protected readonly settings = inject(SettingsStore);
  protected readonly rows: readonly { key: ComputerUsePermission; setting: string }[] = [
    { key: 'accessibility', setting: 'computer-use-accessibility' },
    { key: 'screenRecording', setting: 'computer-use-screen' },
  ];
  protected readonly allGranted = computed(() => {
    const permissions = this.cu.state()?.permissions;
    return Boolean(permissions?.accessibility && permissions.screenRecording);
  });
  private timer: ReturnType<typeof setInterval> | undefined;

  ngOnInit(): void {
    void this.cu.load();
    // Only while computer use is on and macOS still lacks something; otherwise there is nothing that can change on its own.
    this.timer = setInterval(() => {
      const s = this.cu.state();
      if (s?.enabled && s.permissions && !this.allGranted()) void this.cu.load();
    }, POLL_MS);
  }

  ngOnDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  protected granted(key: ComputerUsePermission): boolean | undefined {
    return this.cu.state()?.permissions?.[key];
  }

  protected grantLabel(key: ComputerUsePermission): string {
    return this.granted(key) ? 'settings.computerUseSection.granted' : 'settings.computerUseSection.notGranted';
  }
}
