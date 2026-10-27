import type { Translate } from '@pi-kit/i18n';
import { Language } from '@pi-kit/i18n';
import { TranslocoPipe } from '@pi-kit/i18n';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  type OnInit,
  computed,
  effect,
  inject,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { errorMessage } from '@pi-kit/api';
import { keepFocusInside, PkChoice, PkIcon, PkTip } from '@pi-kit/design-system';
import {
  PACKAGE_KINDS,
  type PackageDetail,
  type PackageKind,
  type PackageSearchKind,
  type PackageSearchResult,
} from '@pi-kit/protocol';
import { PackagesStore } from '@pi-kit/settings/api';
import { packages } from '@pi-kit/settings/util';

const kindLabels = (translate: Translate): Record<PackageKind, string> => ({
  extensions: translate('settings.addPackageWizard.extensions'),
  skills: translate('settings.addPackageWizard.skills'),
  prompts: translate('settings.addPackageWizard.prompts'),
  themes: translate('settings.addPackageWizard.themes'),
});
const SEARCH_DELAY_MS = 300;

/**
 * The “Add a package” wizard: step 1 finds a package (Browse: an npm search for the `pi-package` keyword plus pi-kit's own two,
 * filtered by what they contain; From git: a repository address; From a folder: a path), step 2 says what it adds, shows its README as plain text and the exact `pi install` command, and
 * installs it. The steps are `packages.AddPackageState` (pure); the search and the detail are the store's calls, and a later answer never replaces a newer one.
 */
