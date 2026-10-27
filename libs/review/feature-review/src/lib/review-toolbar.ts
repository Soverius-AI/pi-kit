import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { TranslocoPipe } from '@pi-kit/i18n';
import { ChangesStore } from '@pi-kit/review/data';
import type { ChangeSource } from '@pi-kit/protocol';

/** Review navigation stays visible while the code scrolls; full paths remain available in the file picker. */
@Component({
  selector: 'pk-review-toolbar',
  imports: [TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'pk-review-toolbar' },
  template: `
    <select
      class="select select-sm pk-review-source"
      [attr.aria-label]="'review.changesPanel.source' | transloco"
      [value]="review.source()"
      (change)="source($event)"
    >
      <option value="thread">{{ 'review.changesPanel.thisThread' | transloco }}</option>
      <option value="worktree">{{ 'review.changesPanel.workingTree' | transloco }}</option>
      <option value="outcome" [disabled]="!review.hasOutcome()">{{ 'review.changesPanel.outcome' | transloco }}</option>
    </select>
    <div class="pk-review-navigation">
      <select
        class="select select-sm pk-review-file"
        [attr.aria-label]="'shell.app.changedFiles' | transloco"
        [title]="review.selectedId() ?? ''"
        [value]="review.selectedId() ?? ''"
        [disabled]="!review.files().length"
        (change)="select($event)"
      >
        @if (!review.selectedId()) {
          <option value="">{{ 'shell.app.changedFiles' | transloco }}</option>
        }
        @for (file of review.files(); track file.path; let i = $index) {
          <option [value]="file.path">{{ i + 1 }}. {{ file.path }}</option>
        }
      </select>
      <button
        type="button"
        class="btn btn-ghost btn-sm btn-square"
        [attr.aria-label]="'review.toolbar.previousFile' | transloco"
        [title]="'review.toolbar.previousFile' | transloco"
        [disabled]="review.selectedIndex() <= 0"
        (click)="move(-1)"
      >
        ‹
      </button>
      <button
        type="button"
        class="btn btn-ghost btn-sm btn-square"
        [attr.aria-label]="'review.toolbar.nextFile' | transloco"
        [title]="'review.toolbar.nextFile' | transloco"
        [disabled]="review.selectedIndex() < 0 || review.selectedIndex() >= review.files().length - 1"
        (click)="move(1)"
      >
        ›
      </button>
    </div>
    <span class="pk-review-progress muted t-xs" [title]="review.summary()">
      {{ 'shell.app.ofViewed' | transloco: { value1: review.viewedCount(), value2: review.files().length } }}
    </span>
    <div class="pk-seg pk-seg-xs pk-review-layout" role="group" [attr.aria-label]="'shell.app.diffLayout' | transloco">
      <button type="button" [attr.aria-pressed]="review.layout() === 'unified'" (click)="review.setLayout('unified')">
        {{ 'shell.app.unified' | transloco }}
      </button>
      <button type="button" [attr.aria-pressed]="review.layout() === 'split'" (click)="review.setLayout('split')">
        {{ 'shell.app.split' | transloco }}
      </button>
    </div>
  `,
})
export class ReviewToolbar {
  protected readonly review = inject(ChangesStore);

  protected source(event: Event): void {
    this.review.setSource((event.target as HTMLSelectElement).value as ChangeSource);
  }

  protected select(event: Event): void {
    this.review.select((event.target as HTMLSelectElement).value);
  }

  protected move(offset: number): void {
    const file = this.review.files()[this.review.selectedIndex() + offset];
    if (file) this.review.select(file.path);
  }
}
