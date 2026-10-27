import type { Translate } from '@pi-kit/i18n';
import { Language } from '@pi-kit/i18n';
import { TranslocoPipe } from '@pi-kit/i18n';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import type { FileStatus } from '@pi-kit/protocol';
import { UiStore } from '@pi-kit/data-access';
import { ChangesStore } from '@pi-kit/review/data';

/** The tint of the status letter: amber for modified, success for added, error for deleted. */
const changeKindLabels = (translate: Translate): Record<FileStatus, { label: string; className: string }> => ({
  M: { label: translate('review.changesPanel.modified'), className: 'bg-warning/25 text-warning' },
  A: { label: translate('review.changesPanel.added'), className: 'bg-success/25 text-success' },
  D: { label: translate('review.changesPanel.deleted'), className: 'bg-error/25 text-error' },
});

/**
 * The Changes side panel: the files from one source (this thread, the working tree, or the outcome), grouped by folder,
 * with `+n −m` and the number of pending comments; a click opens the file in review mode. "Revert file" (after a
 * confirmation, because it overwrites the file on disk) and "Stage all" are at the bottom.
 */
@Component({
  imports: [TranslocoPipe],
  selector: 'pk-changes-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'pk-panel', '[attr.aria-label]': "i18n.t('review.changesPanel.changes')" },
  template: `
    <div class="pk-bar">
      <span class="font-medium">{{ 'review.changesPanel.changes' | transloco }}</span>
      <span class="muted t-sm"
        >{{ review.files().length }}
        {{
          review.files().length === 1
            ? ('review.changesPanel.file' | transloco)
            : ('review.changesPanel.files' | transloco)
        }}</span
      >
      <div class="pk-seg pk-seg-xs ml-auto" role="group" [attr.aria-label]="'review.changesPanel.source' | transloco">
        <button type="button" [attr.aria-pressed]="review.source() === 'thread'" (click)="review.setSource('thread')">
          {{ 'review.changesPanel.thisThread' | transloco }}
        </button>
        <button
          type="button"
          [attr.aria-pressed]="review.source() === 'worktree'"
          (click)="review.setSource('worktree')"
        >
          {{ 'review.changesPanel.workingTree' | transloco }}
        </button>
        <button
          type="button"
          data-testid="source-outcome"
          [attr.aria-pressed]="review.source() === 'outcome'"
          [disabled]="!review.hasOutcome()"
          [title]="
            review.hasOutcome()
              ? ('review.changesPanel.theCommitsThatAreThisThreadS' | transloco)
              : ('review.changesPanel.thisThreadHasNoOutcomeYetIt' | transloco)
          "
          (click)="review.setSource('outcome')"
        >
          {{ 'review.changesPanel.outcome' | transloco }}
        </button>
      </div>
      <button
        type="button"
        class="btn btn-ghost btn-xs btn-square"
        [title]="'review.changesPanel.close' | transloco"
        [attr.aria-label]="'review.changesPanel.closeTheChangesPanel' | transloco"
        (click)="bus.closePanel()"
      >
        ✕
      </button>
    </div>

    <div
      class="flex-1 overflow-y-auto p-2"
      role="list"
      [attr.aria-label]="'review.changesPanel.changedFiles' | transloco"
    >
      @if (review.error(); as error) {
        <p class="p-3 text-sm text-error" role="alert">
          {{ 'review.changesPanel.theChangesCouldNotBeLoaded' | transloco: { value1: error } }}
        </p>
      } @else if (!review.list() && review.loading()) {
        <div class="py-8 grid place-items-center">
          <span
            class="loading loading-dots loading-sm text-primary"
            [attr.aria-label]="'review.changesPanel.loadingTheChanges' | transloco"
          ></span>
        </div>
      } @else {
        @if (review.list()?.note; as note) {
          <p class="px-3 pt-2 text-sm text-muted">{{ note }}</p>
        }
        @for (group of review.groups(); track group.dir) {
          <div class="pk-section" [class.pt-2]="$first">
            {{ group.dir || ('review.changesPanel.topLevel' | transloco) }}
          </div>
          @for (file of group.files; track file.path) {
            <a
              class="pk-file"
              role="listitem"
              href="#"
              [attr.aria-current]="file.path === review.selectedId() ? 'true' : null"
              [title]="file.path"
              (click)="pick($event, file.path)"
            >
              <span class="p">
                <span class="k" [class]="kind(file.status).className" [title]="kind(file.status).label">{{
                  file.status
                }}</span
                >{{ name(file.path) }}
              </span>
              <span class="s">
                @if (file.conflict) {
                  <span
                    class="badge badge-error badge-soft badge-xs"
                    data-testid="conflict-badge"
                    [title]="'review.changesPanel.unresolvedMergeConflicts' | transloco"
                    >{{ 'review.changesPanel.conflict' | transloco }}</span
                  >
                }
                @if (file.binary) {
                  <span class="muted">{{ 'review.changesPanel.binary' | transloco }}</span>
                } @else {
                  @if (file.added > 0 || file.removed === 0) {
                    <span class="text-success">+{{ file.added }}</span>
                  }
                  @if (file.removed > 0) {
                    <span class="text-error">−{{ file.removed }}</span>
                  }
                }
                @if (review.counts().get(file.path); as count) {
                  <span
                    class="badge badge-primary badge-xs"
                    [title]="
                      count +
                      ('review.changesPanel.pending' | transloco) +
                      (count === 1
                        ? ('review.changesPanel.comment' | transloco)
                        : ('review.changesPanel.comments' | transloco))
                    "
                    >{{ count }}</span
                  >
                }
              </span>
            </a>
          }
        } @empty {
          <p class="p-3 text-sm text-muted">
            @if (review.source() === 'thread') {
              {{ 'review.changesPanel.piHasNotChangedAnyFileIn' | transloco }}
            } @else if (review.source() === 'outcome') {
              {{ review.list()?.note ?? ('review.changesPanel.theOutcomeChangedNoFile' | transloco) }}
            } @else if (review.list()?.git === false) {
              {{ 'review.changesPanel.thisFolderIsNotAGitRepository' | transloco }}
            } @else {
              {{ 'review.changesPanel.theWorkingTreeMatchesHEADNothingTo' | transloco }}
            }
          </p>
        }
      }
    </div>

    <div class="shrink-0 p-3 flex flex-col gap-2" style="border-top: 1px solid var(--color-base-300)">
      @if (review.files().length > 0 && review.mode() === 'chat') {
        <button type="button" class="btn btn-sm btn-primary" (click)="review.open()">
          {{ 'review.changesPanel.reviewChanges' | transloco }}
        </button>
      }
      <div class="flex gap-2">
        <button
          type="button"
          class="btn btn-sm flex-1"
          [disabled]="!review.selectedId() || !!review.busy() || !review.editable()"
          [title]="review.editable() ? '' : ('review.changesPanel.theOutcomeIsCommittedHistoryThereIs' | transloco)"
          (click)="confirming.set(review.selectedId())"
        >
          {{ 'review.changesPanel.revertFile' | transloco }}
        </button>
        <button
          type="button"
          class="btn btn-sm flex-1"
          [disabled]="
            review.files().length === 0 || !!review.busy() || review.list()?.git === false || !review.editable()
          "
          [title]="
            review.list()?.git === false
              ? ('review.changesPanel.thisFolderIsNotAGitRepositoryb5942' | transloco)
              : review.editable()
                ? ''
                : ('review.changesPanel.theOutcomeIsAlreadyCommitted' | transloco)
          "
          (click)="review.stageAll()"
        >
          {{ 'review.changesPanel.stageAll' | transloco }}
        </button>
      </div>
    </div>

    @if (confirming(); as path) {
      <dialog
        class="modal modal-open"
        aria-labelledby="revert-title"
        tabindex="-1"
        (keydown.escape)="confirming.set(undefined)"
      >
        <div class="modal-box">
          <h3 id="revert-title" class="t-xl">{{ 'review.changesPanel.revert' | transloco: { value1: name(path) } }}</h3>
          <p class="py-3 text-sm">
            <code class="break-all">{{ path }}</code>
            {{
              'review.changesPanel.goesBackToThisOverwritesTheFile'
                | transloco
                  : {
                      value1:
                        review.source() === 'thread'
                          ? ('review.changesPanel.howItWasBeforePiFirstChanged' | transloco)
                          : ('review.changesPanel.itsStateInGitSHEAD' | transloco),
                    }
            }}
            @if (review.counts().get(path)) {
              {{
                'review.changesPanel.yourPendingOnItWillBeDropped'
                  | transloco
                    : {
                        value1: review.counts().get(path),
                        value2:
                          review.counts().get(path) === 1
                            ? ('review.changesPanel.comment' | transloco)
                            : ('review.changesPanel.comments' | transloco),
                      }
              }}
            }
          </p>
          <div class="modal-action">
            <button type="button" class="btn btn-ghost btn-sm" (click)="confirming.set(undefined)">
              {{ 'review.changesPanel.cancel' | transloco }}
            </button>
            <button type="button" class="btn btn-error btn-sm" (click)="revert(path)">
              {{ 'review.changesPanel.revertFile' | transloco }}
            </button>
          </div>
        </div>
        <form method="dialog" class="modal-backdrop">
          <button type="button" (click)="confirming.set(undefined)">
            {{ 'review.changesPanel.closeda388' | transloco }}
          </button>
        </form>
      </dialog>
    }
  `,
})
export class ChangesPanel {
  protected readonly i18n = inject(Language);
  protected readonly review = inject(ChangesStore);
  protected readonly bus = inject(UiStore);
  protected readonly confirming = signal<string | undefined>(undefined);

  protected readonly kind = (status: FileStatus) => changeKindLabels(this.i18n.t)[status];
  protected readonly name = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

  protected pick(event: Event, path: string): void {
    event.preventDefault();
    this.review.open(path);
  }

  protected async revert(path: string): Promise<void> {
    this.confirming.set(undefined);
    await this.review.revert(path);
  }
}
