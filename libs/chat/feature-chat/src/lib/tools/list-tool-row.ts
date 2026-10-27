import { TranslocoPipe } from '@pi-kit/i18n';
import { ChangeDetectionStrategy, Component, computed } from '@angular/core';
import { PkActivityRow } from '@pi-kit/design-system';
import { ToolRowBase } from './tool-row-base';

const MAX_ENTRIES = 200;

/** `grep`, `find` and `ls`: the pattern or folder as target, the number of hits as stat, a compact list when expanded. */
@Component({
  selector: 'pk-list-tool-row',
  imports: [PkActivityRow, TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'contents' },
  template: `
    <pk-activity-row
      [tool]="name()"
      [state]="state()"
      [target]="target()"
      [sub]="sub()"
      [expandable]="entries().length > 0"
      [(expanded)]="open"
    >
      <span stat>{{ stat() }}</span>
      @if (open() && entries().length > 0) {
        <div class="pk-out files">
          <pre>@for (entry of shown(); track $index) {<span class="block">{{ entry }}</span>}</pre>
          @if (entries().length > shown().length) {
            <div class="meta">
              {{ 'chat.listToolRow.moreNotShown' | transloco: { value1: entries().length - shown().length } }}
            </div>
          }
        </div>
      }
    </pk-activity-row>
  `,
})
export class ListToolRow extends ToolRowBase {
  protected readonly target = computed(() => {
    const pattern = this.str('pattern') ?? this.str('query');
    const path = this.str('path') ?? this.str('directory');
    switch (this.name()) {
      case 'grep':
        return [pattern ? `"${pattern}"` : undefined, path].filter(Boolean).join(this.i18n.t('chat.listToolRow.in'));
      case 'find':
        return [pattern, path].filter(Boolean).join(this.i18n.t('chat.listToolRow.in'));
      default:
        return path ?? '.';
    }
  });
  protected readonly entries = computed(() => {
    const r = this.result();
    if (!r || r.error) return [];
    return r.content.split('\n').filter((line) => line.trim() && !/^\(?(empty|no (matches|files))/i.test(line.trim()));
  });
  protected readonly shown = computed(() => this.entries().slice(0, MAX_ENTRIES));
  protected readonly stat = computed(() => {
    if (this.state() !== 'done') return '';
    const n = this.entries().length;
    const unit = this.name() === 'grep' ? 'match' : this.name() === 'find' ? 'file' : 'entr';
    return unit === 'entr'
      ? `${n} ${n === 1 ? 'entry' : 'entries'}`
      : `${n} ${unit}${n === 1 ? '' : unit === 'match' ? 'es' : 's'}`;
  });
}
