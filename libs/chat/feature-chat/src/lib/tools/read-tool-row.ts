import { TranslocoPipe } from '@pi-kit/i18n';
import { ChangeDetectionStrategy, Component, computed } from '@angular/core';
import { PkActivityRow } from '@pi-kit/design-system';
import { highlight, languageOf } from '@pi-kit/chat/ui';
import { ToolRowBase, lineCount } from './tool-row-base';

const MAX_LINES = 300;

/** `read`: the path as target, the line count as stat, the file (highlighted by its extension) when expanded. */
@Component({
  selector: 'pk-read-tool-row',
  imports: [PkActivityRow, TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'contents' },
  template: `
    <pk-activity-row
      tool="read"
      [state]="state()"
      [target]="target()"
      [sub]="sub()"
      [expandable]="!!result()"
      [(expanded)]="open"
    >
      <span stat>{{ stat() }}</span>
      @if (open() && result()) {
        <div class="pk-out files">
          <pre><code class="hljs" [innerHTML]="body()"></code></pre>
          @if (omitted() > 0) {
            <div class="meta">{{ 'chat.readToolRow.moreLinesNotShown' | transloco: { value1: omitted() } }}</div>
          }
        </div>
      }
    </pk-activity-row>
  `,
})
export class ReadToolRow extends ToolRowBase {
  protected readonly target = computed(() => {
    const path = this.str('path') ?? this.str('file_path') ?? '';
    const offset = this.args()['offset'];
    const limit = this.args()['limit'];
    return typeof offset === 'number'
      ? `${path}:${offset}${typeof limit === 'number' ? `-${offset + limit}` : ''}`
      : path;
  });
  protected readonly stat = computed(() => {
    const r = this.result();
    if (!r || r.error) return '';
    const n = lineCount(r.content);
    return `${n} ${n === 1 ? 'line' : 'lines'}`;
  });
  private readonly lines = computed(() => (this.result()?.content ?? '').split('\n'));
  protected readonly omitted = computed(() => Math.max(0, this.lines().length - MAX_LINES));
  protected readonly body = computed(
    () => highlight(this.lines().slice(0, MAX_LINES).join('\n'), languageOf(this.str('path'))).html,
  );
}
