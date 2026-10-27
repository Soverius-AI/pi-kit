import { Language } from '@pi-kit/i18n';
import { TranslocoPipe } from '@pi-kit/i18n';
import { ChangeDetectionStrategy, Component, computed, effect, inject, linkedSignal } from '@angular/core';
import { errorMessage } from '@pi-kit/api';
import { ChatStore, registerInputTransform } from '@pi-kit/chat/api';
import { NewThreadStore, ThreadsStore } from '@pi-kit/threads/data';
import {
  baseOf,
  baseOptions,
  localBranchOf,
  localBranchOptions,
  whereWords,
  type WhereMode,
} from '@pi-kit/threads/util';
import { PkIcon } from '@pi-kit/design-system';

type MenuName = 'project' | 'branch' | 'from' | 'setup';

/**
 * The Where row of a new thread, directly above the message well. One grid for both modes: the top line holds the
 * project, the Local | Worktree switch, one sentence and Remember; under a hairline the three slots branch, from and setup, which both modes fill in the same places, so
 * switching changes values and never the layout. Local switches the folder's checkout (a clean tree only; a branch a worktree holds is disabled with the reason);
 * Worktree names its branch from the first message, leaves it off (detached) or takes a typed one, starts from a branch (or `origin/…` after a fetch) with or without
 * the folder's uncommitted changes, and runs one of the project's setup scripts. The row leaves with the first message: the thread's folder is fixed then.
 * What was chosen is applied by an input transform just before the first Send; a refusal keeps the draft and says why.
 */
