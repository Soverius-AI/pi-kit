import { Language } from '@pi-kit/i18n';
import { TranslocoPipe } from '@pi-kit/i18n';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterNextRender,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import type { CarryChanges, RemoveFolder, StartMode } from '@pi-kit/protocol';
import { PkIcon, PkTip } from '@pi-kit/design-system';
import { ProjectPageStore, SettingsStore } from '@pi-kit/settings/data';
import {
  carryOptions,
  removeOptions,
  startOptions,
  plural,
  resourceSummary,
  tildePath,
  trustChip,
  trustSourceText,
} from '@pi-kit/settings/util';
import { OpenWorktrees } from './open-worktrees';
import { SetupScripts } from './setup-scripts';

/** Milliseconds the page takes to slide out (doc/docs/design-system.md “Motion”: the detail page, 160ms). */
const SLIDE_OUT_MS = 150;

/**
 * A project's page: it slides in over the list with the breadcrumb “Projects › name”, and Back (the breadcrumb, or Esc)
 * slides it out. Groups: Trust, New threads, Worktrees, Setup scripts, Open worktrees, Sidebar. Every row is in the control column (`ctl ctl-w`); a text field saves when it
 * loses the focus, a select or a switch at once, and only what changed is sent (`ProjectPageStore.save`). A folder that is not a git repository has the Trust and Sidebar groups
 * and a line saying why the rest is missing.
 */
