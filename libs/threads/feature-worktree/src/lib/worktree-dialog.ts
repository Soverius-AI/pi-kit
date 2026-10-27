import { Language } from '@pi-kit/i18n';
import { TranslocoPipe } from '@pi-kit/i18n';
import { ChangeDetectionStrategy, Component, ElementRef, computed, effect, inject, viewChild } from '@angular/core';
import { WorktreeStore } from '@pi-kit/threads/data';
import { PkIcon } from '@pi-kit/design-system';

/**
 * Sync with base, Merge back, Hand off to local and Move into a worktree: one dialog in the workflow-dialog frame (`.pk-wf`, a bottom sheet on phones). Sync fetches and brings the base
 * into the thread's branch by merge or rebase; conflicts stay in the worktree and open in review mode. Merge back commits what is uncommitted with a message the person
 * edits (pi-kit proposes one from the changed files), then merges into the base with a merge commit or opens a pull request with `gh`, and offers to remove the worktree.
 * Esc closes it. This component is a lazy chunk.
 */
@Component({
  imports: [TranslocoPipe, PkIcon],
  selector: 'pk-worktree-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (store.dialog(); as d) {
      <div class="pk-wf">
        <button
          type="button"
          class="pk-backdrop"
          tabindex="-1"
          [attr.aria-label]="'threads.worktreeDialog.close' | transloco"
          (click)="store.close()"
        ></button>
        <div
          #win
          class="win"
          role="dialog"
          aria-modal="true"
          [attr.aria-label]="title()"
          tabindex="-1"
          [attr.data-testid]="
            d.mode === 'sync' ? 'sync-dialog' : d.mode === 'merge' ? 'merge-dialog' : 'handoff-dialog'
          "
          (keydown.escape)="$event.preventDefault(); $event.stopPropagation(); store.close()"
        >
          <div class="head">
            <h2>{{ title() }}</h2>
            <button
              type="button"
              class="pk-close ml-auto"
              [title]="'threads.worktreeDialog.close' | transloco"
              [attr.aria-label]="'threads.worktreeDialog.close' | transloco"
              (click)="store.close()"
            >
              <pk-icon name="close" />
            </button>
          </div>

          <div class="body">
            @if (store.busy() === 'loading') {
              <div class="grid place-items-center py-6">
                <span
                  class="loading loading-dots loading-sm text-primary"
                  [attr.aria-label]="'threads.worktreeDialog.readingTheWorktree' | transloco"
                ></span>
              </div>
            } @else if (d.mode === 'move') {
              @if (store.folder(); as folder) {
                <div class="box" data-testid="worktree-box">
                  <div class="flex items-center gap-2 flex-wrap">
                    <span class="chip off">{{ 'threads.worktreeDialog.theProjectFolder' | transloco }}</span>
                    <pk-icon name="arrow-right" size="14" />
                    <span class="chip">{{ 'threads.worktreeDialog.aNewWorktree' | transloco }}</span>
                  </div>
                  <div class="hint" data-testid="move-summary">
                    {{
                      'threads.worktreeDialog.aWorktreeIsMadeFromWithIts'
                        | transloco
                          : {
                              value1:
                                folder.branch ?? folder.head ?? ('threads.worktreeDialog.theCurrentCommit' | transloco),
                            }
                    }}
                  </div>
                </div>
                @if (!folder.git) {
                  <p class="text-sm text-error" role="alert">
                    {{ 'threads.worktreeDialog.thisProjectIsNotAGitRepository' | transloco }}
                  </p>
                } @else if (folder.dirty > 0) {
                  <label class="flex items-center gap-2 text-sm cursor-pointer">
                    <input
                      type="checkbox"
                      class="checkbox checkbox-sm"
                      data-testid="move-carry"
                      [checked]="store.handoffCarry()"
                      [disabled]="store.busy() !== undefined || !!store.handoffResult()"
                      (change)="store.setHandoffCarry($any($event.target).checked)"
                    />
                    <span
                      >{{
                        'threads.worktreeDialog.moveTheToo'
                          | transloco: { value1: plural(folder.dirty, 'uncommitted-file') }
                      }}<span class="hint">{{
                        'threads.worktreeDialog.theyLeaveTheFolderACopyStays' | transloco
                      }}</span></span
                    >
                  </label>
                } @else {
                  <p class="hint">{{ 'threads.worktreeDialog.theFolderHasNoUncommittedChangesSo' | transloco }}</p>
                }
              }
            } @else if (store.status(); as s) {
              @if (!s.exists) {
                <p class="text-sm">
                  {{
                    'threads.worktreeDialog.thisWorktreeIsGoneSoThereIs'
                      | transloco
                        : {
                            value1:
                              d.mode === 'sync'
                                ? ('threads.worktreeDialog.sync' | transloco)
                                : ('threads.worktreeDialog.merge' | transloco),
                          }
                  }}
                </p>
              } @else {
                <div class="box" data-testid="worktree-box">
                  <div class="flex items-center gap-2 flex-wrap">
                    <span class="chip" data-testid="worktree-branch">{{
                      s.branch ?? ('threads.worktreeDialog.noBranch' | transloco)
                    }}</span>
                    <pk-icon name="arrow-right" size="14" />
                    <span class="chip off">{{ s.base ?? ('threads.worktreeDialog.noBase' | transloco) }}</span>
                  </div>
                  <div class="hint" data-testid="worktree-counts">
                    {{
                      'threads.worktreeDialog.aheadBehind'
                        | transloco
                          : { value1: plural(s.ahead, 'commit'), value2: plural(s.behind, 'commit'), value3: s.base }
                    }}
                    @if (s.dirty > 0) {
                      {{
                        'threads.worktreeDialog.withUncommittedChanges' | transloco: { value1: plural(s.dirty, 'file') }
                      }}
                    }
                    .
                  </div>
                </div>

                @if (s.conflicts.length > 0 || (s.operation && store.conflicts().length > 0)) {
                  <div class="box" role="alert" data-testid="conflicts">
                    <div class="lbl">
                      {{
                        'threads.worktreeDialog.conflicts'
                          | transloco
                            : {
                                value1: plural(s.conflicts.length, 'file'),
                                value2:
                                  s.conflicts.length === 1
                                    ? ('threads.worktreeDialog.has' | transloco)
                                    : ('threads.worktreeDialog.have' | transloco),
                              }
                      }}
                    </div>
                    <ul class="mono text-xs">
                      @for (file of s.conflicts; track file) {
                        <li class="truncate" [title]="file">{{ file }}</li>
                      }
                    </ul>
                    <div class="hint">
                      {{
                        'threads.worktreeDialog.theWaitsInTheWorktreeWithThe'
                          | transloco: { value1: s.operation ?? ('threads.worktreeDialog.merge' | transloco) }
                      }}
                    </div>
                    <div class="flex items-center gap-2">
                      <button
                        type="button"
                        class="btn btn-sm btn-primary"
                        data-testid="review-conflicts"
                        (click)="store.reviewConflicts()"
                      >
                        {{ 'threads.worktreeDialog.reviewConflicts' | transloco }}
                      </button>
                      <button
                        type="button"
                        class="btn btn-sm btn-ghost"
                        [disabled]="store.busy() !== undefined"
                        (click)="store.abort()"
                      >
                        {{
                          'threads.worktreeDialog.abortThe'
                            | transloco: { value1: s.operation ?? ('threads.worktreeDialog.merge' | transloco) }
                        }}
                      </button>
                    </div>
                  </div>
                }

                @if (d.mode === 'handoff') {
                  <div class="box" data-testid="handoff-summary">
                    <div class="lbl">
                      {{
                        s.branch
                          ? ('threads.worktreeDialog.theFolderSwitchesTo' | transloco) + s.branch
                          : ('threads.worktreeDialog.theFolderMovesToTheWorktreeS' | transloco)
                      }}
                    </div>
                    <div class="hint">
                      @if (s.dirty > 0) {
                        {{
                          'threads.worktreeDialog.theWorktreeSComeAlongUncommittedInto'
                            | transloco: { value1: plural(s.dirty, 'uncommitted-file') }
                        }}
                      } @else {
                        {{ 'threads.worktreeDialog.theWorktreeHasNoUncommittedChangesSo' | transloco }}
                      }
                      {{ 'threads.worktreeDialog.theThreadSPiSessionGoesOn' | transloco }}
                    </div>
                  </div>
                  @if (store.folder(); as folder) {
                    @if (folder.dirty > 0) {
                      <p class="text-sm text-error" role="alert" data-testid="handoff-blocked">
                        {{
                          'threads.worktreeDialog.theFolderHasCommitOrStashThen'
                            | transloco
                              : {
                                  value1: plural(folder.dirty, 'uncommitted-file'),
                                  value2:
                                    folder.dirty === 1
                                      ? ('threads.worktreeDialog.it' | transloco)
                                      : ('threads.worktreeDialog.them' | transloco),
                                }
                        }}
                      </p>
                    }
                  }
                  @if (s.sharedWith > 0) {
                    <p class="text-sm text-error" role="alert">
                      {{ 'threads.worktreeDialog.anotherThreadRunsInThisWorktreeToo' | transloco }}
                    </p>
                  }
                  <label class="flex items-center gap-2 text-sm cursor-pointer">
                    <input
                      type="checkbox"
                      class="checkbox checkbox-sm"
                      data-testid="handoff-remove"
                      [checked]="store.handoffRemove()"
                      [disabled]="store.busy() !== undefined || !!store.handoffResult()"
                      (change)="store.setHandoffRemove($any($event.target).checked)"
                    />
                    <span
                      >{{ 'threads.worktreeDialog.removeTheWorktreeFolderAfterwards' | transloco
                      }}<span class="hint">{{
                        s.removeFolder === 'after-7-days'
                          ? ('threads.worktreeDialog.otherwiseItIsRemovedAfter7Days' | transloco)
                          : ''
                      }}</span></span
                    >
                  </label>
                } @else if (d.mode === 'sync') {
                  <fieldset
                    class="flex flex-col gap-2"
                    [disabled]="store.busy() !== undefined || s.conflicts.length > 0"
                  >
                    <legend class="lbl mb-1">
                      {{ 'threads.worktreeDialog.howToBringIn' | transloco: { value1: s.base } }}
                    </legend>
                    <button
                      type="button"
                      class="pk-choice"
                      [attr.aria-pressed]="store.strategy() === 'merge'"
                      data-testid="strategy-merge"
                      (click)="store.setStrategy('merge')"
                    >
                      <span class="lbl">{{ 'threads.worktreeDialog.mergeea8f0' | transloco }}</span>
                      <span class="hint">{{ 'threads.worktreeDialog.aMergeCommitInTheBranchSafe' | transloco }}</span>
                    </button>
                    <button
                      type="button"
                      class="pk-choice"
                      [attr.aria-pressed]="store.strategy() === 'rebase'"
                      data-testid="strategy-rebase"
                      (click)="store.setStrategy('rebase')"
                    >
                      <span class="lbl">{{ 'threads.worktreeDialog.rebase' | transloco }}</span>
                      <span class="hint">{{
                        'threads.worktreeDialog.replaysTheBranchSCommitsOnTop' | transloco: { value1: s.base }
                      }}</span>
                    </button>
                  </fieldset>
                  @if (store.syncResult(); as r) {
                    @if (r.status !== 'conflict') {
                      <p class="text-sm" role="status" data-testid="sync-result">{{ r.message }}</p>
                    }
                  }
                } @else {
                  @if (s.dirty > 0 || s.operation) {
                    <div>
                      <label class="lbl" for="wt-message">{{
                        'threads.worktreeDialog.commitMessage' | transloco
                      }}</label>
                      <div class="hint">
                        {{
                          'threads.worktreeDialog.piKitProposedItFromTheChanged'
                            | transloco
                              : {
                                  value1: s.operation
                                    ? ('threads.worktreeDialog.thisFinishesThe' | transloco) +
                                      s.operation +
                                      ('threads.worktreeDialog.inTheWorktree' | transloco)
                                    : ('threads.worktreeDialog.theUncommittedChangesAreCommittedFirstWith' | transloco),
                                }
                        }}
                      </div>
                    </div>
                    <textarea
                      id="wt-message"
                      class="textarea w-full"
                      rows="5"
                      spellcheck="true"
                      data-testid="commit-message"
                      [value]="store.message()"
                      [disabled]="store.busy() !== undefined"
                      (input)="store.setMessage($any($event.target).value)"
                    ></textarea>
                  }
                  <fieldset class="flex flex-col gap-2" [disabled]="store.busy() !== undefined">
                    <legend class="lbl mb-1">{{ 'threads.worktreeDialog.whereItGoes' | transloco }}</legend>
                    <button
                      type="button"
                      class="pk-choice"
                      [attr.aria-pressed]="store.mergeMode() === 'merge'"
                      data-testid="mode-merge"
                      (click)="store.setMergeMode('merge')"
                    >
                      <span class="lbl">{{ 'threads.worktreeDialog.mergeInto' | transloco: { value1: s.base } }}</span>
                      <span class="hint">{{
                        'threads.worktreeDialog.aMergeCommitOnInTheProject' | transloco: { value1: s.base }
                      }}</span>
                    </button>
                    @if (!s.baseCheckedOut && store.mergeMode() === 'merge') {
                      <p class="hint text-warning" data-testid="base-not-checked-out">
                        {{
                          'threads.worktreeDialog.theProjectFolderDoesNotHaveChecked'
                            | transloco
                              : {
                                  value1: s.base,
                                  value2:
                                    s.projectDirty > 0
                                      ? ('threads.worktreeDialog.andHasUncommittedChanges' | transloco)
                                      : '',
                                  value3: s.base,
                                }
                        }}
                      </p>
                    }
                    <button
                      type="button"
                      class="pk-choice"
                      [attr.aria-pressed]="store.mergeMode() === 'pr'"
                      [disabled]="!s.gh || !s.remote"
                      data-testid="mode-pr"
                      (click)="store.setMergeMode('pr')"
                    >
                      <span class="lbl">{{ 'threads.worktreeDialog.openAPullRequest' | transloco }}</span>
                      <span class="hint">{{
                        s.gh && s.remote
                          ? ('threads.worktreeDialog.pushesTheBranchAndRunsGhPr' | transloco)
                          : !s.remote
                            ? ('threads.worktreeDialog.thisRepositoryHasNoRemoteToPush' | transloco)
                            : ('threads.worktreeDialog.theGitHubCLIGhIsNotInstalled' | transloco)
                      }}</span>
                    </button>
                  </fieldset>
                  <label class="flex items-center gap-2 text-sm cursor-pointer">
                    <input
                      type="checkbox"
                      class="checkbox checkbox-sm"
                      data-testid="remove-after"
                      [checked]="store.remove()"
                      [disabled]="store.busy() !== undefined"
                      (change)="store.setRemove($any($event.target).checked)"
                    />
                    <span
                      >{{ 'threads.worktreeDialog.removeTheWorktreeAfterwards' | transloco
                      }}<span class="hint">{{
                        'threads.worktreeDialog.theThreadCarriesOnInTheProject' | transloco
                      }}</span></span
                    >
                  </label>
                  @if (store.mergeResult(); as r) {
                    @if (r.status === 'conflict') {
                      <div class="box" role="alert" data-testid="merge-conflict">
                        <div class="lbl">{{ r.message }}</div>
                        <ul class="mono text-xs">
                          @for (file of r.conflicts; track file) {
                            <li class="truncate">{{ file }}</li>
                          }
                        </ul>
                        <div class="flex items-center gap-2">
                          <button
                            type="button"
                            class="btn btn-sm btn-primary"
                            data-testid="to-sync"
                            (click)="store.toSync()"
                          >
                            {{ 'threads.worktreeDialog.syncWith' | transloco: { value1: s.base } }}
                          </button>
                        </div>
                      </div>
                    } @else {
                      <p class="text-sm text-success" role="status" data-testid="merge-result">{{ r.message }}</p>
                    }
                  }
                }
              }
            }
            @if (store.handoffResult(); as r) {
              <p class="text-sm text-success" role="status" data-testid="handoff-result">{{ r.message }}</p>
            }
            @if (store.error(); as error) {
              <p class="text-sm text-error" role="alert" data-testid="worktree-error">{{ error }}</p>
            }
          </div>

          <div class="foot">
            @if (store.busy() === 'sync' || store.busy() === 'merge' || store.busy() === 'handoff') {
              <span class="loading loading-spinner loading-xs text-primary" aria-hidden="true"></span>
              <span class="hint">{{
                store.busy() === 'sync'
                  ? ('threads.worktreeDialog.syncing' | transloco)
                  : store.busy() === 'merge'
                    ? ('threads.worktreeDialog.mergingBack' | transloco)
                    : ('threads.worktreeDialog.moving' | transloco)
              }}</span>
            }
            <span class="ml-auto flex items-center gap-2">
              <button type="button" class="btn btn-sm btn-ghost" (click)="store.close()">
                {{
                  finished()
                    ? ('threads.worktreeDialog.done' | transloco)
                    : ('threads.worktreeDialog.cancel' | transloco)
                }}
              </button>
              @if (!finished()) {
                @if (d.mode === 'sync') {
                  <button
                    type="button"
                    class="btn btn-sm btn-primary"
                    data-testid="do-sync"
                    [disabled]="!canSync()"
                    (click)="store.sync()"
                  >
                    {{ 'threads.worktreeDialog.syncWith' | transloco: { value1: store.status()?.base } }}
                  </button>
                } @else if (d.mode === 'handoff' || d.mode === 'move') {
                  <button
                    type="button"
                    class="btn btn-sm btn-primary"
                    data-testid="do-handoff"
                    [disabled]="!store.canHandoff()"
                    (click)="store.handoff()"
                  >
                    {{
                      d.mode === 'handoff'
                        ? ('threads.worktreeDialog.handOffToLocal' | transloco)
                        : ('threads.worktreeDialog.moveIntoAWorktree' | transloco)
                    }}
                  </button>
                } @else {
                  <button
                    type="button"
                    class="btn btn-sm btn-primary"
                    data-testid="do-merge"
                    [disabled]="!store.canMerge()"
                    (click)="store.merge()"
                  >
                    {{
                      store.mergeMode() === 'pr'
                        ? ('threads.worktreeDialog.openPullRequest' | transloco)
                        : ('threads.worktreeDialog.mergeBack' | transloco)
                    }}
                  </button>
                }
              }
            </span>
          </div>
        </div>
      </div>
    }
  `,
})
export class WorktreeDialog {
  protected readonly i18n = inject(Language);
  protected readonly store = inject(WorktreeStore);
  private readonly win = viewChild<ElementRef<HTMLElement>>('win');

  protected readonly title = computed(() => {
    const base = this.store.status()?.base;
    switch (this.store.dialog()?.mode) {
      case 'sync':
        return this.i18n.t('threads.worktreeDialog.syncWith', {
          value1: base ?? this.i18n.t('threads.worktreeDialog.base'),
        });
      case 'handoff':
        return this.i18n.t('threads.worktreeDialog.handOffToLocal');
      case 'move':
        return this.i18n.t('threads.worktreeDialog.moveIntoAWorktree');
      default:
        return this.i18n.t('threads.worktreeDialog.mergeBackInto', {
          value1: base ?? this.i18n.t('threads.worktreeDialog.base'),
        });
    }
  });

  /** The action happened: the footer offers Done instead of the action. */
  protected readonly finished = computed(() => {
    const mode = this.store.dialog()?.mode;
    if (mode === 'handoff' || mode === 'move') return this.store.handoffResult() !== undefined;
    if (mode === 'sync')
      return this.store.syncResult()?.status === 'up-to-date' || this.store.syncResult()?.status === 'synced';
    const r = this.store.mergeResult();
    return r !== undefined && r.status !== 'conflict';
  });

  protected readonly canSync = computed(() => {
    const s = this.store.status();
    return !!s && s.exists && s.conflicts.length === 0 && this.store.busy() === undefined && !s.operation;
  });

  constructor() {
    // The dialog takes the focus when it opens (Esc and Tab then work inside it).
    effect(() => {
      if (this.store.dialog() && this.win()) queueMicrotask(() => this.win()?.nativeElement.focus());
    });
  }

  protected plural(n: number, word: 'file' | 'commit' | 'uncommitted-file'): string {
    return this.i18n.t(`common.counts.${word}.${n === 1 ? 'one' : 'other'}`, { count: n });
  }
}