@Component({
  imports: [TranslocoPipe, PkIcon],
  selector: 'pk-where-row',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(document:click)': 'outside($event)',
    '(document:keydown.escape)': 'open.set(undefined)',
    style: 'display: contents',
  },
  template: `
    @if (visible() && plan(); as plan) {
      <div
        class="pk-where"
        role="group"
        [attr.aria-label]="'threads.whereRow.whereTheThreadRuns' | transloco"
        data-testid="where-row"
        [attr.data-mode]="plan.mode"
      >
        <div class="top">
          <div class="anchor">
            <!-- TODO: every title= in this row (project, branch, base, carry, setup) should become the pkTip tooltip directive -->
            <button
              type="button"
              class="proj"
              [title]="'threads.whereRow.changeTheProject' | transloco"
              aria-haspopup="listbox"
              [attr.aria-expanded]="open() === 'project'"
              data-testid="where-project"
              (click)="toggle('project')"
            >
              <pk-icon name="folder" />
              <span>{{ projectName() }}</span>
              <pk-icon name="chevron-down" class="chev" />
            </button>
            @if (open() === 'project') {
              <div class="pk-where-menu" role="listbox" [attr.aria-label]="'threads.whereRow.project' | transloco">
                @for (project of projects(); track project.workspace.cwd) {
                  <button
                    type="button"
                    class="opt"
                    role="option"
                    [attr.aria-selected]="project.workspace.cwd === cwd()"
                    [attr.data-testid]="'where-project-' + project.workspace.name"
                    (click)="pickProject(project.workspace.cwd)"
                  >
                    <span>{{ project.workspace.name }}</span>
                    <span class="sub mono">{{ project.workspace.cwd }}</span>
                  </button>
                }
              </div>
            }
          </div>
          @if (repo()) {
            <div class="pk-seg seg" role="radiogroup" [attr.aria-label]="'threads.whereRow.whereItRuns' | transloco">
              <button
                type="button"
                role="radio"
                [attr.aria-checked]="plan.mode === 'local'"
                data-testid="where-local"
                (click)="setMode('local')"
              >
                <pk-icon name="folder" />{{ 'threads.whereRow.local' | transloco }}
              </button>
              <button
                type="button"
                role="radio"
                [attr.aria-checked]="plan.mode === 'worktree'"
                data-testid="where-worktree"
                (click)="setMode('worktree')"
              >
                <pk-icon name="worktree" />{{ 'threads.whereRow.worktree' | transloco }}
              </button>
            </div>
            <span class="what" data-testid="where-sentence">{{ words().sentence }}</span>
            <label class="rem t-xs muted">
              <input
                type="checkbox"
                class="checkbox checkbox-xs"
                data-testid="where-remember"
                [checked]="plan.remember"
                (change)="patch({ remember: $any($event.target).checked })"
              />{{ 'threads.whereRow.remember' | transloco }}
            </label>
          } @else {
            <span class="what" data-testid="where-sentence">{{ words().sentence }}</span>
          }
        </div>

        @if (repo() && plan.mode !== 'ask' && git(); as git) {
          <div class="grid">
            <span class="k">{{ 'threads.whereRow.branch' | transloco }}</span>
            @if (plan.mode === 'local') {
              <div class="v" data-testid="where-branch">
                <div class="anchor">
                  <button
                    type="button"
                    class="btn btn-sm gap-1.5 pick"
                    [title]="'threads.whereRow.checkedOutNowClickToSwitch' | transloco"
                    aria-haspopup="listbox"
                    [attr.aria-expanded]="open() === 'branch'"
                    data-testid="where-branch-button"
                    (click)="toggle('branch')"
                  >
                    <span class="mono">{{ localBranch() }}</span>
                    <pk-icon name="chevron-down" class="chev" />
                  </button>
                  @if (open() === 'branch') {
                    <div
                      class="pk-where-menu"
                      role="listbox"
                      [attr.aria-label]="'threads.whereRow.branch16275' | transloco"
                      data-testid="where-branch-menu"
                    >
                      @for (option of branchEntries(); track option.name) {
                        <button
                          type="button"
                          class="opt"
                          role="option"
                          [attr.aria-selected]="option.name === localBranch()"
                          [attr.aria-disabled]="option.disabled ? 'true' : null"
                          [attr.data-testid]="'where-branch-' + option.name"
                          (click)="pickBranch(option.name, option.disabled)"
                        >
                          <span class="mono">{{ option.name }}</span>
                          <span class="sub">{{ option.sub }}</span>
                        </button>
                      }
                      @if (git.branch) {
                        <button
                          type="button"
                          class="opt more"
                          role="option"
                          aria-selected="false"
                          data-testid="where-new-branch"
                          (click)="typing.set(typing() === 'new' ? undefined : 'new')"
                        >
                          <span>{{ 'threads.whereRow.newBranchFrom' | transloco: { value1: git.branch } }}</span>
                        </button>
                        @if (typing() === 'new') {
                          <div class="typed">
                            <input
                              #fresh
                              class="input input-sm"
                              [placeholder]="'threads.whereRow.featureMyChange' | transloco"
                              [attr.aria-label]="'threads.whereRow.newBranchName' | transloco"
                              data-testid="where-new-branch-name"
                              (keydown.enter)="makeBranch(fresh.value)"
                            />
                            <button
                              type="button"
                              class="btn btn-sm btn-primary"
                              data-testid="where-new-branch-make"
                              (click)="makeBranch(fresh.value)"
                            >
                              {{ 'threads.whereRow.use' | transloco }}
                            </button>
                          </div>
                        }
                      }
                    </div>
                  }
                </div>
              </div>
            } @else {
              <div class="v" data-testid="where-branch">
                <div class="anchor">
                  <button
                    type="button"
                    class="btn btn-sm gap-1.5 pick"
                    [title]="'threads.whereRow.aNewBranchNamedFromTheFirst' | transloco"
                    aria-haspopup="listbox"
                    [attr.aria-expanded]="open() === 'branch'"
                    data-testid="where-branch-button"
                    (click)="toggle('branch')"
                  >
                    <span class="mono">{{ namingLabel() }}</span>
                    <pk-icon name="chevron-down" class="chev" />
                  </button>
                  @if (open() === 'branch') {
                    <div
                      class="pk-where-menu"
                      role="listbox"
                      [attr.aria-label]="'threads.whereRow.branchName' | transloco"
                      data-testid="where-branch-menu"
                    >
                      <button
                        type="button"
                        class="opt"
                        role="option"
                        [attr.aria-selected]="plan.naming === 'named'"
                        data-testid="where-named"
                        (click)="patch({ naming: 'named' }); open.set(undefined)"
                      >
                        <span class="mono">{{ 'threads.whereRow.name' | transloco: { value1: prefix() } }}</span>
                        <span class="sub">{{ 'threads.whereRow.namedFromYourFirstMessage' | transloco }}</span>
                      </button>
                      <button
                        type="button"
                        class="opt"
                        role="option"
                        [attr.aria-selected]="plan.naming === 'detached'"
                        data-testid="where-detached"
                        (click)="patch({ naming: 'detached' }); open.set(undefined)"
                      >
                        <span>{{ 'threads.whereRow.detached' | transloco }}</span>
                        <span class="sub">{{ 'threads.whereRow.noBranchYetCreateBranchHereIn' | transloco }}</span>
                      </button>
                      <button
                        type="button"
                        class="opt"
                        role="option"
                        [attr.aria-selected]="plan.naming === 'typed'"
                        data-testid="where-typed"
                        (click)="patch({ naming: 'typed' })"
                      >
                        <span>{{ 'threads.whereRow.aNameYouType' | transloco }}</span>
                        <span class="sub">{{ 'threads.whereRow.theBranchIsCreatedWithExactlyThis' | transloco }}</span>
                      </button>
                      @if (plan.naming === 'typed') {
                        <div class="typed">
                          <input
                            #name
                            class="input input-sm"
                            [placeholder]="'threads.whereRow.featureMyChange' | transloco"
                            [attr.aria-label]="'threads.whereRow.branchName' | transloco"
                            data-testid="where-typed-name"
                            [value]="plan.typed"
                            (input)="patch({ typed: name.value })"
                            (keydown.enter)="open.set(undefined)"
                          />
                          <button type="button" class="btn btn-sm btn-primary" (click)="open.set(undefined)">
                            {{ 'threads.whereRow.use' | transloco }}
                          </button>
                        </div>
                      }
                    </div>
                  }
                </div>
              </div>
            }

            <span class="k">{{ 'threads.whereRow.from' | transloco }}</span>
            @if (plan.mode === 'local') {
              <div class="v" data-testid="where-from">
                <span
                  class="val"
                  [title]="
                    git.dirty > 0
                      ? git.dirty +
                        ('threads.whereRow.uncommitted' | transloco) +
                        (git.dirty === 1
                          ? ('threads.whereRow.fileStays' | transloco)
                          : ('threads.whereRow.filesStay' | transloco)) +
                        ('threads.whereRow.whereTheyAre' | transloco)
                      : ('threads.whereRow.theFolderAsItIs' | transloco)
                  "
                  >{{ 'threads.whereRow.theFolderAsItIs219ef' | transloco }}</span
                >
              </div>
            } @else {
              <div class="v" data-testid="where-from">
                <div class="anchor">
                  <button
                    type="button"
                    class="btn btn-sm gap-1.5 pick"
                    [title]="'threads.whereRow.theBaseTheWorktreeIsCutFrom' | transloco"
                    aria-haspopup="listbox"
                    [attr.aria-expanded]="open() === 'from'"
                    data-testid="where-from-button"
                    (click)="toggle('from')"
                  >
                    <span class="mono">{{ base() }}</span>
                    <pk-icon name="chevron-down" class="chev" />
                  </button>
                  @if (open() === 'from') {
                    <div
                      class="pk-where-menu"
                      role="listbox"
                      [attr.aria-label]="'threads.whereRow.from3f660' | transloco"
                      data-testid="where-from-menu"
                    >
                      @for (option of baseEntries(); track option.value) {
                        <button
                          type="button"
                          class="opt"
                          role="option"
                          [attr.aria-selected]="option.value === base()"
                          [attr.data-testid]="'where-from-' + option.value"
                          (click)="
                            patch({ from: option.value === git.branch ? null : option.value }); open.set(undefined)
                          "
                        >
                          <span class="mono">{{ option.label }}</span>
                          @if (option.sub) {
                            <span class="sub">{{ option.sub }}</span>
                          }
                        </button>
                      }
                    </div>
                  }
                </div>
                @if (git.dirty > 0 && settings()?.carryChanges !== 'never') {
                  <label
                    class="carry t-xs muted"
                    [title]="
                      ('threads.whereRow.applyTheFolderS' | transloco) +
                      git.dirty +
                      ('threads.whereRow.uncommitted' | transloco) +
                      (git.dirty === 1
                        ? ('threads.whereRow.file' | transloco)
                        : ('threads.whereRow.files' | transloco)) +
                      ('threads.whereRow.toTheNewWorktreeToo' | transloco)
                    "
                  >
                    <input
                      type="checkbox"
                      class="checkbox checkbox-xs"
                      data-testid="where-carry"
                      [checked]="plan.carry"
                      (change)="patch({ carry: $any($event.target).checked })"
                    />{{
                      'threads.whereRow.carry'
                        | transloco
                          : {
                              value1: git.dirty,
                              value2:
                                git.dirty === 1
                                  ? ('threads.whereRow.change' | transloco)
                                  : ('threads.whereRow.changes' | transloco),
                            }
                    }}
                  </label>
                }
              </div>
            }

            <span class="k">{{ 'threads.whereRow.setup' | transloco }}</span>
            <div class="v" data-testid="where-setup">
              <div class="anchor">
                <button
                  type="button"
                  class="btn btn-sm gap-1.5 pick"
                  [title]="setupTitle()"
                  aria-haspopup="listbox"
                  [attr.aria-expanded]="open() === 'setup'"
                  data-testid="where-setup-button"
                  (click)="toggle('setup')"
                >
                  <span>{{ setupLabel() }}</span>
                  <pk-icon name="chevron-down" class="chev" />
                </button>
                @if (open() === 'setup') {
                  <div
                    class="pk-where-menu"
                    role="listbox"
                    [attr.aria-label]="'threads.whereRow.setupcdd7b' | transloco"
                    data-testid="where-setup-menu"
                  >
                    @if (plan.mode === 'local') {
                      <button
                        type="button"
                        class="opt"
                        role="option"
                        [attr.aria-selected]="plan.localSetup === null"
                        (click)="patch({ localSetup: null }); open.set(undefined)"
                      >
                        <span>{{ 'threads.whereRow.none' | transloco }}</span>
                        <span class="sub">{{ 'threads.whereRow.nothingRunsInTheFolder' | transloco }}</span>
                      </button>
                    }
                    @for (script of scripts(); track script.id; let first = $first) {
                      <button
                        type="button"
                        class="opt"
                        role="option"
                        [attr.aria-selected]="script.id === chosenScript()"
                        [attr.data-testid]="'where-setup-' + script.id"
                        (click)="pickScript(script.id)"
                      >
                        <span
                          >{{ script.name }}
                          @if (first && plan.mode === 'worktree') {
                            <span class="muted"> {{ 'threads.whereRow.default' | transloco }}</span>
                          }
                        </span>
                        <span class="sub mono"
                          >{{ script.command
                          }}{{
                            script.copy?.length ? ('threads.whereRow.copies' | transloco) + script.copy!.join(', ') : ''
                          }}</span
                        >
                      </button>
                    }
                    @if (plan.mode === 'worktree') {
                      <button
                        type="button"
                        class="opt"
                        role="option"
                        [attr.aria-selected]="plan.setup === null"
                        data-testid="where-setup-none"
                        (click)="patch({ setup: null }); open.set(undefined)"
                      >
                        <span>{{ 'threads.whereRow.none' | transloco }}</span>
                        <span class="sub">{{ 'threads.whereRow.theWorktreeStartsAsGitLeavesIt' | transloco }}</span>
                      </button>
                    }
                    @if (scripts().length === 0 && plan.mode === 'local') {
                      <span class="sub px-2 py-1 t-xs muted">{{
                        'threads.whereRow.noSetupScriptsYetAddOneIn' | transloco
                      }}</span>
                    }
                  </div>
                }
              </div>
            </div>
          </div>
        }
        @if (error(); as message) {
          <p class="t-xs text-error m-0" role="alert" data-testid="where-error">{{ message }}</p>
        }
      </div>
    }
  `,
})
export class WhereRow {
  protected readonly i18n = inject(Language);
  private readonly threads = inject(ThreadsStore);
  private readonly store = inject(NewThreadStore);
  private readonly chat = inject(ChatStore);

