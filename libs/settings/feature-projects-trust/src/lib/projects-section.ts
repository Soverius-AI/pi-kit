import type { Translate } from '@pi-kit/i18n';
import { Language } from '@pi-kit/i18n';
import { TranslocoPipe } from '@pi-kit/i18n';
import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import type { ProjectScores } from '@pi-kit/protocol';
import { PkIcon, PkItem, PkScoreHistogram, PkScrollArea, PkTabPanel, PkTabs, PkTip } from '@pi-kit/design-system';
import { settingsCatalog } from '@pi-kit/ui';
import { ScoreStore, ThreadsStore } from '@pi-kit/threads/api';
import { PkSetting } from '@pi-kit/settings/api';
import { ProjectPageStore, SettingsStore } from '@pi-kit/settings/data';
import {
  defaultStartOptions,
  dropBefore,
  neighbour,
  projectRows,
  tildePath,
  worktreeCounts,
  type ProjectRow,
} from '@pi-kit/settings/util';
import { ProjectPage } from './project-page';

/** The ids of the settings that live on a project's own page: a search that finds only these sends the person to a project. */
const projectSettingIds = (translate: Translate) =>
  settingsCatalog(translate)
    .filter((e) => e.section === 'projects' && e.id.startsWith('project-') && e.id !== 'projects-list')
    .map((e) => e.id);

/**
 * Settings › Projects: the projects as `pk-item` rows (folder tile, name with its trust and branch chips, path, thread and
 * worktree counts, where a new thread starts, the setup script) that open the project's page with a chevron, can be dragged to order the sidebar, and show a hidden project
 * quieter. The amber “+” adds a folder (the desktop app's picker; a browser types the path). Under the list, “Defaults for every project”: trust for new folders, the worktree
 * folder and where new threads start; a project overrides each on its own page (`pk-project-page`, which slides in over this list).
 */
