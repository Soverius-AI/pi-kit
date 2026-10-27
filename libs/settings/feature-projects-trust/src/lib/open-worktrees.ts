import { Language } from '@pi-kit/i18n';
import { TranslocoPipe } from '@pi-kit/i18n';
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { PkIcon, PkItem, PkTip } from '@pi-kit/design-system';
import { ProjectPageStore } from '@pi-kit/settings/data';
import { aheadText, tildePath } from '@pi-kit/settings/util';

/**
 * The “Open worktrees” group of a project's page: one row per worktree folder the project has now, with the branch, the state of its thread, the thread's
 * title, how far ahead of its base it is, and the thread menu's actions (Hand off to local, Merge back…, Remove folder) through the same dialogs and routes. The rows are
 * read when the page opens and again when a dialog closes; nothing is polled.
 */
@Component({
  selector: 'pk-open-worktrees',
  imports: [PkItem, PkTip, TranslocoPipe, PkIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section
      class="pk-group"
      [attr.aria-label]="'settings.openWorktrees.openWorktrees' | transloco"
      data-testid="project-open-worktrees"
    >
      <header>
        <div>
          <h4>{{ 'settings.openWorktrees.openWorktrees' | transloco }}</h4>
          <p>{{ 'settings.openWorktrees.foldersThisProjectHasRightNowAnd' | transloco }}</p>
        </div>
      </header>
      <div role="list">
        @for (row of page.rows(); track row.threadId) {
          <div
            pkItem
            role="listitem"
            [dimmed]="row.archived"
            [attr.data-testid]="'worktree-' + row.threadId"
            [attr.data-branch]="row.branch"
          >
            <pk-icon name="worktree" tile />
            <ng-container nm>
              <span [class.mono]="!row.detached" data-testid="worktree-branch">{{ row.branch }}</span>
              <span class="chip" [class]="row.state.tone" data-testid="worktree-state">{{ row.state.text }}</span>
            </ng-container>
            <ng-container ds>
              <span data-testid="worktree-thread">{{
                'settings.openWorktrees.thread' | transloco: { value1: row.title }
              }}</span>
              @if (ahead(row); as text) {
                <span data-testid="worktree-ahead">· {{ text }}</span>
              }
              <span class="mono basis-full" [pkTip]="row.path">{{ short(row.path) }}</span>
            </ng-container>
            <ng-container act>
              <span
                [pkTip]="
                  row.busy
                    ? ('settings.openWorktrees.aRunIsGoingInThisThread' | transloco)
                    : ('settings.openWorktrees.moveTheThreadAndItsChangesInto' | transloco)
                "
              >
                <button
                  type="button"
                  class="btn btn-sm btn-ghost"
                  [disabled]="row.busy"
                  [attr.data-testid]="'handoff-' + row.threadId"
                  (click)="page.handoff(row.threadId)"
                >
                  {{ 'settings.openWorktrees.handOffToLocal' | transloco }}
                </button>
              </span>
              <span
                [pkTip]="
                  row.busy
                    ? ('settings.openWorktrees.aRunIsGoingInThisThread' | transloco)
                    : ('settings.openWorktrees.mergeTheBranchIntoItsBaseOr' | transloco)
                "
              >
                <button
                  type="button"
                  class="btn btn-sm btn-ghost"
                  [disabled]="row.busy"
                  [attr.data-testid]="'merge-' + row.threadId"
                  (click)="page.mergeBack(row.threadId)"
                >
                  {{ 'settings.openWorktrees.mergeBack' | transloco }}
                </button>
              </span>
              <span
                [pkTip]="
                  row.busy
                    ? ('settings.openWorktrees.aRunIsGoingInThisThread' | transloco)
                    : ('settings.openWorktrees.deleteTheWorktreeFolderTheThreadCarries' | transloco)
                "
              >
                <button
                  type="button"
                  class="btn btn-sm btn-ghost"
                  [disabled]="row.busy"
                  [attr.data-testid]="'remove-folder-' + row.threadId"
                  (click)="page.askRemove(row.threadId)"
                >
                  {{ 'settings.openWorktrees.removeFolder' | transloco }}
                </button>
              </span>
            </ng-container>
            @if (asking(row.threadId); as ask) {
              <div extra class="extra pk-expand" role="alert" data-testid="remove-confirm">
                <div class="text-sm">
                  @if (ask.message) {
                    {{ ask.message }}
                  } @else {
                    {{ 'settings.openWorktrees.removeTheFolder' | transloco }}
                    <span class="mono">{{ short(row.path) }}</span
                    >{{ 'settings.openWorktrees.theThreadCarriesOnInTheProject' | transloco }}
                  }
                </div>
                <div class="flex gap-2">
                  <button type="button" class="btn btn-sm btn-ghost" (click)="page.cancelConfirm()">
                    {{ 'settings.openWorktrees.cancel' | transloco }}
                  </button>
                  <button
                    type="button"
                    class="btn btn-sm btn-error"
                    data-testid="remove-confirm-yes"
                    (click)="page.removeFolder()"
                  >
                    {{
                      ask.force
                        ? ('settings.openWorktrees.removeAnyway' | transloco)
                        : ('settings.openWorktrees.removeFolder' | transloco)
                    }}
                  </button>
                </div>
              </div>
            }
          </div>
        } @empty {
          <div class="empty" data-testid="worktrees-empty">
            @if (page.worktreesLoading()) {
              <span
                class="loading loading-dots loading-sm text-primary"
                [attr.aria-label]="'settings.openWorktrees.readingTheWorktrees' | transloco"
              ></span>
            } @else {
              <span>{{ 'settings.openWorktrees.noOpenWorktreesAThreadStartedIn' | transloco }}</span>
            }
          </div>
        }
      </div>
    </section>
  `,
})
export class OpenWorktrees {
  protected readonly i18n = inject(Language);
  protected readonly page = inject(ProjectPageStore);
  protected readonly ahead = aheadText.bind(undefined, this.i18n.t);
  protected readonly short = tildePath;

  /** The confirmation under a row, if this thread's folder is the one being removed. */
  protected asking(threadId: string): { force: boolean; message?: string } | undefined {
    const c = this.page.confirming();
    return c?.kind === 'remove' && c.threadId === threadId ? c : undefined;
  }
}
