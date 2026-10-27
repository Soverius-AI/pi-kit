import { Language } from '@pi-kit/i18n';
import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { PkTip } from '@pi-kit/design-system';
import { settingById, storageLabel, storageTitle } from '@pi-kit/ui';
import { SettingsStore } from '@pi-kit/settings/data';

/**
 * One row of a settings group: the name and the chip that says where the setting is stored, the description under
 * it, the control on the right. Name, description and storage come from the catalog by id, so the search box and the page can never disagree. The
 * row hides itself when the search does not match it. The host *is* the row (an attribute selector), so the group’s hairlines between rows keep
 * working.
 *
 *   <div pkSetting="auto-compaction"><input type="checkbox" class="toggle" aria-labelledby="lbl-auto-compaction" /></div>
 *
 * Slots: the default one is the control; `[sub]` is extra lines under the description; `[chips]` is more state chips after the name.
 */
@Component({
  // The host is the row itself, so the group's hairlines between rows keep working: an attribute selector on purpose.
  // eslint-disable-next-line @angular-eslint/component-selector
  selector: '[pkSetting]',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [PkTip],
  host: { class: 'row', '[attr.data-setting]': 'id()', '[hidden]': '!visible()' },
  template: `
    <div class="min-w-0">
      <div class="lbl">
        <span [id]="'lbl-' + id()">{{ entry().name }}</span>
        <span class="chip store" [pkTip]="storageTip()" [attr.data-storage]="entry().storage">{{ storage() }}</span>
        <ng-content select="[chips]" />
      </div>
      <div class="hint" [id]="'hint-' + id()">{{ entry().description }}</div>
      <ng-content select="[sub]" />
    </div>
    <div class="ctl ctl-w"><ng-content /></div>
  `,
})
export class PkSetting {
  protected readonly i18n = inject(Language);
  private readonly store = inject(SettingsStore);
  readonly id = input.required<string>({ alias: 'pkSetting' });

  protected readonly entry = computed(
    () =>
      settingById(this.i18n.t, this.id()) ?? {
        id: this.id(),
        section: 'general' as const,
        group: '',
        name: this.id(),
        description: '',
        storage: 'pi-kit' as const,
      },
  );
  protected readonly storage = computed(() => storageLabel(this.i18n.t, this.entry()));
  protected readonly storageTip = computed(() => storageTitle(this.i18n.t, this.entry()));
  protected readonly visible = computed(() => this.store.matches().has(this.id()));
}