@Component({
  selector: 'pk-projects-section',
  imports: [
    PkItem,
    PkScoreHistogram,
    PkSetting,
    PkTip,
    PkTabs,
    PkTabPanel,
    PkScrollArea,
    ProjectPage,
    TranslocoPipe,
    PkIcon,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="flex flex-col gap-5" data-testid="section-projects">
      @if (store.project() && !store.searching()) {
        <pk-project-page />
      } @else {
        <pk-tabs [label]="'settings.projectsSection.projects' | transloco" [(value)]="tab">
          @if (store.shows('projects-list', ...pageIds)) {
            <pk-tab-panel value="folders" [label]="'settings.sectionTabs.folders' | transloco">
              <section
                class="pk-group"
                [attr.aria-label]="'settings.projectsSection.projects' | transloco"
                data-testid="projects-list"
                [class.pk-back-in]="cameBack()"
              >
                <header>
                  <div>
                    <h4>{{ 'settings.projectsSection.projects' | transloco }}</h4>
                    <p>
                      {{
                        onlyPageHits()
                          ? ('settings.projectsSection.whatYouSearchedForIsOnA' | transloco)
                          : ('settings.projectsSection.dragToOrderTheSidebarOpenA' | transloco)
                      }}
                    </p>
                  </div>
                  <span class="chip store" [pkTip]="'settings.projectsSection.storedInPiKitSOwnDatabase' | transloco">{{
                    'settings.projectsSection.piKitDatabase' | transloco
                  }}</span>
                  <button
                    type="button"
                    class="btn btn-sm btn-primary btn-square add"
                    [pkTip]="'settings.projectsSection.addAFolder' | transloco"
                    [attr.aria-label]="'settings.projectsSection.addAFolder' | transloco"
                    data-testid="add-project"
                    (click)="add()"
                  >
                    <pk-icon name="plus" size="16" />
                  </button>
                </header>
                @if (adding()) {
                  <form
                    class="row pk-expand"
                    data-testid="add-project-form"
                    (submit)="$event.preventDefault(); submitPath()"
                  >
                    <div class="min-w-0">
                      <label class="lbl" for="add-project-path">{{
                        'settings.projectsSection.folderToAdd' | transloco
                      }}</label>
                      <div class="hint">{{ 'settings.projectsSection.theFolderPickerIsInTheDesktop' | transloco }}</div>
                    </div>
                    <div class="ctl ctl-w">
                      <input
                        id="add-project-path"
                        class="input input-sm mono"
                        type="text"
                        spellcheck="false"
                        autocomplete="off"
                        [placeholder]="'settings.projectsSection.absolutePathToTheFolder' | transloco"
                        data-testid="add-project-path"
                        [value]="path()"
                        (input)="path.set($any($event.target).value)"
                      />
                      <button
                        type="submit"
                        class="btn btn-sm btn-primary"
                        data-testid="add-project-submit"
                        [disabled]="!path().trim()"
                      >
                        {{ 'settings.projectsSection.add' | transloco }}
                      </button>
                    </div>
                  </form>
                }
                <pk-scroll-area class="pk-scroll-area-flush" [label]="'settings.projectsSection.projects' | transloco">
                  <div role="list" [attr.aria-label]="'settings.projectsSection.projects' | transloco">
                    @for (row of rows(); track row.cwd) {
                      <div
                        pkItem
                        class="open"
                        role="listitem"
                        draggable="true"
                        [dimmed]="row.hidden"
                        [class.dragging]="dragFrom() === row.cwd"
                        [class.over]="overCwd() === row.cwd && dragFrom() !== row.cwd"
                        [attr.data-project]="row.name"
                        [attr.data-testid]="'project-' + row.name"
                        (click)="open(row)"
                        (keydown.enter)="open(row)"
                        (dragstart)="dragStart($event, row.cwd)"
                        (dragover)="dragOver($event, row.cwd)"
                        (drop)="drop($event, row.cwd)"
                        (dragend)="dragEnd()"
                      >
                        <pk-icon name="folder" tile />
                        <ng-container nm>
                          {{ row.name }}
                          @if (row.trust; as trust) {
                            <span class="chip" [class]="trust.tone" data-testid="project-trust-chip">{{
                              trust.text
                            }}</span>
                          }
                          @if (row.branch) {
                            <span class="chip off">{{ row.branch }}</span>
                          } @else if (!row.git) {
                            <span class="chip off">{{ 'settings.projectsSection.notGit' | transloco }}</span>
                          }
                          @if (row.hidden) {
                            <span class="chip off">{{ 'settings.projectsSection.hidden' | transloco }}</span>
                          }
                        </ng-container>
                        <ng-container ds>
                          <span class="mono" [pkTip]="row.cwd">{{ row.path }}</span>
                          @for (fact of row.facts; track fact) {
                            <span>· {{ fact }}</span>
                          }
                        </ng-container>
                        <ng-container act>
                          <pk-icon name="grip" class="grip" />
                          <button
                            type="button"
                            class="btn btn-sm btn-ghost btn-square"
                            [pkTip]="'settings.projectsSection.openAltOrAltMovesIt' | transloco"
                            [attr.aria-label]="('settings.projectsSection.open' | transloco) + row.name"
                            aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
                            [attr.data-testid]="'open-project-' + row.name"
                            (keydown.alt.arrowup)="step($event, row.cwd, -1)"
                            (keydown.alt.arrowdown)="step($event, row.cwd, 1)"
                          >
                            <pk-icon name="chevron-right" class="chev" />
                          </button>
                        </ng-container>
                      </div>
                    } @empty {
                      <div class="empty" data-testid="projects-empty">
                        <span>{{ 'settings.projectsSection.noFolderIsOpenYetAddOne' | transloco }}</span>
                        <button type="button" class="btn btn-sm btn-primary" (click)="add()">
                          {{ 'settings.projectsSection.addAFolder' | transloco }}
                        </button>
                      </div>
                    }
                  </div>
                </pk-scroll-area>
              </section>
            </pk-tab-panel>
          }
          @if (
            store.shows('default-trust', 'default-worktree-root', 'default-start') && store.settings();
            as settings
          ) {
            <pk-tab-panel value="defaults" [label]="'settings.sectionTabs.defaults' | transloco">
              <section
                class="pk-group"
                [attr.aria-label]="'settings.projectsSection.defaultsForEveryProject' | transloco"
                data-testid="project-defaults"
              >
                <header>
                  <div>
                    <h4>{{ 'settings.projectsSection.defaultsForEveryProject' | transloco }}</h4>
                    <p>{{ 'settings.projectsSection.aProjectCanOverrideEachOfThese' | transloco }}</p>
                  </div>
                </header>
                <div pkSetting="default-trust">
                  <select
                    class="select select-sm"
                    aria-labelledby="lbl-default-trust"
                    data-testid="default-trust"
                    (change)="store.patch({ defaultProjectTrust: $any($event.target).value })"
                  >
                    <option value="ask" [selected]="settings.defaultProjectTrust === 'ask'">
                      {{ 'settings.projectsSection.askMeRecommended' | transloco }}
                    </option>
                    <option value="always" [selected]="settings.defaultProjectTrust === 'always'">
                      {{ 'settings.projectsSection.alwaysRunProjectResources' | transloco }}
                    </option>
                    <option value="never" [selected]="settings.defaultProjectTrust === 'never'">
                      {{ 'settings.projectsSection.never' | transloco }}
                    </option>
                  </select>
                </div>
                <div pkSetting="default-worktree-root">
                  <input
                    class="input input-sm mono"
                    type="text"
                    spellcheck="false"
                    aria-labelledby="lbl-default-worktree-root"
                    data-testid="default-worktree-root"
                    [placeholder]="tilde(page.defaults()?.defaultRoot ?? '~/.pi-kit/worktrees')"
                    [value]="page.defaults()?.root ?? ''"
                    [disabled]="!page.defaults()"
                    (change)="page.saveDefaults({ root: $any($event.target).value })"
                  />
                </div>
                <div pkSetting="default-start">
                  <select
                    class="select select-sm"
                    aria-labelledby="lbl-default-start"
                    data-testid="default-start"
                    [disabled]="!page.defaults()"
                    (change)="page.saveDefaults({ start: $any($event.target).value })"
                  >
                    @for (option of startOptions; track option.value) {
                      <option [value]="option.value" [selected]="page.defaults()?.start === option.value">
                        {{ option.label }}
                      </option>
                    }
                  </select>
                </div>
              </section>
            </pk-tab-panel>
          }
          @if (store.shows('score-histogram') && score.overview()?.installed) {
            <pk-tab-panel value="scores" [label]="'settings.sectionTabs.scores' | transloco">
              <section
                class="pk-group"
                [attr.aria-label]="'settings.projectsSection.steeredOrVibed' | transloco"
                data-testid="score-histograms"
              >
                <header>
                  <div>
                    <h4>{{ 'settings.projectsSection.steeredOrVibed' | transloco }}</h4>
                    <p>
                      {{ 'settings.projectsSection.howMuchOfEachFinishedThreadS' | transloco }}
                      <code>&#64;pi-kit/meat-proxy</code
                      >{{ 'settings.projectsSection.itDescribesThreadsItRanksNothing' | transloco }}
                    </p>
                  </div>
                </header>
                @for (workspace of store.workspaces(); track workspace.cwd) {
                  @if (scoresOf(workspace.cwd); as scores) {
                    <div class="row" [attr.data-testid]="'score-' + workspace.name">
                      <div class="min-w-0">
                        <div class="lbl">
                          {{ workspace.name }}
                          <span class="chip off">{{
                            'settings.projectsSection.scored' | transloco: { value1: scores.scored }
                          }}</span>
                        </div>
                        <pk-score-histogram
                          class="mt-2"
                          [bins]="scores.bins"
                          [mean]="scores.mean"
                          [scored]="scores.scored"
                          [recent]="scores.recent"
                        />
                      </div>
                    </div>
                  }
                } @empty {
                  <div class="row">
                    <div class="hint">{{ 'settings.projectsSection.noFolderIsOpenYet' | transloco }}</div>
                  </div>
                }
                @if (!hasScores()) {
                  <div class="row">
                    <div class="hint" data-testid="score-none">
                      {{ 'settings.projectsSection.noThreadHasBeenScoredYetScore' | transloco }}
                    </div>
                  </div>
                }
              </section>
            </pk-tab-panel>
          }
        </pk-tabs>
      }
    </div>
  `,
})
export class ProjectsSection {
  protected readonly tab = signal('folders');
  protected readonly i18n = inject(Language);
  protected readonly store = inject(SettingsStore);
  protected readonly page = inject(ProjectPageStore);
  private readonly threads = inject(ThreadsStore);
  protected readonly score = inject(ScoreStore);

  protected get pageIds() {
    return projectSettingIds(this.i18n.t);
  }
  protected get startOptions() {
    return defaultStartOptions(this.i18n.t);
  }
  protected readonly tilde = tildePath;
  protected readonly adding = signal(false);
  protected readonly path = signal('');
  protected readonly dragFrom = signal<string | undefined>(undefined);
  protected readonly overCwd = signal<string | undefined>(undefined);
  /** The list came back from a project's page: it fades in as a section does (the first showing is the section's own motion). */
  protected readonly cameBack = signal(false);
  private lastOpened: string | undefined;

  protected readonly rows = computed<ProjectRow[]>(() =>
    projectRows(this.i18n.t, this.store.workspaces(), this.store.folders(), worktreeCounts(this.threads.threads())),
  );
  /** The search matched settings of a project's page and nothing the list itself shows. */
  protected readonly onlyPageHits = computed(
    () =>
      this.store.searching() &&
      !this.store.shows('projects-list') &&
      this.store.shows(...projectSettingIds(this.i18n.t)),
  );

  constructor() {
    void this.score.loadOverview();
    void this.page.loadDefaults();
    // Back from a project's page: the list returns and the focus goes to the project that was open.
    effect(() => {
      const open = this.store.project();
      untracked(() => {
        if (open) this.lastOpened = this.rows().find((r) => r.cwd === open)?.name;
        else if (this.lastOpened) {
          const name = this.lastOpened;
          this.lastOpened = undefined;
          this.cameBack.set(true);
          setTimeout(() =>
            Array.from(document.querySelectorAll<HTMLElement>('[data-testid^="open-project-"]'))
              .find((b) => b.dataset['testid'] === `open-project-${name}`)
              ?.focus({ preventScroll: true }),
          );
        }
      });
    });
  }

  /** The distribution of a project's scored threads, if any thread of it was scored. */
  protected scoresOf(cwd: string): ProjectScores | undefined {
    return this.score.overview()?.projects.find((p) => p.cwd === cwd && p.scored > 0);
  }

  protected hasScores(): boolean {
    return (this.score.overview()?.projects ?? []).some(
      (p) => p.scored > 0 && this.store.workspaces().some((w) => w.cwd === p.cwd),
    );
  }

  protected open(row: ProjectRow): void {
    this.cameBack.set(false);
    this.store.openProject(row.cwd);
  }

  // ---- add a folder

  /** The desktop app's folder picker; a browser has none, so the group asks for the path (development, the end-to-end tests). */
  protected async add(): Promise<void> {
    const picker = window.piKit?.showOpenDialog;
    if (!picker) {
      this.adding.update((open) => !open);
      return;
    }
    const picked = await picker();
    if (picked) await this.addPath(picked);
  }

  protected async submitPath(): Promise<void> {
    const path = this.path().trim();
    if (!path) return;
    if (await this.addPath(path)) {
      this.path.set('');
      this.adding.set(false);
    }
  }

  private async addPath(path: string): Promise<boolean> {
    const done = await this.store.save(async () => {
      await this.threads.openWorkspace(path);
      return true;
    }, this.i18n.t('settings.projectsSection.couldNotAddTheFolder'));
    return done === true;
  }

  // ---- order

  protected dragStart(event: DragEvent, cwd: string): void {
    this.dragFrom.set(cwd);
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', cwd);
    }
  }

  protected dragOver(event: DragEvent, cwd: string): void {
    if (this.dragFrom() === undefined) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    this.overCwd.set(cwd);
  }

  protected drop(event: DragEvent, cwd: string): void {
    event.preventDefault();
    const from = this.dragFrom();
    this.dragEnd();
    if (!from) return;
    const move = dropBefore(
      this.store.workspaces().map((w) => w.cwd),
      from,
      cwd,
    );
    if (move)
      void this.store.save(
        () => this.threads.moveProject(from, move.before),
        this.i18n.t('settings.projectsSection.couldNotMoveTheProject'),
      );
  }

  protected dragEnd(): void {
    this.dragFrom.set(undefined);
    this.overCwd.set(undefined);
  }

  /** Alt+↑ / Alt+↓ on a row's button: one place up or down, for the keyboard. */
  protected step(event: Event, cwd: string, offset: -1 | 1): void {
    event.preventDefault();
    event.stopPropagation();
    const move = neighbour(
      this.store.workspaces().map((w) => w.cwd),
      cwd,
      offset,
    );
    if (move)
      void this.store.save(
        () => this.threads.moveProject(cwd, move.before),
        this.i18n.t('settings.projectsSection.couldNotMoveTheProject'),
      );
  }
}
