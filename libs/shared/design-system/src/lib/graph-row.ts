import { inject } from '@angular/core';
import { Language } from '@pi-kit/i18n';
import { TranslocoPipe } from '@pi-kit/i18n';
import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { type PkGraphNode, graphCell } from './graph-geometry';

export type PkGraphActionId = 'go' | 'edit' | 'fork' | 'label' | 'more';

export interface PkGraphActionEvent {
  id: PkGraphActionId;
  /** The button that was pressed, for placing a menu next to it. */
  anchor: HTMLElement;
}

/** What `pk-graph-row` draws; `GraphItem` of `@pi-kit/session-tree/util` satisfies it. */
export interface PkGraphRowData {
  type: 'row' | 'group' | 'band';
  node: PkGraphNode;
  side: boolean;
  number: string;
  title: string;
  titleParts: readonly { text: string; hit: boolean }[];
  label?: string;
  tools: readonly { name: string; target?: string }[];
  tail: string;
  summary?: string;
  chevron?: '▸' | '▾';
  time: string;
  timeTitle?: string;
  dim: boolean;
  current: boolean;
  actions: { go: boolean; edit: boolean; fork: boolean; label: boolean; more: boolean };
}

/**
 * One row of the session graph v2 (doc/docs/design-system.md "Session graph"): a lane cell with
 * one inline SVG (lane lines, fork curves, the node and its context ring), a two-line body (title: turn number, first sentence,
 * label pill; sub: the turn's tool calls in 500 weight, then the model if it changed and the tokens) and the time, which on hover or
 * selection gives way to the inline actions. A compaction is a 28px band. Stateless: the parent decides what the events mean.
 * Put it inside a `.pk-graph` list.
 */
