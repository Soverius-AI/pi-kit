import { ChangeDetectionStrategy, Component, input, model } from '@angular/core';

export type PkActivityState = 'running' | 'done' | 'error';

/**
 * One row of the activity list (doc/docs/design-system.md, "Activity list"): status dot, tool name, target in
 * mono and a trailing stat or action. A running row adds the live sub-line under it. When `expandable`, the
 * row toggles `expanded` (click, Enter or Space) and the parent renders the output block as projected
 * content with `@if (expanded)`, so nothing is built for a closed row.
 *
 * Slots: the default slot is the output (`.pk-out`), `[stat]` the trailing stat, `[actions]` buttons that
 * sit where the stat is (a Stop button on a running bash call). The host is `display: contents`, so the
 * row and its output are direct flex children of `.pk-activity`.
 */
@Component({
  selector: 'pk-activity-row',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'contents' },
  template: `
    <div
      class="pk-row"
      [attr.data-state]="state()"
      [attr.role]="expandable() ? 'button' : null"
      [attr.tabindex]="expandable() ? 0 : null"
      [attr.aria-expanded]="expandable() ? expanded() : null"
      (click)="onClick($event)"
      (keydown.enter)="onKey($event)"
      (keydown.space)="onKey($event)"
    >
      <span class="dot" aria-hidden="true"></span>
      <span class="tool">{{ tool() }}</span>
      <code class="target" [title]="target() ?? ''">{{ target() }}</code>
      <span class="stat"><ng-content select="[stat]" /><ng-content select="[actions]" /></span>
      @if (sub()) {
        <span class="sub">{{ sub() }}</span>
      }
    </div>
    <ng-content />
  `,
})
export class PkActivityRow {
  readonly state = input<PkActivityState>('done');
  readonly tool = input.required<string>();
  readonly target = input<string | undefined>(undefined);
  readonly sub = input<string | undefined>(undefined);
  readonly expandable = input(false);
  readonly expanded = model(false);
  protected onClick(event: Event): void {
    // A button inside the row (Stop) acts on its own.
    if ((event.target as HTMLElement).closest('button, a, input')) return;
    this.flip(event);
  }

  protected onKey(event: Event): void {
    if (event.target === event.currentTarget) this.flip(event);
  }

  private flip(event: Event): void {
    if (!this.expandable()) return;
    event.preventDefault();
    this.expanded.update((v) => !v);
  }
}