  private readonly threadId = computed(() => this.store.thread()?.id);
  protected readonly open = linkedSignal<string | undefined, MenuName | undefined>({
    source: this.threadId,
    computation: () => undefined,
  });
  /** The inline input of a menu: a new branch name. */
  protected readonly typing = linkedSignal<string | undefined, 'new' | undefined>({
    source: this.threadId,
    computation: () => undefined,
  });

  protected readonly thread = this.store.thread;
  protected readonly plan = this.store.plan;
  protected readonly git = this.store.projectGit;
  protected readonly error = this.store.error;
  protected readonly cwd = computed(() => this.thread()?.cwd);
  protected readonly visible = computed(() => !!this.thread() && this.chat.messages().length === 0);
  protected readonly settings = computed(() => this.store.workspace()?.worktree);
  protected readonly repo = computed(() => this.git()?.git ?? this.settings()?.git ?? false);
  protected readonly projects = this.threads.visibleProjects;
  protected readonly projectName = computed(() => this.store.workspace()?.name ?? 'project');
  protected readonly prefix = computed(() => this.settings()?.branchPrefix ?? 'pi-kit/');
  protected readonly scripts = computed(() => this.settings()?.setupScripts ?? []);

  protected readonly words = computed(() => {
    const plan = this.plan();
    const cwd = this.cwd();
    return plan && cwd
      ? whereWords(this.i18n.t, plan, this.git(), this.settings(), cwd)
      : { sentence: '', crumb: '', hint: '' };
  });
  protected readonly localBranch = computed(() => {
    const plan = this.plan();
    return plan ? localBranchOf(plan, this.git()) : '';
  });
  protected readonly branchEntries = computed(() => {
    const git = this.git();
    return git ? localBranchOptions(this.i18n.t, git, this.settings()?.allowBranchSwitch ?? true) : [];
  });
  protected readonly base = computed(() => {
    const plan = this.plan();
    return plan ? baseOf(plan, this.git()) : '';
  });
  protected readonly baseEntries = computed(() => {
    const git = this.git();
    return git ? baseOptions(this.i18n.t, git) : [];
  });
  protected readonly namingLabel = computed(() => {
    const plan = this.plan();
    if (!plan) return '';
    return plan.naming === 'detached'
      ? 'detached'
      : plan.naming === 'typed'
        ? plan.typed.trim() || this.i18n.t('threads.whereRow.typeAName')
        : `${this.prefix()}<name>`;
  });
  /** The script the setup slot shows: Local's choice (none by default), Worktree's choice (the first by default). */
  protected readonly chosenScript = computed(() => {
    const plan = this.plan();
    if (!plan) return null;
    return plan.mode === 'local'
      ? plan.localSetup
      : plan.setup === undefined
        ? (this.scripts()[0]?.id ?? null)
        : plan.setup;
  });
  protected readonly setupLabel = computed(
    () => this.scripts().find((s) => s.id === this.chosenScript())?.name ?? 'none',
  );
  protected readonly setupTitle = computed(() => {
    const script = this.scripts().find((s) => s.id === this.chosenScript());
    const where =
      this.plan()?.mode === 'local'
        ? this.i18n.t('threads.whereRow.inTheFolderSTerminal')
        : this.i18n.t('threads.whereRow.inTheNewFolderSTerminal');
    return script
      ? this.i18n.t('threads.whereRow.runsFirst', { value1: script.command, value2: where })
      : this.i18n.t('threads.whereRow.noSetupScriptRuns');
  });