@Component({
  imports: [TranslocoPipe],
  selector: 'pk-graph-row',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    role: 'option',
    '[class.row]': 'row().type !== "band"',
    '[class.band]': 'row().type === "band"',
    '[class.group]': 'row().type === "group" || !!row().chevron',
    '[class.side]': 'row().side',
    '[attr.aria-selected]': 'selected()',
    '[attr.aria-current]': 'row().current ? "true" : null',
    '[attr.aria-label]': 'ariaLabel()',
    '[attr.aria-expanded]': 'row().chevron ? row().chevron === "▾" : null',
    '(click)': 'picked.emit()',
    '(dblclick)': 'activated.emit()',
    '(mouseenter)': 'hovered.emit(true)',
    '(mouseleave)': 'hovered.emit(false)',
  },
  template: `
    <svg
      [attr.viewBox]="'0 0 ' + cell().width + ' ' + cell().height"
      [attr.width]="cell().width"
      [attr.height]="cell().height"
      aria-hidden="true"
    >
      @for (path of cell().paths; track $index) {
        <path class="l" [class.on]="path.on" [attr.d]="path.d" [attr.stroke-dasharray]="path.dashed ? '2 3' : null" />
      }
      @if (cell().glyph.shape === 'square') {
        <rect
          [class]="'c ' + cell().glyph.classes"
          [attr.x]="cell().glyph.x"
          [attr.y]="cell().glyph.y"
          [attr.width]="cell().glyph.size"
          [attr.height]="cell().glyph.size"
          rx="2"
        />
      } @else {
        <circle
          [class]="'c ' + cell().glyph.classes"
          [attr.cx]="cell().glyph.x"
          [attr.cy]="cell().glyph.y"
          [attr.r]="cell().glyph.size"
        />
      }
      @if (cell().ring; as ring) {
        <circle
          class="g"
          [class.warn]="ring.level === 'warn'"
          [class.hot]="ring.level === 'hot'"
          [attr.cx]="ring.cx"
          [attr.cy]="ring.cy"
          [attr.r]="ring.r"
          pathLength="100"
          [attr.stroke-dasharray]="ring.pct + ' 100'"
        />
      }
    </svg>
    @if (row().type === 'band') {
      <div class="txt">{{ row().title }}</div>
    } @else {
      <div class="body">
        <div class="title">
          @if (row().chevron; as chevron) {
            <span class="chev" aria-hidden="true">{{ chevron }}</span>
          } @else {
            <span class="n">{{ row().number }}</span>
          }
          <span class="tx" [class.muted]="row().dim" [class.font-medium]="row().current">
            @for (part of row().titleParts; track $index) {
              @if (part.hit) {
                <mark>{{ part.text }}</mark>
              } @else {
                <span>{{ part.text }}</span>
              }
            }
          </span>
          @if (row().label) {
            <span class="tag">{{ row().label }}</span>
          }
        </div>
        @if (row().summary || row().tools.length > 0 || row().tail) {
          <div class="sub" [class.in-group]="!!row().chevron">
            @if (row().summary; as summary) {
              {{ summary }}
            } @else {
              @for (tool of row().tools; track $index; let last = $last) {
                <span
                  ><b>{{ tool.name }}</b
                  >{{ tool.target ? ' ' + tool.target : '' }}{{ !last || row().tail ? ', ' : '' }}</span
                >
              }
              <span>{{ row().tail }}</span>
            }
          </div>
        }
      </div>
      <span class="meta" [class.text-primary]="row().current" [attr.title]="row().timeTitle ?? null">{{
        row().time
      }}</span>
      <div class="acts" role="group" [attr.aria-label]="'shared.graphRow.actionsForThisTurn' | transloco">
        @if (row().actions.go) {
          <button
            type="button"
            class="go"
            [title]="'shared.graphRow.goHere' | transloco"
            [attr.aria-label]="'shared.graphRow.goHere' | transloco"
            (click)="act('go', $event)"
          >
            ⤴
          </button>
        }
        @if (row().actions.edit) {
          <button
            type="button"
            [title]="'shared.graphRow.editAndBranch' | transloco"
            [attr.aria-label]="'shared.graphRow.editAndBranch' | transloco"
            (click)="act('edit', $event)"
          >
            ⎇
          </button>
        }
        @if (row().actions.fork) {
          <button
            type="button"
            [title]="'shared.graphRow.forkToNewThread' | transloco"
            [attr.aria-label]="'shared.graphRow.forkToNewThread' | transloco"
            (click)="act('fork', $event)"
          >
            ⧉
          </button>
        }
        @if (row().actions.label) {
          <button
            type="button"
            [title]="'shared.graphRow.label' | transloco"
            [attr.aria-label]="'shared.graphRow.label' | transloco"
            (click)="act('label', $event)"
          >
            ◇
          </button>
        }
        @if (row().actions.more) {
          <button
            type="button"
            [title]="'shared.graphRow.more' | transloco"
            [attr.aria-label]="'shared.graphRow.more' | transloco"
            aria-haspopup="menu"
            (click)="act('more', $event)"
          >
            …
          </button>
        }
      </div>
    }
  `,
})
export class PkGraphRow {
  protected readonly i18n = inject(Language);
  readonly row = input.required<PkGraphRowData>();
  /** Width of the lane cell in lanes; every row of a list passes the same value. */
  readonly lanes = input(2);
  readonly selected = input(false);
  readonly picked = output<void>();
  readonly activated = output<void>();
  readonly hovered = output<boolean>();
  readonly action = output<PkGraphActionEvent>();

  protected readonly cell = computed(() => graphCell(this.row().node, this.lanes()));
  protected readonly ariaLabel = computed(() => {
    const row = this.row();
    return [
      row.number && this.i18n.t('shared.graphRow.turn', { value1: row.number }),
      row.title,
      row.label && this.i18n.t('shared.graphRow.labelSummary', { value1: row.label }),
      row.current && this.i18n.t('shared.graphRow.current'),
    ]
      .filter(Boolean)
      .join(', ');
  });

  protected act(id: PkGraphActionId, event: MouseEvent): void {
    event.stopPropagation();
    this.action.emit({ id, anchor: event.currentTarget as HTMLElement });
  }
}
