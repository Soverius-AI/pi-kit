import { DecimalPipe } from '@angular/common';
import {
  Component,
  ElementRef,
  Injector,
  DestroyRef,
  computed,
  inject,
  linkedSignal,
  signal,
  viewChild,
} from '@angular/core';
import { errorMessage } from '@pi-kit/api';
import { keepFocusInside, PkIcon } from '@pi-kit/design-system';
import { TranslocoPipe } from '@pi-kit/i18n';
import type { SkillDetail, SkillScope, SkillSearchResult } from '@pi-kit/protocol';
import { PackagesStore, SettingsStore } from '@pi-kit/settings/api';
import { DialogStore } from '@pi-kit/data-access';

@Component({
  selector: 'pk-install-skill-dialog',
  imports: [TranslocoPipe, PkIcon, DecimalPipe],
  templateUrl: './install-skill-dialog.html',
  styleUrl: './install-skill-dialog.css',
})
export class InstallSkillDialog {
  protected readonly pkgs = inject(PackagesStore);
  private readonly settings = inject(SettingsStore);
  private readonly injector = inject(Injector);
  private readonly win = viewChild<ElementRef<HTMLElement>>('win');
  private readonly previews = new Map<string, SkillDetail>();
  private readonly dialogs = inject(DialogStore);
  readonly query = signal('');
  readonly results = signal<SkillSearchResult[]>([]);
  readonly selected = signal<SkillSearchResult | undefined>(undefined);
  readonly searching = signal(false);
  readonly searched = signal(false);
  readonly installing = signal(false);
  readonly error = signal('');
  readonly loading = signal(false);
  readonly info = signal<SkillDetail | undefined>(undefined);
  readonly detailError = signal('');
  private searchAbort?: AbortController;
  private searchTimer?: ReturnType<typeof setTimeout>;
  private previewAbort?: AbortController;
  protected readonly projectAvailable = computed(() => !!this.pkgs.cwd() && !this.settings.resources()?.projectSkipped);
  readonly scope = linkedSignal<boolean, SkillScope>({
    source: this.projectAvailable,
    computation: (available, previous) => (available ? (previous?.value ?? 'user') : 'user'),
  });
  protected readonly destination = computed(() => {
    const root =
      this.scope() === 'project' ? `${this.pkgs.cwd()}/.pi` : this.settings.settings()?.agentDir || '~/.pi/agent';
    return `${root.replace(/\/$/, '')}/skills/${this.selected()?.name ?? ''}/`;
  });
  protected readonly sourceUrl = computed(() => {
    const d = this.info();
    return d
      ? `https://github.com/${d.source}/tree/${d.commit}${d.path === '.' ? '' : '/' + d.path.split('/').map(encodeURIComponent).join('/')}`
      : '';
  });

  constructor() {
    const previous = document.activeElement;
    keepFocusInside(this.injector, () => this.win()?.nativeElement);
    inject(DestroyRef).onDestroy(() => {
      clearTimeout(this.searchTimer);
      this.searchAbort?.abort();
      this.previewAbort?.abort();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    });
  }

  search(query: string): void {
    this.query.set(query);
    clearTimeout(this.searchTimer);
    this.searchAbort?.abort();
    const abort = new AbortController();
    this.searchAbort = abort;
    const q = query.trim();
    this.results.set([]);
    this.error.set('');
    this.searched.set(false);
    this.searching.set(q.length >= 2);
    if (q.length < 2) return;
    this.searchTimer = setTimeout(async () => {
      try {
        const response = await this.pkgs.searchSkills(q, abort.signal);
        if (abort.signal.aborted) return;
        this.results.set(response.results);
        this.error.set(response.error ?? '');
        this.searched.set(true);
      } catch (error) {
        if (!abort.signal.aborted) this.error.set(errorMessage(error));
      } finally {
        if (!abort.signal.aborted) this.searching.set(false);
      }
    }, 300);
  }

  private async preview(skill?: SkillSearchResult): Promise<void> {
    this.previewAbort?.abort();
    this.info.set(undefined);
    this.detailError.set('');
    this.loading.set(!!skill);
    if (!skill) return;
    const cached = this.previews.get(skill.id);
    if (cached) {
      this.info.set(cached);
      this.loading.set(false);
      return;
    }
    const abort = new AbortController();
    this.previewAbort = abort;
    try {
      const detail = await this.pkgs.skillDetail(skill.source, skill.name, abort.signal);
      if (abort.signal.aborted) return;
      this.previews.set(skill.id, detail);
      this.info.set(detail);
    } catch (error) {
      if (!abort.signal.aborted) this.detailError.set(errorMessage(error));
    } finally {
      if (!abort.signal.aborted) this.loading.set(false);
    }
  }

  protected cachedDescription(skill: SkillSearchResult): string | undefined {
    return this.previews.get(skill.id)?.description;
  }
  protected size(bytes: number): string {
    return bytes < 1024
      ? `${bytes} B`
      : bytes < 1024 * 1024
        ? `${(bytes / 1024).toFixed(1)} KB`
        : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  select(skill: SkillSearchResult): void {
    this.selected.set(skill);
    this.error.set('');
    void this.preview(skill);
    keepFocusInside(this.injector, () => this.win()?.nativeElement);
  }
  back(): void {
    if (!this.installing()) {
      this.selected.set(undefined);
      void this.preview();
      this.error.set('');
      keepFocusInside(this.injector, () => this.win()?.nativeElement);
    }
  }
  close(): void {
    if (!this.installing()) this.dialogs.close();
  }
  retryPreview(): void {
    void this.preview(this.selected());
    keepFocusInside(this.injector, () => this.win()?.nativeElement);
  }

  async install(): Promise<void> {
    const skill = this.selected();
    const detail = this.info();
    if (!skill || !detail || this.installing() || (this.scope() === 'project' && !this.projectAvailable())) return;
    this.installing.set(true);
    this.error.set('');
    const result = await this.pkgs.installSkill({
      source: skill.source,
      name: skill.name,
      scope: this.scope(),
      commit: detail.commit,
    });
    this.installing.set(false);
    if (result.ok) this.dialogs.close();
    else this.error.set(result.error);
  }
}