  constructor() {
    // The page of a new thread opened: read its folder and start the plan from the project's defaults.
    effect(() => {
      const thread = this.store.thread();
      if (thread && this.chat.messages().length === 0 && !this.store.plans()[thread.id]) void this.store.ensure(thread);
    });
    // The first Send applies the plan (another branch, a worktree, a setup script) before the message goes; a refusal keeps the draft and says why.
    registerInputTransform({
      id: 'where',
      order: 25,
      transform: async (input) => {
        const thread = this.store.thread();
        if (!thread || this.chat.messages().length > 0 || !this.store.plans()[thread.id] || input.handled) return input;
        try {
          await this.store.apply(thread.id, input.text);
          return input;
        } catch (error) {
          return { ...input, refuse: errorMessage(error) };
        }
      },
    });
  }

  protected setMode(mode: WhereMode): void {
    const thread = this.thread();
    if (thread) this.store.setMode(thread.id, mode);
    this.open.set(undefined);
  }

  protected patch(change: Parameters<NewThreadStore['patch']>[1]): void {
    const thread = this.thread();
    if (thread) this.store.patch(thread.id, change);
  }

  protected toggle(menu: MenuName): void {
    this.typing.set(undefined);
    this.open.set(this.open() === menu ? undefined : menu);
  }

  protected pickBranch(name: string, disabled: string | undefined): void {
    if (disabled) return;
    const thread = this.thread();
    if (thread) this.store.pickLocalBranch(thread.id, name);
    this.open.set(undefined);
  }

  protected makeBranch(name: string): void {
    const trimmed = name.trim();
    if (!trimmed) return;
    this.patch({ newBranch: trimmed, localBranch: null });
    this.typing.set(undefined);
    this.open.set(undefined);
  }

  protected pickScript(id: string): void {
    this.patch(this.plan()?.mode === 'local' ? { localSetup: id } : { setup: id });
    this.open.set(undefined);
  }

  /** Another project: its own empty thread opens in its place (the one here had nothing in it). */
  protected async pickProject(cwd: string): Promise<void> {
    this.open.set(undefined);
    const current = this.thread();
    if (!current || cwd === current.cwd) return;
    const next = await this.threads.create(cwd).catch(() => undefined);
    if (!next) return;
    this.threads.select(next.id);
    await this.threads.remove(current.id).catch(() => undefined);
    this.store.forget(current.id);
  }

  protected outside(event: Event): void {
    if (this.open() && !(event.target as HTMLElement).closest('.pk-where .anchor')) this.open.set(undefined);
  }
}
