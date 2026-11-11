import { Component, input, signal } from '@angular/core';
import { type PkActivityState, PkActivityRow } from './activity-row';
import { PkToolOutput } from './tool-output';

export interface PkToolListItem {
  id: string;
  name: string;
  state: PkActivityState;
  target?: string;
  sub?: string;
  stat?: string;
  output?: string;
  note?: string;
  children?: readonly PkToolListItem[];
}

@Component({
  selector: 'pk-tool-list',
  imports: [PkActivityRow, PkToolOutput],
  host: {
    class: 'pk-activity',
    'data-testid': 'tool-list',
    '[attr.data-nested]': 'nested() || null',
    '[style.margin-inline-start.px]': 'nested() ? 18 : null',
  },
  template: `
    @for (item of items(); track item.id) {
      <pk-activity-row
        [attr.data-call]="item.id"
        [state]="item.state"
        [tool]="item.name"
        [target]="item.target"
        [sub]="item.sub"
        [expandable]="nested() && !!item.output"
        [expanded]="opened().has(item.id)"
        (expandedChange)="toggle(item.id, $event)"
      >
        <span stat>{{ item.stat }}</span>
        @if (item.output && (!nested() || opened().has(item.id))) {
          <pk-tool-output [text]="item.output" [note]="item.note" [live]="item.state === 'running'" />
        }
        @if (item.children?.length) {
          <pk-tool-list [items]="item.children ?? []" [nested]="true" />
        }
      </pk-activity-row>
    }
  `,
})
export class PkToolList {
  readonly items = input.required<readonly PkToolListItem[]>();
  readonly nested = input(false);
  protected readonly opened = signal<ReadonlySet<string>>(new Set());

  protected toggle(id: string, open: boolean): void {
    this.opened.update((ids) => {
      const next = new Set(ids);
      if (open) next.add(id);
      else next.delete(id);
      return next;
    });
  }
}
