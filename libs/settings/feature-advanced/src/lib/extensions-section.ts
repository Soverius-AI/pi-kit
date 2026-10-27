import { Language, TranslocoPipe } from '@pi-kit/i18n';
import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { ChatStore } from '@pi-kit/chat/api';
import { UiStore } from '@pi-kit/data-access';
import { PkIcon, PkItem, PkScrollArea, PkTabPanel, PkTabs, PkTip } from '@pi-kit/design-system';
import { type ResourceItem, type SkillScope, isSkillName, skillTextProblems } from '@pi-kit/protocol';
import { type EditorSource, FileEditorDialog, PackagesStore, PkSetting, SettingsStore } from '@pi-kit/settings/api';
import { packages } from '@pi-kit/settings/util';
import { PkContextMenu, type PkMenuItem } from '@pi-kit/ui';
import { AddPackageWizard } from './add-package-wizard';
import { PkLearnedRetired, PkLearnedSkill } from './learned-skill';

/** Shared resource controls for Settings › Extensions and Settings › Skills. Packages and prompt files
 * stay on Extensions; skill creation, editing, learned skills and slash commands live on Skills.
 */
@Component({
  selector: 'pk-extensions-section',
  imports: [
    AddPackageWizard,
    FileEditorDialog,
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
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './extensions-section.html',
})
export class ExtensionsSection {
  protected readonly tab = signal('');
  protected readonly i18n = inject(Language);
  readonly section = input<'extensions' | 'skills'>('extensions');
  protected readonly store = inject(SettingsStore);
  protected readonly pkgs = inject(PackagesStore);
  protected readonly chat = inject(ChatStore);
  private readonly ui = inject(UiStore);

  protected readonly menu = signal<{ row: packages.PackageRow; x: number; y: number } | undefined>(undefined);
  /** The package whose removal is being confirmed, and the one whose contents are shown. */
  protected readonly removing = signal('');
  protected readonly open = signal('');
  protected readonly newSkill = signal(false);
  protected readonly newSkillName = signal('');
  protected readonly newSkillScope = signal<SkillScope>('user');
  protected readonly newSkillError = signal('');
  protected readonly creating = signal(false);

  /** The search words that item text has; with a search active, the items that have all of them (all items if none has). */
  private readonly filtered = computed(() => {
    const all = this.store.resources()?.items ?? [];
    const words = this.store.search().toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return all;
    const hit = all.filter((i) =>
      words.every((w) => `${i.name} ${i.description ?? ''} ${i.path} ${i.label} ${i.type}`.toLowerCase().includes(w)),
    );
    return hit.length > 0 ? hit : all;
  });

  /** Skills from the user's and the project's skill folders. A skill a package brings is under its package. */
  protected readonly yourSkills = computed(() =>
    this.filtered().filter((i) => i.type === 'skills' && i.origin !== 'package'),
  );
  /** Extensions and prompt templates that are files of the user's or the project's, and pi's built-in ones. */
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

  /** The skill file the editor dialog works on: its text, its check (the frontmatter pi needs), its save. */
  protected readonly skillSource = computed<EditorSource | undefined>(() => {
    const edit = this.pkgs.skillEditor();
    if (!edit) return undefined;
    const path = edit.path;
    return {
      title: path.replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~'),
      chips: [
        { text: this.i18n.t('settings.extensionsSection.skillNoun'), tone: 'off' as const },
        ...(edit.created ? [{ text: this.i18n.t('settings.extensionsSection.new'), tone: 'ok' as const }] : []),
      ],
      language: 'markdown',
      load: async () => {
        const file = await this.pkgs.skillFile(path);
        return { text: file.text, mtime: file.mtime };
      },
      save: async (text, mtime) => {
        const file = await this.pkgs.saveSkill(path, { text, mtime });
        return { text: file.text, mtime: file.mtime };
      },
      check: (text) => {
        const [first] = skillTextProblems(text);
        return first ? { message: first } : undefined;
      },
      valid: () => this.i18n.t('settings.extensionsSection.piCanLoadThisSkillSSaves'),
      saveLabel: this.i18n.t('settings.extensionsSection.save'),
      isNew: edit.created === true,
    };
  });

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

  constructor() {
    // Showing the section asks for what is installed.
    effect(() => {
      if (this.section() === 'extensions') untracked(() => void this.pkgs.load());
    });
  }

  protected count(items: readonly ResourceItem[]): string {
    return this.i18n.t('settings.extensionsSection.ofOn', {
      value1: items.filter((i) => i.enabled).length,
      value2: items.length,
    });
  }

  protected busy(id: string): boolean {
    return this.pkgs.busy().has(id) || this.store.resourcesBusy().includes(id);
  }

  /** What a package brings, from the resource list pi gave (the same entries, so one switch is one switch). */
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

  /** The skill or prompt template as a chip in the composer of the open thread; the dialog closes and the composer has the focus. */
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

  protected async createSkill(event: Event): Promise<void> {
    event.preventDefault();
    const name = this.newSkillName().trim();
    if (!isSkillName(name))
      return void this.newSkillError.set(
        this.i18n.t('settings.extensionsSection.useLowercaseLettersDigitsAndSingleHyphens'),
      );
    this.creating.set(true);
    const result = await this.pkgs.newSkill({ name, scope: this.newSkillScope() });
    this.creating.set(false);
    if (result.ok) {
      this.newSkill.set(false);
      this.newSkillName.set('');
    } else this.newSkillError.set(result.error);
  }
}
