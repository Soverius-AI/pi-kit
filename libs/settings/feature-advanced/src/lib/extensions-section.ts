import { Language, TranslocoPipe } from '@pi-kit/i18n';
import { Component, computed, inject, input, signal, linkedSignal, DestroyRef } from '@angular/core';
import { ChatStore } from '@pi-kit/chat/api';
import { DialogStore, UiStore } from '@pi-kit/data-access';
import { PkIcon, PkItem, PkScrollArea, PkTabPanel, PkTabs, PkTip } from '@pi-kit/design-system';
import { type ResourceItem } from '@pi-kit/protocol';
import { PackagesStore, PkSetting, SettingsStore } from '@pi-kit/settings/api';
import { packages } from '@pi-kit/settings/util';
import { PkContextMenu, type PkMenuItem } from '@pi-kit/ui';
import { errorMessage } from '@pi-kit/api';
import { LearnedStore } from '@pi-kit/threads/api';
import { InstallSkillDialog } from './install-skill-dialog';
import { DeleteSkillDialog } from './delete-skill-dialog';
import { AddPackageWizard } from './add-package-wizard';
import { PkLearnedRetired, PkLearnedSkill } from './learned-skill';

@Component({
  selector: 'pk-extensions-section',
  imports: [
    AddPackageWizard,
    PkContextMenu,
    PkItem,
    PkSetting,
    PkTip,
    PkTabs,
    PkTabPanel,
    PkScrollArea,
    PkLearnedSkill,
    PkLearnedRetired,
    TranslocoPipe,
    PkIcon,
  ],
  templateUrl: './extensions-section.html',
})
export class ExtensionsSection {
  readonly section = input<'extensions' | 'skills'>('extensions');
  protected readonly tab = linkedSignal<string>(() => (this.section() === 'skills' ? 'inventory' : 'packages'));
  protected readonly i18n = inject(Language);
  protected readonly store = inject(SettingsStore);
  protected readonly pkgs = inject(PackagesStore);
  protected readonly chat = inject(ChatStore);
  private readonly ui = inject(UiStore);

  protected readonly menu = signal<{ row: packages.PackageRow; x: number; y: number } | undefined>(undefined);
  protected readonly removing = signal('');
  protected readonly open = signal('');
  private readonly learned = inject(LearnedStore);
  private readonly dialogs = inject(DialogStore);
  private readonly destroyRef = inject(DestroyRef);
  protected readonly deleteError = signal('');
  protected readonly deleteBusy = signal('');

  protected canDeleteSkill(row: ResourceItem): boolean {
    if (row.type !== 'skills' || row.origin !== 'top-level' || !['local', 'auto'].includes(row.source)) return false;
    const path = row.path.replace(/\\/g, '/');
    if (this.learned.live().some((s) => s.path.replace(/\\/g, '/') === path)) return false;
    const root =
      row.scope === 'user' ? this.store.settings()?.agentDir : this.pkgs.cwd() ? `${this.pkgs.cwd()}/.pi` : undefined;
    return !!root && path === `${root.replace(/\\/g, '/').replace(/\/$/, '')}/skills/${row.name}/SKILL.md`;
  }

  protected async confirmDeleteSkill(row: ResourceItem): Promise<void> {
    if (!this.canDeleteSkill(row) || this.deleteBusy()) return;
    this.deleteError.set('');
    this.deleteBusy.set(row.path);
    try {
      // Capture the version before showing confirmation, never immediately before deleting.
      const file = await this.pkgs.skillFile(row.path);
      if (this.destroyRef.destroyed) return;
      this.dialogs.show({
        kind: 'component',
        component: DeleteSkillDialog,
        inputs: { skill: row, mtime: file.mtime },
        canClose: () => !this.pkgs.busy().has(row.path),
      });
    } catch (error) {
      this.deleteError.set(errorMessage(error));
    } finally {
      this.deleteBusy.set('');
    }
  }

