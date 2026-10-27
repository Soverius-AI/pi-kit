import { TranslocoPipe } from '@pi-kit/i18n';
import { ChangeDetectionStrategy, Component, computed } from '@angular/core';
import { PkActivityRow } from '@pi-kit/design-system';
import type { PiActivityContent } from '@pi-kit/protocol';
import { PkDiffViewer, modelFromActivity } from '@pi-kit/ui';
import { ToolRowBase } from './tool-row-base';

/**
 * `edit` and `write`: the path as target, `+N −M` (or the line count of a written file) as stat, and the
 * diff from the `pi.diff` activity when expanded, drawn by the same viewer as review mode in its compact
 * form. An edit opens its diff by default.
 */
@Component({
  selector: 'pk-edit-tool-row',
  imports: [PkActivityRow, PkDiffViewer, TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'contents' },
  template: `
    <pk-activity-row
      [tool]="name()"
      [state]="state()"
      [target]="target()"
      [sub]="sub()"
      [expandable]="hasBody()"
      [expanded]="shown()"
      (expandedChange)="toggled.set($event)"
    >
      <span stat>
        @if (model(); as m) {
          @if (written()) {
            {{ m.added }}
            {{ m.added === 1 ? ('chat.editToolRow.line' | transloco) : ('chat.editToolRow.lines' | transloco) }}
          } @else {
            <span class="text-success">+{{ m.added }}</span
            ><span class="text-error">−{{ m.removed }}</span>
          }
        }
      </span>
      @if (shown() && hasBody()) {
        <div class="pk-out patch">
          @if (model(); as m) {
            <pk-diff [model]="m" [compact]="true" />
          } @else {
            <pre>{{ result()?.content }}</pre>
          }
        </div>
      }
    </pk-activity-row>
  `,
})
export class EditToolRow extends ToolRowBase {
  protected readonly diff = computed(
    () => this.session.activities().get(`diff:${this.callId()}`)?.content as PiActivityContent<'pi.diff'> | undefined,
  );
  protected readonly model = computed(() => {
    const diff = this.diff();
    return diff ? modelFromActivity(diff) : undefined;
  });
  protected readonly target = computed(() => this.diff()?.path ?? this.str('path') ?? this.str('file_path') ?? '');
  protected readonly written = computed(() => this.diff()?.written === true);
  protected readonly hasBody = computed(() => !!this.diff() || (this.state() === 'error' && !!this.result()?.content));
  protected readonly shown = computed(() => this.toggled() ?? (this.name() === 'edit' || this.state() === 'error'));
}
