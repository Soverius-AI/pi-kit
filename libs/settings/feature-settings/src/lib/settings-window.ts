import { Language } from '@pi-kit/i18n';
import { TranslocoPipe } from '@pi-kit/i18n';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  untracked,
  viewChild,
} from '@angular/core';
import {
  SETTINGS_NAV_GROUPS,
  settingsSections,
  type SettingsSection,
  type SettingsSectionId,
  sectionById,
} from '@pi-kit/ui';
import { AttendantStore } from '@pi-kit/threads/api';
import { UiStore } from '@pi-kit/data-access';
import { PkIcon, type PkIconName, PkTip } from '@pi-kit/design-system';
import { KeyWorkflow, LocalRuntimeWizard } from '@pi-kit/settings/api';
import { AdvancedSection, ExtensionsSection } from '@pi-kit/settings/feature-advanced';
import { AppearanceSection } from './appearance-section';
import { AttendantSection } from '@pi-kit/settings/feature-attendant';
import { McpSection } from '@pi-kit/settings/feature-connectors';
import { ConnectorsStore, SettingsStore } from '@pi-kit/settings/data';
import { GeneralSection } from './general-section';
import { KeybindingsSection } from '@pi-kit/settings/feature-keybindings';
import { ModelsSection, ProvidersSection } from '@pi-kit/settings/feature-providers';
import { ProjectsSection } from '@pi-kit/settings/feature-projects-trust';
import { VoiceSection } from './voice-section';
import { ComputerUseSection } from './computer-use-section';

/**
 * Settings: a left nav of sections with counts, a search box that filters settings by name and description, and the
 * section’s page on the right. Changes apply as they are made and end in the “Saved” tick; where a running session must be reloaded for a change to
 * count, a banner says so and offers the reload. The component renders `SettingsStore` and forwards clicks; the pages are the section components.
 * `UiStore.settings` is still the switch that opens it, because `/settings`, `/login`, the model chips and the sidebar call that. `SettingsDialog`
 * (the host in `settings-dialog.ts`) loads this window the first time it is asked for, so it stays out of the initial bundle.
 */