  protected openInstallSkill(): void {
    this.dialogs.show({
      kind: 'component',
      component: InstallSkillDialog,
      canClose: () => !this.pkgs.busy().has('skill:+'),
    });
  }

  private readonly filtered = computed(() => {
    const all = this.store.resources()?.items ?? [];
    const words = this.store.search().toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return all;
    const hit = all.filter((i) =>
      words.every((w) => `${i.name} ${i.description ?? ''} ${i.path} ${i.label} ${i.type}`.toLowerCase().includes(w)),
    );
    return hit.length > 0 ? hit : all;
  });

  protected readonly yourSkills = computed(() =>
    this.filtered().filter((i) => i.type === 'skills' && i.origin !== 'package'),
  );
  protected readonly yourFiles = computed(() =>
    this.filtered().filter((i) => i.type !== 'skills' && i.origin !== 'package'),
  );
  protected readonly packageRows = computed(() =>
    packages.packageRows.bind(undefined, this.i18n.t)(this.pkgs.packages(), undefined),
  );
  protected readonly summary = computed(() =>
    this.pkgs.overview()
      ? packages.packagesSummary.bind(undefined, this.i18n.t)(this.pkgs.packages())
      : this.i18n.t('settings.extensionsSection.readingWhatIsInstalled'),
  );
  protected readonly onText = computed(() =>
    packages.packagesOnText.bind(undefined, this.i18n.t)(this.pkgs.packages()),
  );

  protected readonly menuItems = computed<PkMenuItem[]>(() => {
    const row = this.menu()?.row;
    if (!row) return [];
    const items: PkMenuItem[] = [];
    if (row.outdated) items.push({ id: 'update', label: this.i18n.t('settings.extensionsSection.update') });
    items.push({
      id: 'remove',
      label: this.i18n.t('settings.extensionsSection.removeMenuAction'),
      danger: true,
      separatorBefore: items.length > 0,
    });
    return items;
  });

  protected count(items: readonly ResourceItem[]): string {
    return this.i18n.t('settings.extensionsSection.ofOn', {
      value1: items.filter((i) => i.enabled).length,
      value2: items.length,
    });
  }

  protected busy(id: string): boolean {
    return this.pkgs.busy().has(id) || this.store.resourcesBusy().includes(id);
  }

  protected contentsOf(source: string, scope: 'user' | 'project'): ResourceItem[] {
    return (this.store.resources()?.items ?? []).filter(
      (i) => i.origin === 'package' && i.source === source && i.scope === scope,
    );
  }

  protected addTitle(item: ResourceItem): string {
    if (!this.chat.threadId()) return this.i18n.t('settings.extensionsSection.openAThreadFirst');
    if (!item.enabled) return this.i18n.t('settings.extensionsSection.turnItOnFirst');
    return this.i18n.t('settings.extensionsSection.putsInTheComposerAsAChip', {
      value1:
        item.type === 'skills'
          ? this.i18n.t('settings.extensionsSection.theSkill')
          : this.i18n.t('settings.extensionsSection.theTemplate'),
      value2: item.name,
    });
  }

  protected addToComposer(item: ResourceItem): void {
    this.chat.addChip({ kind: item.type === 'skills' ? 'skill' : 'prompt', name: item.name, scope: item.scope });
    this.ui.closeSettings();
    this.ui.focusComposer();
  }

  protected openMenu(event: MouseEvent, row: packages.PackageRow): void {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    this.menu.set({ row, x: rect.left, y: rect.bottom + 4 });
  }

  protected choose(id: string): void {
    const row = this.menu()?.row;
    this.menu.set(undefined);
    if (!row) return;
    if (id === 'update') void this.pkgs.update(row.id);
    else if (id === 'remove') this.removing.set(row.id);
  }

  protected async remove(id: string): Promise<void> {
    this.removing.set('');
    await this.pkgs.remove(id);
  }
}