@Component({
  selector: 'pk-add-package-wizard',
  imports: [PkChoice, PkTip, TranslocoPipe, PkIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="pk-wf" data-testid="add-package-wizard">
      <button
        type="button"
        class="pk-backdrop"
        tabindex="-1"
        [attr.aria-label]="'settings.addPackageWizard.close' | transloco"
        (click)="close()"
      ></button>
      <div
        #win
        class="win wide"
        role="dialog"
        aria-modal="true"
        [attr.aria-label]="'settings.addPackageWizard.addAPackage' | transloco"
        tabindex="-1"
        (keydown.escape)="$event.preventDefault(); $event.stopPropagation(); close()"
      >
        <div class="head">
          <h2>{{ 'settings.addPackageWizard.addAPackage' | transloco }}</h2>
          <div
            class="pk-seg pk-seg-xs ml-2"
            role="radiogroup"
            [attr.aria-label]="'settings.addPackageWizard.whereThePackageComesFrom' | transloco"
          >
            @for (t of tabs; track t.id) {
              <input
                type="radio"
                name="src"
                [attr.aria-label]="t.label"
                [attr.data-testid]="'tab-' + t.id"
                [checked]="state().tab === t.id"
                [disabled]="state().step === 'confirm' || installing()"
                (change)="setTab(t.id)"
              />
            }
          </div>
          <span
            class="dots"
            role="img"
            [attr.aria-label]="
              ('settings.addPackageWizard.step' | transloco) +
              (state().step === 'pick' ? 1 : 2) +
              ('settings.addPackageWizard.of2' | transloco)
            "
            ><i class="on"></i><i [class.on]="state().step === 'confirm'"></i
          ></span>
          <button
            type="button"
            class="pk-close ml-auto"
            [pkTip]="'settings.addPackageWizard.closeEsc' | transloco"
            [attr.aria-label]="'settings.addPackageWizard.close' | transloco"
            (click)="close()"
          >
            <pk-icon name="close" />
          </button>
        </div>

        <div class="body">
          @if (state().step === 'pick') {
            <div class="wstep" [class.back]="state().direction === 'back'" data-wstep="pick">
              @switch (state().tab) {
                @case ('browse') {
                  <div class="flex items-center gap-3">
                    <input
                      type="search"
                      class="input input-sm flex-1"
                      [placeholder]="'settings.addPackageWizard.searchPackagesEGSubagents' | transloco"
                      [attr.aria-label]="'settings.addPackageWizard.searchPackages' | transloco"
                      autocomplete="off"
                      spellcheck="false"
                      data-testid="package-search"
                      [value]="state().query"
                      (input)="search($any($event.target).value)"
                    />
                    <select
                      class="select select-sm"
                      [attr.aria-label]="'settings.addPackageWizard.whatItContains' | transloco"
                      data-testid="package-kind"
                      (change)="setKind($any($event.target).value)"
                    >
                      <option value="all" [selected]="state().kind === 'all'">
                        {{ 'settings.addPackageWizard.everything' | transloco }}
                      </option>
                      @for (k of kinds; track k) {
                        <option [value]="k" [selected]="state().kind === k">{{ kindLabel[k] }}</option>
                      }
                    </select>
                  </div>
                  <div class="hint" data-testid="browse-hint">{{ browseHint() }}</div>
                  @if (searchError(); as text) {
                    <div class="box" role="status" data-testid="search-error">
                      <div class="ok-line">
                        <span class="chip warn">{{ 'settings.addPackageWizard.registry' | transloco }}</span
                        ><span>{{ text }}</span>
                      </div>
                    </div>
                  }
                  <div
                    class="pk-choices one"
                    role="group"
                    [attr.aria-label]="'settings.addPackageWizard.packages' | transloco"
                  >
                    @for (r of results(); track r.name) {
                      <button
                        pkChoice
                        [pressed]="state().picked?.name === r.name"
                        [attr.data-testid]="'result-' + r.name"
                        (click)="pick(r)"
                      >
                        <ng-container tile>
                          <pk-icon
                            [name]="r.contains.length > 0 && !r.contains.includes('extensions') ? 'skill' : 'extension'"
                          />
                        </ng-container>
                        <ng-container t>
                          {{ r.name }}
                          @if (r.bundled) {
                            <span class="chip off">{{ 'settings.addPackageWizard.shipsWithPiKit' | transloco }}</span>
                          }
                          @if (r.installed) {
                            <span class="chip ok">{{ 'settings.addPackageWizard.installed' | transloco }}</span>
                          }
                          @if (r.contains.length > 0 && !r.exact && !r.contains.includes('extensions')) {
                            <span class="chip off">{{
                              'settings.addPackageWizard.only' | transloco: { value1: r.contains.join(', ') }
                            }}</span>
                          }
                        </ng-container>
                        <ng-container d>{{ r.description }} {{ detail(r) }}</ng-container>
                      </button>
                    } @empty {
                      @if (!searching()) {
                        <p class="t-sm muted m-0" data-testid="no-results">
                          {{ 'settings.addPackageWizard.noPackageMatchesFromGitAndFrom' | transloco }}
                        </p>
                      }
                    }
                  </div>
                  @if (searching()) {
                    <div class="grid place-items-center py-2">
                      <span
                        class="loading loading-dots loading-sm text-primary"
                        [attr.aria-label]="'settings.addPackageWizard.searching' | transloco"
                      ></span>
                    </div>
                  }
                }
                @case ('git') {
                  <div class="pk-form">
                    <label for="pkg-git">{{ 'settings.addPackageWizard.repository' | transloco }}</label>
                    <input
                      id="pkg-git"
                      class="input input-sm mono"
                      [placeholder]="'settings.addPackageWizard.gitGithubComOwnerName' | transloco"
                      autocomplete="off"
                      spellcheck="false"
                      data-testid="package-git"
                      [value]="state().git"
                      (input)="typeGit($any($event.target).value)"
                      (keydown.enter)="next()"
                    />
                    <div class="hint">
                      {{ 'settings.addPackageWizard.anAddressPiCanCloneGitGithub' | transloco }}
                    </div>
                  </div>
                }
                @case ('folder') {
                  <div class="pk-form">
                    <label for="pkg-folder">{{ 'settings.addPackageWizard.folder' | transloco }}</label>
                    <input
                      id="pkg-folder"
                      class="input input-sm mono"
                      [placeholder]="'settings.addPackageWizard.projectsMyPiPackage' | transloco"
                      autocomplete="off"
                      spellcheck="false"
                      data-testid="package-folder"
                      [value]="state().folder"
                      (input)="typeFolder($any($event.target).value)"
                      (keydown.enter)="next()"
                    />
                    <div class="hint">
                      {{ 'settings.addPackageWizard.aFolderWithAPackageJsonThat' | transloco }}
                    </div>
                  </div>
                }
              }
            </div>
          } @else {
            <div class="wstep" [class.back]="state().direction === 'back'" data-wstep="confirm">
              @if (loading()) {
                <div class="py-6 grid place-items-center">
                  <span
                    class="loading loading-dots loading-sm text-primary"
                    [attr.aria-label]="'settings.addPackageWizard.readingThePackage' | transloco"
                  ></span>
                </div>
              } @else if (loadError(); as text) {
                <p class="text-sm text-error break-words m-0" role="alert" data-testid="detail-error">{{ text }}</p>
              } @else if (info(); as d) {
                <div>
                  <div class="lbl" data-testid="detail-title">
                    {{ d.name }}
                    @if (d.version) {
                      <span class="mono"> {{ d.version }}</span>
                    }
                  </div>
                  <div class="hint">{{ byline(d) }}</div>
                </div>
                <div class="box">
                  <div class="t-sm">{{ 'settings.addPackageWizard.whatItAdds' | transloco }}</div>
                  <dl class="kv" data-testid="package-adds">
                    @if (d.brings) {
                      @for (k of kinds; track k) {
                        @if (d.brings[k] > 0) {
                          <dt>{{ kindLabel[k] }}</dt>
                          <dd>{{ names(d, k) }}</dd>
                        }
                      }
                      @if (d.brings.extensions + d.brings.skills + d.brings.prompts + d.brings.themes === 0) {
                        <dt>{{ 'settings.addPackageWizard.nothing' | transloco }}</dt>
                        <dd>{{ 'settings.addPackageWizard.piWouldLoadNoExtensionSkillPrompt' | transloco }}</dd>
                      }
                    } @else {
                      <dt>{{ 'settings.addPackageWizard.contents' | transloco }}</dt>
                      <dd>{{ 'settings.addPackageWizard.knownAfterTheInstall' | transloco }}</dd>
                    }
                    <dt>{{ 'settings.addPackageWizard.willRun' | transloco }}</dt>
                    <dd>
                      <span class="mono" data-testid="package-command">{{ command() }}</span
                      >{{ 'settings.addPackageWizard.thenReloadTheOpenThreads' | transloco }}
                    </dd>
                  </dl>
                </div>
                @for (note of d.notes; track $index) {
                  <div class="hint">{{ note }}</div>
                }
                @if (d.readme) {
                  <div
                    class="box"
                    style="max-height: 160px; overflow: auto"
                    tabindex="0"
                    [attr.aria-label]="'settings.addPackageWizard.rEADME' | transloco"
                    data-testid="package-readme"
                  >
                    <div class="t-sm muted">{{ 'settings.addPackageWizard.rEADME' | transloco }}</div>
                    <pre class="t-sm m-0 whitespace-pre-wrap break-words" style="font-family: inherit">{{
                      d.readme
                    }}</pre>
                  </div>
                }
                <label class="flex items-center gap-3 t-sm">
                  <input
                    type="checkbox"
                    class="toggle toggle-sm toggle-primary"
                    data-testid="every-project"
                    [checked]="state().everyProject"
                    (change)="setEveryProject($any($event.target).checked)"
                  />
                  {{ 'settings.addPackageWizard.enableForEveryProject' | transloco }}
                </label>
                @if (!state().everyProject) {
                  <div class="hint">
                    {{ 'settings.addPackageWizard.onlyThisProjectPiWritesThePackage' | transloco }}
                  </div>
                }
                @if (d.installed) {
                  <div class="hint" role="status">
                    {{ 'settings.addPackageWizard.itIsInstalledAlreadyInstallingItAgain' | transloco }}
                  </div>
                }
              }
              @if (error(); as text) {
                <div class="text-sm text-error break-words" role="alert" data-testid="install-error">{{ text }}</div>
              }
            </div>
          }
        </div>

        <div class="foot">
          @if (state().step === 'confirm') {
            <button
              type="button"
              class="btn btn-sm btn-ghost"
              data-testid="wizard-back"
              [disabled]="installing()"
              (click)="back()"
            >
              {{ 'settings.addPackageWizard.back' | transloco }}
            </button>
          }
          <span class="hint">{{ hint() }}</span>
          <span class="ml-auto flex items-center gap-2">
            <button type="button" class="btn btn-sm btn-ghost" (click)="close()">
              {{ 'settings.addPackageWizard.cancel' | transloco }}
            </button>
            <button
              type="button"
              class="btn btn-sm btn-primary"
              data-testid="package-primary"
              [disabled]="!enabled()"
              (click)="next()"
            >
              @if (installing()) {
                <span class="loading loading-spinner loading-xs"></span>
              }
              {{ primary() }}
            </button>
          </span>
        </div>
      </div>
    </div>
  `,
})
export class AddPackageWizard implements OnInit {
  protected readonly i18n = inject(Language);
  protected readonly store = inject(PackagesStore);
  private readonly win = viewChild<ElementRef<HTMLElement>>('win');
  readonly closed = output<void>();

  protected get tabs(): { id: packages.PackageTab; label: string }[] {
    return [
      { id: 'browse', label: this.i18n.t('settings.addPackageWizard.browse') },
      { id: 'git', label: this.i18n.t('settings.addPackageWizard.fromGit') },
      { id: 'folder', label: this.i18n.t('settings.addPackageWizard.fromAFolder') },
    ];
  }
  protected readonly kinds = PACKAGE_KINDS;
  protected get kindLabel() {
    return kindLabels(this.i18n.t);
  }
  protected readonly state = signal<packages.AddPackageState>(packages.startAddPackage());
  protected readonly response = signal<{ results: PackageSearchResult[]; total: number; error?: string } | undefined>(
    undefined,
  );
  protected readonly searching = signal(false);
  protected readonly info = signal<PackageDetail | undefined>(undefined);
  protected readonly loading = signal(false);
  protected readonly loadError = signal('');
  protected readonly error = signal('');

  protected readonly results = computed(() => this.response()?.results ?? []);
  protected readonly searchError = computed(() => this.response()?.error);
  protected readonly installing = computed(() => this.store.busy().has('+'));
  protected readonly command = computed(() => packages.commandOf(this.state(), this.info()));
  protected readonly hint = computed(() => packages.footHint.bind(undefined, this.i18n.t)(this.state()));
  protected readonly primary = computed(() =>
    this.installing()
      ? this.i18n.t('settings.addPackageWizard.installing')
      : packages.primaryText.bind(undefined, this.i18n.t)(this.state()),
  );
  protected readonly enabled = computed(() => {
    const s = this.state();
    if (this.installing()) return false;
    if (s.step === 'confirm') return !this.loading() && !this.loadError() && !!this.info() && !this.info()?.installed;
    return packages.canContinue(s);
  });
  protected readonly browseHint = computed(() => {
    const total = this.response()?.total;
    const found = this.results().length;
    const base = this.i18n.t('settings.addPackageWizard.piPackagesOnNpmKeywordPiPackage');
    return total === undefined
      ? base
      : `${base} ${found} ${found === 1 ? 'result' : 'results'}${total > found ? this.i18n.t('settings.addPackageWizard.of', { value1: total }) : ''}.`;
  });

  private timer: ReturnType<typeof setTimeout> | undefined;
  private sequence = 0;

  private readonly injector = inject(Injector);

  constructor() {
    inject(DestroyRef).onDestroy(() => clearTimeout(this.timer));
    // A button that is disabled or replaced (Continue while the detail loads, Install while it runs) takes the focus with it; Escape must still find this dialog.
    effect(() => {
      this.state();
      this.loading();
      this.installing();
      this.info();
      untracked(() => keepFocusInside(this.injector, () => this.win()?.nativeElement));
    });
  }

  ngOnInit(): void {
    queueMicrotask(() => this.win()?.nativeElement.focus());
    void this.runSearch();
  }

  protected setTab(tab: packages.PackageTab): void {
    this.state.set(packages.setTab(this.state(), tab));
    this.error.set('');
    if (tab === 'browse' && !this.response()) void this.runSearch();
  }
  protected search(query: string): void {
    this.state.update((s) => ({ ...s, query }));
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.runSearch(), SEARCH_DELAY_MS);
  }
  protected setKind(kind: PackageSearchKind): void {
    this.state.update((s) => ({ ...s, kind }));
    void this.runSearch();
  }
  protected typeGit(git: string): void {
    this.state.update((s) => ({ ...s, git }));
  }
  protected typeFolder(folder: string): void {
    this.state.update((s) => ({ ...s, folder }));
  }
  protected setEveryProject(everyProject: boolean): void {
    this.state.update((s) => ({ ...s, everyProject }));
  }

  private async runSearch(): Promise<void> {
    const mine = ++this.sequence;
    this.searching.set(true);
    const { query, kind } = this.state();
    try {
      const response = await this.store.search(query, kind);
      if (mine === this.sequence) this.response.set(response);
    } catch (e) {
      if (mine === this.sequence) this.response.set({ results: [], total: 0, error: errorMessage(e) });
    } finally {
      if (mine === this.sequence) this.searching.set(false);
    }
  }

  protected pick(result: PackageSearchResult): void {
    this.state.set(packages.pickResult(this.state(), result));
    void this.loadDetail();
  }

  protected next(): void {
    if (!this.enabled()) return;
    const s = this.state();
    if (s.step === 'pick') {
      const git = s.tab === 'git' ? packages.gitSource(s.git) : undefined;
      this.state.set(packages.continueTyped(git ? { ...s, git } : s));
      void this.loadDetail();
    } else void this.install();
  }

  protected back(): void {
    this.state.set(packages.backToPick(this.state()));
    this.error.set('');
  }

  private async loadDetail(): Promise<void> {
    this.info.set(undefined);
    this.loadError.set('');
    this.error.set('');
    this.loading.set(true);
    const source = this.state().source;
    try {
      const detail = await this.store.detail(source);
      if (this.state().source === source) this.info.set(detail);
    } catch (e) {
      if (this.state().source === source) this.loadError.set(errorMessage(e));
    } finally {
      this.loading.set(false);
    }
  }

  private async install(): Promise<void> {
    const s = this.state();
    this.error.set('');
    const result = await this.store.install({
      source: this.info()?.source ?? s.source,
      scope: s.everyProject ? 'user' : 'project',
    });
    if (result.ok) this.closed.emit();
    else this.error.set(result.error);
  }

  protected detail(result: PackageSearchResult): string {
    return packages.resultDetail.bind(undefined, this.i18n.t)(result);
  }

  protected names(d: PackageDetail, kind: PackageKind): string {
    const brings = d.brings;
    if (!brings) return '';
    const shown = brings.names[kind];
    const rest = brings[kind] - shown.length;
    if (shown.length === 0) return String(brings[kind]);
    return `${shown.join(', ')}${rest > 0 ? this.i18n.t('settings.addPackageWizard.andMore', { value1: rest }) : ''}`;
  }

  protected byline(d: PackageDetail): string {
    return [
      d.author ? this.i18n.t('settings.addPackageWizard.by', { value1: d.author }) : undefined,
      d.repository,
      d.license,
      d.downloads !== undefined
        ? this.i18n.t('settings.addPackageWizard.downloads', { value1: packages.downloadsText(d.downloads) })
        : undefined,
      this.state().picked?.downloads !== undefined && d.downloads === undefined
        ? this.i18n.t('settings.addPackageWizard.downloads', {
            value1: packages.downloadsText(this.state().picked?.downloads ?? 0),
          })
        : undefined,
    ]
      .filter(Boolean)
      .join(' · ');
  }

  protected close(): void {
    this.store.closeWizard();
    this.closed.emit();
  }
}