@Component({
  selector: 'pk-settings-window',
  imports: [
    AppearanceSection,
    ComputerUseSection,
    AdvancedSection,
    AttendantSection,
    ExtensionsSection,
    GeneralSection,
    KeybindingsSection,
    KeyWorkflow,
    LocalRuntimeWizard,
    McpSection,
    ModelsSection,
    PkIcon,
    PkTip,
    ProjectsSection,
    ProvidersSection,
    VoiceSection,
    TranslocoPipe,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (bus.settings()) {
      <div class="pk-settings">
        <button
          type="button"
          class="pk-backdrop"
          tabindex="-1"
          [attr.aria-label]="'settings.settingsWindow.closeSettings' | transloco"
          (click)="close()"
        ></button>
        <div
          #win
          class="win"
          role="dialog"
          aria-modal="true"
          [attr.aria-label]="'settings.settingsWindow.settings' | transloco"
          tabindex="-1"
          (keydown.escape)="escape($event)"
        >
          <div class="head">
            <h2>{{ 'settings.settingsWindow.settings' | transloco }}</h2>
            <input
              type="search"
              class="input input-sm flex-1"
              [attr.aria-label]="'settings.settingsWindow.searchSettings' | transloco"
              [placeholder]="'settings.settingsWindow.searchSettingsEGCompactionKeybindingTheme' | transloco"
              autocomplete="off"
              spellcheck="false"
              [value]="store.search()"
              (input)="store.setSearch($any($event.target).value)"
            />
            <span
              class="saved ml-auto"
              [class.saving]="store.saving() > 0"
              role="status"
              aria-live="polite"
              data-testid="saved"
            >
              @if (store.saving() > 0) {
                <span class="loading loading-spinner loading-xs" aria-hidden="true"></span
                ><span class="txt">{{ 'settings.settingsWindow.saving' | transloco }}</span>
              } @else if (store.saved()) {
                <span aria-hidden="true">✓</span
                ><span class="txt">{{ 'settings.settingsWindow.saved' | transloco }}</span>
              }
            </span>
            <button
              type="button"
              class="pk-close"
              [pkTip]="'settings.settingsWindow.closeEsc' | transloco"
              [attr.aria-label]="'settings.settingsWindow.closeSettings' | transloco"
              (click)="close()"
            >
              <pk-icon name="close" />
            </button>
          </div>

          @if (store.reloadReasons().length > 0) {
            <div class="banner" role="status" data-testid="reload-banner">
              <span>{{ 'settings.settingsWindow.reloadPiToApplyInTheOpen' | transloco: { value1: reasons() } }}</span>
              <button
                type="button"
                class="btn btn-xs btn-primary ml-auto"
                data-testid="reload-now"
                [disabled]="store.reloading() || !store.canReload()"
                [pkTip]="
                  store.canReload()
                    ? ('settings.settingsWindow.runsReload' | transloco)
                    : ('settings.settingsWindow.openAThreadFirst' | transloco)
                "
                (click)="store.reload()"
              >
                {{ 'settings.settingsWindow.reloadNow' | transloco }}
              </button>
              <button type="button" class="btn btn-xs btn-ghost" (click)="store.dismissReload()">
                {{ 'settings.settingsWindow.later' | transloco }}
              </button>
            </div>
          }

          <nav
            role="tablist"
            aria-orientation="vertical"
            [attr.aria-label]="'settings.settingsWindow.settingsSections' | transloco"
          >
            @for (group of groups; track group) {
              <div class="sec" role="presentation">{{ 'settings.nav.' + group | transloco }}</div>
              @for (section of sectionsOf(group); track section.id) {
                <button
                  type="button"
                  role="tab"
                  [attr.aria-selected]="isCurrent(section.id)"
                  [attr.aria-controls]="'settings-page'"
                  [attr.data-section]="section.id"
                  (click)="store.select(section.id)"
                >
                  <pk-icon class="ic" [name]="icon(section.id)" />
                  <span>{{ section.label }}</span>
                  @if (count(section.id); as c) {
                    @if (c.chip) {
                      <span class="chip cnt-chip" [class.off]="!attendantOn()" [class.ok]="attendantOn()">{{
                        c.text
                      }}</span>
                    } @else {
                      <span class="cnt" [class.warn]="c.warn">{{ c.text }}</span>
                    }
                  }
                </button>
              }
            }
          </nav>

          <main id="settings-page" role="tabpanel" tabindex="-1">
            @if (store.searching() && store.visibleSections().length === 0) {
              <div class="empty" role="status" data-testid="no-results">
                {{
                  'settings.settingsWindow.noSettingMatchesTryAWordFrom' | transloco: { value1: store.search().trim() }
                }}
              </div>
            }
            @for (id of store.visibleSections(); track id) {
              <div class="page" [attr.data-page]="id">
                <div class="intro">
                  <h3>{{ title(id) }}</h3>
                  <p>{{ intro(id) }}</p>
                </div>
                @switch (id) {
                  @case ('general') {
                    <pk-general-section />
                  }
                  @case ('appearance') {
                    <pk-appearance-section />
                  }
                  @case ('keybindings') {
                    <pk-keybindings-section />
                  }
                  @case ('models') {
                    <pk-models-section />
                  }
                  @case ('local-models') {
                    <pk-local-runtime-wizard />
                  }
                  @case ('providers') {
                    <pk-providers-section />
                  }
                  @case ('mcp') {
                    <pk-mcp-section />
                  }
                  @case ('extensions') {
                    <pk-extensions-section />
                  }
                  @case ('skills') {
                    <pk-extensions-section section="skills" />
                  }
                  @case ('projects') {
                    <pk-projects-section />
                  }
                  @case ('attendant') {
                    <pk-attendant-section />
                  }
                  @case ('advanced') {
                    <pk-advanced-section />
                  }
                  @case ('voice') {
                    <pk-voice-section />
                  }
                  @case ('computer-use') {
                    <pk-computer-use-section />
                  }
                }
              </div>
            }
          </main>
        </div>
        <pk-key-workflow />
      </div>
    }
  `,
})
export class SettingsWindow {
  protected readonly i18n = inject(Language);
  protected readonly bus = inject(UiStore);
  protected readonly store = inject(SettingsStore);
  private readonly attendant = inject(AttendantStore);
  protected readonly attendantOn = this.attendant.enabled;
  protected readonly connectors = inject(ConnectorsStore);
  private readonly win = viewChild<ElementRef<HTMLElement>>('win');

  protected readonly groups = SETTINGS_NAV_GROUPS;
  protected readonly reasons = computed(() =>
    this.store.reloadReasons().join(this.i18n.t('settings.settingsWindow.and')),
  );

  constructor() {
    effect(() => {
      if (this.bus.settings()) {
        queueMicrotask(() => this.win()?.nativeElement.focus());
        // The nav's chip says whether the attendant is on.
        untracked(() => void this.attendant.load());
      }
    });
  }

  protected icon(id: SettingsSectionId): PkIconName {
    return `settings-${id}`;
  }

  protected sectionsOf(group: string): SettingsSection[] {
    return settingsSections(this.i18n.t).filter((s) => s.group === group);
  }

  protected title(id: SettingsSectionId): string {
    return sectionById(this.i18n.t, id).label;
  }
  protected intro(id: SettingsSectionId): string {
    return sectionById(this.i18n.t, id).intro;
  }

  /** The selected tab: the chosen section, or none while a search shows several. */
  protected isCurrent(id: SettingsSectionId): boolean {
    return this.store.searching() ? this.store.visibleSections()[0] === id : this.store.section() === id;
  }

  /** The count or chip at the right of a nav item. */
  protected count(id: SettingsSectionId): { text: string; warn?: boolean; chip?: boolean } | undefined {
    if (this.store.searching()) {
      const n = this.store.matchCounts().get(id);
      return n ? { text: String(n) } : undefined;
    }
    switch (id) {
      case 'providers': {
        const n = this.store.providersSignedIn();
        return this.store.overview()
          ? { text: this.i18n.t('settings.settingsWindow.signedIn', { value1: n }) }
          : undefined;
      }
      case 'mcp':
        // "N on": the servers that are on.
        return this.connectors.onCount() > 0
          ? { text: this.i18n.t('settings.settingsWindow.on', { value1: this.connectors.onCount() }) }
          : undefined;
      case 'projects': {
        const n = this.store.workspaces().length;
        return n > 0 ? { text: String(n) } : undefined;
      }
      case 'extensions':
      case 'skills': {
        const items = this.store.resources()?.items ?? [];
        const n = items.filter((item) => (id === 'skills' ? item.type === 'skills' : item.type !== 'skills')).length;
        return n ? { text: String(n) } : undefined;
      }
      case 'keybindings': {
        const clashes = this.store.kitConflicts().size + this.store.piConflicts().size;
        return clashes > 0
          ? { text: this.i18n.t('settings.settingsWindow.clash', { value1: clashes }), warn: true }
          : undefined;
      }
      case 'attendant':
        return this.attendant.status()
          ? { text: this.i18n.t(this.attendant.enabled() ? 'common.state.on' : 'common.state.off'), chip: true }
          : undefined;
      default:
        return undefined;
    }
  }

  protected close(): void {
    this.bus.closeSettings();
  }

  /** Esc steps back first: from a project's page to the list, then closes the window. */
  protected escape(event: Event): void {
    if (this.store.project() && !this.store.searching()) {
      // The shell closes the window on an Esc nobody took; this one is taken.
      event.preventDefault();
      this.store.closeProject();
    } else this.close();
  }
}