@Component({
  selector: 'pk-project-page',
  imports: [OpenWorktrees, PkTip, SetupScripts, TranslocoPipe, PkIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (page.workspace(); as workspace) {
      <div
        class="pk-detail"
        [class.leaving]="leaving()"
        data-testid="project-page"
        [attr.data-project]="workspace.name"
      >
        <div class="pk-path" role="navigation" [attr.aria-label]="'settings.projectPage.breadcrumb' | transloco">
          <button type="button" data-testid="project-back" (click)="back()">
            {{ 'settings.projectPage.projects' | transloco }}
          </button>
          <pk-icon name="chevron-right" />
          <span aria-current="page">{{ workspace.name }}</span>
        </div>
        <div class="intro">
          <h3 #heading tabindex="-1">{{ workspace.name }}</h3>
          <p class="mono break-all" [pkTip]="workspace.cwd">{{ path(workspace.cwd) }}</p>
          @if (chip(); as c) {
            <span class="chip" [class]="c.tone" data-testid="project-trust-chip">{{ c.text }}</span>
          }
          @if (workspace.branch) {
            <span class="chip off">{{ workspace.branch }}</span>
          }
        </div>

        <section
          class="pk-group"
          [attr.aria-label]="'settings.projectPage.trust' | transloco"
          data-testid="project-trust"
        >
          <header>
            <div>
              <h4>{{ 'settings.projectPage.trust' | transloco }}</h4>
              <p>{{ 'settings.projectPage.whetherThisFolderSOwnExtensionsSkills' | transloco }}</p>
            </div>
            <span class="chip store" [pkTip]="'settings.projectPage.decisionsAreSavedInPiSTrust' | transloco">{{
              'settings.projectPage.piTrustJson' | transloco
            }}</span>
          </header>
          <div class="row">
            <div class="min-w-0">
              <div class="lbl" id="lbl-project-trust">{{ 'settings.projectPage.runProjectResources' | transloco }}</div>
              <div class="hint" data-testid="project-trust-hint">{{ trustHint() }}</div>
            </div>
            <div class="ctl ctl-w">
              @if (page.trust()?.hasResources) {
                <button
                  type="button"
                  class="btn btn-sm btn-ghost"
                  data-testid="project-review"
                  (click)="store.reviewFolder(workspace.cwd)"
                >
                  {{ 'settings.projectPage.reviewResources' | transloco }}
                </button>
              }
              <input
                type="checkbox"
                class="toggle toggle-primary"
                aria-labelledby="lbl-project-trust"
                data-testid="project-trusted"
                [disabled]="!page.trust()?.hasResources"
                [checked]="page.trust()?.status === 'trusted'"
                (change)="page.setTrusted($any($event.target).checked)"
              />
            </div>
          </div>
        </section>

        @if (workspace.worktree; as wt) {
          @if (wt.git) {
            <section
              class="pk-group"
              [attr.aria-label]="'settings.projectPage.newThreads' | transloco"
              data-testid="project-new-threads"
            >
              <header>
                <div>
                  <h4>{{ 'settings.projectPage.newThreads' | transloco }}</h4>
                  <p>{{ 'settings.projectPage.whatTheWhereRowOffersFirstFor' | transloco }}</p>
                </div>
                <span class="chip store" [pkTip]="'settings.projectPage.storedInPiKitSOwnDatabase' | transloco">{{
                  'settings.projectPage.piKitDatabase' | transloco
                }}</span>
              </header>
              <div class="row">
                <div class="min-w-0">
                  <div class="lbl" id="lbl-project-start">{{ 'settings.projectPage.start' | transloco }}</div>
                  <div class="hint">
                    {{ 'settings.projectPage.localWorksInTheFolderOnIts' | transloco }}
                  </div>
                </div>
                <div class="ctl ctl-w">
                  <div class="pk-seg" role="radiogroup" aria-labelledby="lbl-project-start" data-testid="project-start">
                    @for (option of startOptions; track option.value) {
                      <input
                        type="radio"
                        name="project-start"
                        [attr.aria-label]="option.label"
                        [attr.data-testid]="'project-start-' + option.value"
                        [checked]="wt.start === option.value"
                        (change)="page.save({ start: option.value })"
                      />
                    }
                  </div>
                </div>
              </div>
              <div class="row">
                <div class="min-w-0">
                  <div class="lbl" id="lbl-project-switch">
                    {{ 'settings.projectPage.localSwitchingBranches' | transloco }}
                  </div>
                  <div class="hint">
                    {{ 'settings.projectPage.letANewLocalThreadCheckOut' | transloco }}
                  </div>
                </div>
                <div class="ctl ctl-w">
                  <input
                    type="checkbox"
                    class="toggle toggle-primary"
                    aria-labelledby="lbl-project-switch"
                    data-testid="project-switch"
                    [checked]="wt.allowBranchSwitch"
                    (change)="page.save({ allowBranchSwitch: $any($event.target).checked })"
                  />
                </div>
              </div>
            </section>

            <section
              class="pk-group"
              [attr.aria-label]="'settings.projectPage.worktrees' | transloco"
              data-testid="project-worktrees"
            >
              <header>
                <div>
                  <h4>{{ 'settings.projectPage.worktrees' | transloco }}</h4>
                  <p>{{ 'settings.projectPage.howAWorktreeThreadMakesItsCheckout' | transloco }}</p>
                </div>
                <span class="chip store" [pkTip]="'settings.projectPage.storedInPiKitSOwnDatabase' | transloco">{{
                  'settings.projectPage.piKitDatabase' | transloco
                }}</span>
              </header>
              <div class="row">
                <div class="min-w-0">
                  <div class="lbl" id="lbl-project-root">{{ 'settings.projectPage.folder' | transloco }}</div>
                  <div class="hint">
                    {{ 'settings.projectPage.oneSubfolderPerThreadBlankUses' | transloco }}
                    <span class="mono">{{ path(wt.defaultRoot) }}</span
                    >.
                  </div>
                </div>
                <div class="ctl ctl-w">
                  <input
                    class="input input-sm mono"
                    type="text"
                    spellcheck="false"
                    aria-labelledby="lbl-project-root"
                    data-testid="project-root"
                    [placeholder]="path(wt.defaultRoot)"
                    [value]="wt.root ?? ''"
                    (change)="page.save({ root: $any($event.target).value })"
                  />
                </div>
              </div>
              <div class="row">
                <div class="min-w-0">
                  <div class="lbl" id="lbl-project-base">{{ 'settings.projectPage.cutFrom' | transloco }}</div>
                  <div class="hint">
                    {{ 'settings.projectPage.theBaseANewWorktreeStartsFrom' | transloco }}
                  </div>
                </div>
                <div class="ctl ctl-w">
                  <select
                    class="select select-sm mono"
                    aria-labelledby="lbl-project-base"
                    data-testid="project-base"
                    (change)="page.save({ base: $any($event.target).value || null })"
                  >
                    @for (option of page.baseOptions(); track option.value) {
                      <option [value]="option.value" [selected]="option.value === (wt.base ?? '')">
                        {{ option.label }}
                      </option>
                    }
                  </select>
                </div>
              </div>
              <div class="row">
                <div class="min-w-0">
                  <div class="lbl" id="lbl-project-carry">
                    {{ 'settings.projectPage.carryUncommittedChanges' | transloco }}
                  </div>
                  <div class="hint">
                    {{ 'settings.projectPage.applyTheFolderSStagedAndUnstaged' | transloco }}
                  </div>
                </div>
                <div class="ctl ctl-w">
                  <select
                    class="select select-sm"
                    aria-labelledby="lbl-project-carry"
                    data-testid="project-carry"
                    (change)="page.save({ carryChanges: $any($event.target).value })"
                  >
                    @for (option of carryOptions; track option.value) {
                      <option [value]="option.value" [selected]="wt.carryChanges === option.value">
                        {{ option.label }}
                      </option>
                    }
                  </select>
                </div>
              </div>
              <div class="row">
                <div class="min-w-0">
                  <div class="lbl" id="lbl-project-branch">{{ 'settings.projectPage.branch' | transloco }}</div>
                  <div class="hint">
                    {{ 'settings.projectPage.namedFromTheThreadWithAPrefix' | transloco }}
                  </div>
                </div>
                <div class="ctl ctl-w">
                  <select
                    class="select select-sm"
                    aria-labelledby="lbl-project-branch"
                    data-testid="project-branch"
                    (change)="page.save({ branchMode: $any($event.target).value })"
                  >
                    <option value="named" [selected]="wt.branchMode === 'named'">
                      {{ 'settings.projectPage.namedWithAPrefix' | transloco }}
                    </option>
                    <option value="detached" [selected]="wt.branchMode === 'detached'">
                      {{ 'settings.projectPage.detachedCreateABranchLater' | transloco }}
                    </option>
                  </select>
                </div>
              </div>
              @if (wt.branchMode === 'named') {
                <div class="row pk-expand">
                  <div class="min-w-0">
                    <div class="lbl" id="lbl-project-prefix">{{ 'settings.projectPage.branchPrefix' | transloco }}</div>
                    <div class="hint">
                      {{ 'settings.projectPage.aWorktreeForFixLoginGets' | transloco }}
                      <span class="mono">{{
                        'settings.projectPage.fixLogin' | transloco: { value1: wt.branchPrefix }
                      }}</span
                      >.
                    </div>
                  </div>
                  <div class="ctl ctl-w">
                    <input
                      class="input input-sm mono"
                      type="text"
                      spellcheck="false"
                      aria-labelledby="lbl-project-prefix"
                      data-testid="project-prefix"
                      [placeholder]="'settings.projectPage.piKit' | transloco"
                      [value]="wt.branchPrefix"
                      (change)="page.save({ branchPrefix: $any($event.target).value })"
                    />
                  </div>
                </div>
              }
              <div class="row">
                <div class="min-w-0">
                  <div class="lbl" id="lbl-project-remove">
                    {{ 'settings.projectPage.removeTheFolder' | transloco }}
                  </div>
                  <div class="hint">{{ 'settings.projectPage.afterAMergeBackAHandOff' | transloco }}</div>
                </div>
                <div class="ctl ctl-w">
                  <select
                    class="select select-sm"
                    aria-labelledby="lbl-project-remove"
                    data-testid="project-remove"
                    (change)="page.save({ removeFolder: $any($event.target).value })"
                  >
                    @for (option of removeOptions; track option.value) {
                      <option [value]="option.value" [selected]="wt.removeFolder === option.value">
                        {{ option.label }}
                      </option>
                    }
                  </select>
                </div>
              </div>
            </section>

            <pk-setup-scripts />
            <pk-open-worktrees />
          } @else {
            <section
              class="pk-group"
              [attr.aria-label]="'settings.projectPage.newThreadsAndWorktrees' | transloco"
              data-testid="project-not-git"
            >
              <header>
                <div>
                  <h4>{{ 'settings.projectPage.newThreadsAndWorktrees' | transloco }}</h4>
                  <p>
                    {{ 'settings.projectPage.thisFolderIsNotAGitRepository' | transloco }}
                  </p>
                </div>
              </header>
            </section>
          }
        }

        <section
          class="pk-group"
          [attr.aria-label]="'settings.projectPage.sidebar' | transloco"
          data-testid="project-sidebar"
        >
          <header>
            <div>
              <h4>{{ 'settings.projectPage.sidebar' | transloco }}</h4>
            </div>
            <span class="chip store" [pkTip]="'settings.projectPage.storedInPiKitSOwnDatabase' | transloco">{{
              'settings.projectPage.piKitDatabase' | transloco
            }}</span>
          </header>
          <div class="row">
            <div class="min-w-0">
              <div class="lbl" id="lbl-project-shown">{{ 'settings.projectPage.showInTheSidebar' | transloco }}</div>
              <div class="hint">{{ 'settings.projectPage.aHiddenProjectStaysKnownTheSidebar' | transloco }}</div>
            </div>
            <div class="ctl ctl-w">
              <input
                type="checkbox"
                class="toggle toggle-primary"
                aria-labelledby="lbl-project-shown"
                data-testid="project-shown"
                [checked]="!workspace.hidden"
                (change)="page.setShown($any($event.target).checked)"
              />
            </div>
          </div>
          <div class="row">
            <div class="min-w-0">
              <div class="lbl" id="lbl-project-agents">{{ 'settings.projectPage.backgroundAgents' | transloco }}</div>
              <div class="hint">{{ 'settings.projectPage.backgroundAgentsHint' | transloco }}</div>
            </div>
            <div class="ctl ctl-w">
              <input
                type="checkbox"
                class="toggle toggle-primary"
                aria-labelledby="lbl-project-agents"
                data-testid="project-agents"
                [checked]="workspace.agents"
                (change)="page.setAgents($any($event.target).checked)"
              />
            </div>
          </div>
          <div class="row">
            <div class="min-w-0">
              <div class="lbl" id="lbl-project-forget">{{ 'settings.projectPage.forgetThisProject' | transloco }}</div>
              <div class="hint">
                {{ 'settings.projectPage.removesItFromTheSidebarAndThis' | transloco }}
              </div>
            </div>
            <div class="ctl ctl-w">
              @if (page.confirming()?.kind === 'forget') {
                <button type="button" class="btn btn-sm btn-ghost" (click)="page.cancelConfirm()">
                  {{ 'settings.projectPage.cancel' | transloco }}
                </button>
                <button type="button" class="btn btn-sm btn-error" data-testid="forget-confirm" (click)="page.forget()">
                  {{ 'settings.projectPage.forget' | transloco: { value1: workspace.name } }}
                </button>
              } @else {
                <button
                  type="button"
                  class="btn btn-sm btn-ghost"
                  aria-labelledby="lbl-project-forget"
                  data-testid="forget-project"
                  (click)="page.askForget()"
                >
                  {{ 'settings.projectPage.forgetbb1a4' | transloco }}
                </button>
              }
            </div>
          </div>
        </section>
      </div>
    } @else {
      <div class="pk-detail" data-testid="project-page-gone">
        <div class="pk-path" role="navigation" [attr.aria-label]="'settings.projectPage.breadcrumb' | transloco">
          <button type="button" data-testid="project-back" (click)="back()">
            {{ 'settings.projectPage.projects' | transloco }}
          </button>
        </div>
        <p class="muted">{{ 'settings.projectPage.thisProjectIsNotInTheList' | transloco }}</p>
      </div>
    }
  `,
})
export class ProjectPage {
  protected readonly i18n = inject(Language);
  protected readonly store = inject(SettingsStore);
  protected readonly page = inject(ProjectPageStore);

  protected get startOptions(): { value: StartMode; label: string }[] {
    return startOptions(this.i18n.t);
  }
  protected get carryOptions(): { value: CarryChanges; label: string }[] {
    return carryOptions(this.i18n.t);
  }
  protected get removeOptions(): { value: RemoveFolder; label: string }[] {
    return removeOptions(this.i18n.t);
  }
  protected readonly path = tildePath;
  protected readonly leaving = signal(false);
  private readonly heading = viewChild<ElementRef<HTMLElement>>('heading');

  constructor() {
    // The page opens with the focus on its title, so a screen reader starts there and Esc and Tab behave from it.
    afterNextRender(() => this.heading()?.nativeElement.focus({ preventScroll: true }));
  }

  protected chip(): { text: string; tone: string } | undefined {
    return trustChip(this.i18n.t, this.page.trust());
  }

  /** The line under “Run project resources”: what it would load and where the answer came from. */
  protected trustHint(): string {
    const state = this.page.trust();
    if (!state) return this.i18n.t('settings.projectPage.readingWhatThisFolderHolds');
    if (!state.hasResources) return this.i18n.t('settings.projectPage.noProjectResourcesSoThereIsNothing');
    return `${plural(this.i18n.t, state.resources.length, 'resource')}: ${resourceSummary(this.i18n.t, state)}. ${trustSourceText(this.i18n.t, state.source)[0].toUpperCase()}${trustSourceText(this.i18n.t, state.source).slice(1)}.`;
  }

  /** Back: the page slides out (160ms) and the list returns; without motion at once. */
  protected back(): void {
    const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) return this.store.closeProject();
    this.leaving.set(true);
    setTimeout(() => this.store.closeProject(), SLIDE_OUT_MS);
  }
}
