import type { Translate } from '@pi-kit/i18n';
import { Language } from '@pi-kit/i18n';
import { TranslocoPipe } from '@pi-kit/i18n';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { ThemeStore, type ThemePreference, CODE_SIZES, PROSE_SIZES, ViewPrefs } from '@pi-kit/data-access';
import { PkTabs, PkTabPanel } from '@pi-kit/design-system';
import { PkSetting } from '@pi-kit/settings/api';
import { SettingsStore } from '@pi-kit/settings/data';

const themeOptions = (translate: Translate): { id: ThemePreference; label: string }[] => [
  { id: 'system', label: translate('settings.appearanceSection.system') },
  { id: 'pi-dark', label: translate('settings.appearanceSection.dark') },
  { id: 'pi-light', label: translate('settings.appearanceSection.light') },
  { id: 'pi-soverius', label: 'Soverius' },
  { id: 'pi-copilotkit', label: 'CopilotKit' },
];

/** Settings › Appearance: theme, text sizes, density and what the transcript shows. All of it is pi-kit’s own (its database), applied to the page at once. */
@Component({
  selector: 'pk-appearance-section',
  imports: [PkSetting, PkTabs, PkTabPanel, TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="flex flex-col gap-5" data-testid="section-appearance">
      <pk-tabs [label]="'shared.catalog.appearance' | transloco" [(value)]="tab">
        @if (store.shows('theme', 'density', 'prose-size', 'code-size')) {
          <pk-tab-panel value="look" [label]="'settings.appearanceSection.look' | transloco">
            <section class="pk-group" [attr.aria-label]="'settings.appearanceSection.look' | transloco">
              <header>
                <div>
                  <h4>{{ 'settings.appearanceSection.look' | transloco }}</h4>
                  <p>{{ 'settings.appearanceSection.colourSizeAndSpacing' | transloco }}</p>
                </div>
              </header>
              <div pkSetting="theme">
                <div class="pk-seg" role="radiogroup" aria-labelledby="lbl-theme">
                  @for (theme of themes; track theme.id) {
                    <input
                      type="radio"
                      name="theme"
                      [attr.aria-label]="theme.label"
                      [checked]="themeService.preference() === theme.id"
                      (change)="store.setTheme(theme.id)"
                    />
                  }
                </div>
              </div>
              <div pkSetting="prose-size">
                <select
                  class="select select-sm"
                  aria-labelledby="lbl-prose-size"
                  (change)="store.setPref('proseSize', +$any($event.target).value)"
                >
                  @for (size of proseSizes; track size) {
                    <option [value]="size" [selected]="prefs.proseSize() === size">
                      {{ 'settings.appearanceSection.px' | transloco: { value1: size } }}
                    </option>
                  }
                </select>
              </div>
              <div pkSetting="code-size">
                <select
                  class="select select-sm"
                  aria-labelledby="lbl-code-size"
                  (change)="store.setPref('codeSize', +$any($event.target).value)"
                >
                  @for (size of codeSizes; track size) {
                    <option [value]="size" [selected]="prefs.codeSize() === size">
                      {{ 'settings.appearanceSection.px' | transloco: { value1: size } }}
                    </option>
                  }
                </select>
              </div>
              <div pkSetting="density">
                <div class="pk-seg" role="radiogroup" aria-labelledby="lbl-density">
                  <input
                    type="radio"
                    name="density"
                    [attr.aria-label]="'settings.appearanceSection.detailed' | transloco"
                    [checked]="prefs.density() === 'comfortable'"
                    (change)="store.setPref('density', 'comfortable')"
                  />
                  <input
                    type="radio"
                    name="density"
                    [attr.aria-label]="'settings.appearanceSection.compact' | transloco"
                    [checked]="prefs.density() === 'compact'"
                    (change)="store.setPref('density', 'compact')"
                  />
                </div>
              </div>
            </section>
          </pk-tab-panel>
        }
        @if (store.shows('show-usage', 'thinking-expanded', 'collapse-tool-output')) {
          <pk-tab-panel value="transcript" [label]="'settings.appearanceSection.transcript' | transloco">
            <section class="pk-group" [attr.aria-label]="'settings.appearanceSection.transcript' | transloco">
              <header>
                <div>
                  <h4>{{ 'settings.appearanceSection.transcript' | transloco }}</h4>
                  <p>{{ 'settings.appearanceSection.whatEachTurnShows' | transloco }}</p>
                </div>
              </header>
              <div pkSetting="show-usage">
                <input
                  type="checkbox"
                  class="toggle toggle-primary"
                  aria-labelledby="lbl-show-usage"
                  aria-describedby="hint-show-usage"
                  [checked]="prefs.showUsage()"
                  (change)="store.setPref('showUsage', $any($event.target).checked)"
                />
              </div>
              <div pkSetting="thinking-expanded">
                <input
                  type="checkbox"
                  class="toggle toggle-primary"
                  aria-labelledby="lbl-thinking-expanded"
                  aria-describedby="hint-thinking-expanded"
                  [checked]="prefs.thinkingExpanded()"
                  (change)="store.setPref('thinkingExpanded', $any($event.target).checked)"
                />
              </div>
              <div pkSetting="collapse-tool-output">
                <input
                  type="checkbox"
                  class="toggle toggle-primary"
                  aria-labelledby="lbl-collapse-tool-output"
                  aria-describedby="hint-collapse-tool-output"
                  [checked]="prefs.collapseToolOutput()"
                  (change)="store.setPref('collapseToolOutput', $any($event.target).checked)"
                />
              </div>
            </section>
          </pk-tab-panel>
        }
      </pk-tabs>
    </div>
  `,
})
export class AppearanceSection {
  protected readonly tab = signal('look');
  protected readonly i18n = inject(Language);
  protected readonly store = inject(SettingsStore);
  protected readonly prefs = inject(ViewPrefs);
  protected readonly themeService = inject(ThemeStore);
  protected get themes() {
    return themeOptions(this.i18n.t);
  }
  protected readonly proseSizes = PROSE_SIZES;
  protected readonly codeSizes = CODE_SIZES;
}
