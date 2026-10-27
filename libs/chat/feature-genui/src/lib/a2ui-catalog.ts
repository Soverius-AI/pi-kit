import { Language } from '@pi-kit/i18n';
import { TranslocoPipe } from '@pi-kit/i18n';
import { ChangeDetectionStrategy, Component, Directive, computed, inject, input } from '@angular/core';
import { CopilotA2UIActivityRenderer } from '@copilotkit/angular';
import {
  CopilotA2UIChild,
  DynamicStringSchema,
  createAngularCatalog,
  injectA2UIComponentContext,
  type A2UICatalogDefinitions,
} from '@copilotkit/angular/a2ui';
import { DynamicValueSchema } from '@a2ui/web_core/v0_9';
import { CardApi, ColumnApi, RowApi } from '@a2ui/web_core/v0_9/basic_catalog';
import { PkGenUiFrame, PkTurn } from '@pi-kit/design-system';
import { a2uiCardHeader } from '@pi-kit/chat/util';
import { z } from 'zod';
import { PkGenUiTurn } from './genui-turn';

/**
 * pi-kit's A2UI catalog (cut down). It is CopilotKit's own basic catalog (`includeBasicCatalog`: Text, Image,
 * Icon, Video, AudioPlayer, List, Tabs, Divider, Modal, Button, TextField, CheckBox, ChoicePicker, Slider, DateTimeInput), themed by the
 * `--a2ui-*` variables that `.pk-a2ui` maps to our tokens in `components.css`, plus what the generated UI needs and the basic catalog
 * lacks or draws differently:
 *
 * - `Card`: the root card is the frame of the surface in the transcript: a 36px bar with its `title`, `badge` and
 *   `badgeTone`, the label that says where the UI comes from ("Rendered from A2UI"), the turn attributes, and the surface under it.
 *   Cards that are not the root are plain bordered boxes;
 * - `Row` and `Column`: the basic layout with `inset`, see below;
 * - `Badge` and `Table`: not in the basic catalog.
 *
 * The catalog keeps the basic catalog's id: a payload written for the basic catalog renders here. Angular components render in the
 * light DOM of the frame as ordinary markup, so daisyUI, Tailwind and the token CSS apply as they do anywhere else; Tailwind finds the
 * class names below because this file is a source of the renderer's stylesheet.
 *
 * Extensions of the basic schemas, all optional:
 * - `Card.title`, `Card.badge`, `Card.badgeTone`: the frame's bar;
 * - `Row.inset`, `Column.inset`: pad the container (12px; a column also spaces its children 12px apart). Layout components are
 *   flush by default, a column stacks its children edge to edge, so that a `Table`, a `Divider` and a padded footer row compose.
 */

export const A2UI_CATALOG_ID = 'https://a2ui.org/specification/v0_9/basic_catalog.json';

type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'error' | 'primary';
const TONES = ['neutral', 'info', 'success', 'warning', 'error', 'primary'] as const;
const ToneSchema = z.enum(TONES);

/** Literal class names, so Tailwind's scanner sees every one of them. */
const BADGE: Record<Tone, string> = {
  neutral: 'badge-neutral',
  info: 'badge-info',
  success: 'badge-success',
  warning: 'badge-warning',
  error: 'badge-error',
  primary: 'badge-primary',
};
const JUSTIFY: Record<string, string> = {
  start: 'justify-start',
  center: 'justify-center',
  end: 'justify-end',
  spaceBetween: 'justify-between',
  spaceAround: 'justify-around',
  spaceEvenly: 'justify-evenly',
  stretch: 'justify-stretch',
};
const ALIGN: Record<string, string> = {
  start: 'items-start',
  center: 'items-center',
  end: 'items-end',
  stretch: 'items-stretch',
};

const str = (value: unknown): string => (value === undefined || value === null ? '' : String(value));

const InsetSchema = z.boolean().optional();
const TableColumnSchema = z
  .object({
    /** The key of the row object this column shows. */
    key: z.string(),
    label: z.string(),
    kind: z.enum(['text', 'code', 'badge', 'action']).optional(),
    align: z.enum(['start', 'end']).optional(),
    /** `badge` columns: the badge's tone. */
    tone: ToneSchema.optional(),
    /** `action` columns: the button's label and the name of the event it sends. The row's fields are its context. */
    actionLabel: z.string().optional(),
    event: z.string().optional(),
  })
  .strict();
type TableColumn = z.infer<typeof TableColumnSchema>;

/**
 * The catalog and SDK share Zod 4. The heterogeneous base component shapes remain loosely typed here
 * to avoid expanding every catalog schema into one enormous inferred union.
 */
type Schema = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const extend = (base: Schema, shape: Record<string, Schema>): Schema => base.extend(shape);
const object = (shape: Record<string, Schema>): Schema => z.object(shape).strict();

const definitions: Record<string, { props: Schema }> = {
  Row: { props: extend(RowApi.schema, { inset: InsetSchema }) },
  Column: { props: extend(ColumnApi.schema, { inset: InsetSchema }) },
  Card: {
    props: extend(CardApi.schema, {
      title: z.string().optional(),
      badge: z.string().optional(),
      badgeTone: ToneSchema.optional(),
    }),
  },
  Badge: { props: object({ text: DynamicStringSchema, tone: ToneSchema.optional() }) },
  Table: {
    props: object({
      columns: z.array(TableColumnSchema).min(1),
      /** An array of row objects, or a path to one in the data model. */
      rows: DynamicValueSchema,
    }),
  },
};

/** What the binder hands a component: resolved dynamic values, `set*` setters, callable actions, child references. */
interface Props {
  weight?: number;
  [key: string]: any; // eslint-disable-line @typescript-eslint/no-explicit-any -- the shape depends on the component's schema
}
interface ChildRef {
  id: string;
  basePath?: string;
}

/** The props input every catalog component has, and A2UI's `weight` as the flex grow factor of the component's own box. */
@Directive()
abstract class PkA2uiComponent {
  readonly props = input.required<Props>();
  protected readonly children = computed<ChildRef[]>(() => {
    const children = this.props()['children'];
    return Array.isArray(children) ? (children as ChildRef[]) : [];
  });
}

// ---- layout with `inset`

@Component({
  selector: 'pk-a2ui-row',
  imports: [CopilotA2UIChild],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '[style.flex]': 'props().weight ?? null' },
  template: `
    <div class="flex flex-row gap-3 w-full" [class]="classes()">
      @for (child of children(); track $index) {
        <copilot-a2ui-child [child]="child" />
      }
    </div>
  `,
})
class PkA2uiRow extends PkA2uiComponent {
  protected readonly classes = computed(
    () =>
      `${JUSTIFY[this.props()['justify'] ?? 'start']} ${ALIGN[this.props()['align'] ?? 'stretch']} ${this.props()['inset'] ? 'p-3' : ''}`,
  );
}

@Component({
  selector: 'pk-a2ui-column',
  imports: [CopilotA2UIChild],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '[style.flex]': 'props().weight ?? null' },
  template: `
    <div class="flex flex-col w-full" [class]="classes()">
      @for (child of children(); track $index) {
        <copilot-a2ui-child [child]="child" />
      }
    </div>
  `,
})
class PkA2uiColumn extends PkA2uiComponent {
  protected readonly classes = computed(
    () =>
      `${JUSTIFY[this.props()['justify'] ?? 'start']} ${ALIGN[this.props()['align'] ?? 'stretch']} ${this.props()['inset'] ? 'p-3 gap-3' : ''}`,
  );
}

// ---- Card: the frame of the surface when it is the root

@Component({
  selector: 'pk-a2ui-card',
  imports: [CopilotA2UIChild, PkGenUiFrame, PkTurn, PkGenUiTurn, TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  // CopilotKit lays a surface out in a flex row, where a custom element is as wide as its content; the frame is as wide as the answer.
  host: { class: 'block w-full min-w-0', '[style.flex]': 'props().weight ?? null' },
  template: `
    @if (isRoot) {
      <!-- The root card is the surface itself: its box is the frame of the surface, in a turn of its own like every piece of an answer. -->
      <pk-turn role="pi" [pkGenUiTurn]="messageId()">
        <pk-genui-frame
          class="pk-a2ui"
          [title]="header().title"
          [badge]="header().badge"
          [badgeTone]="header().tone"
          [label]="'chat.a2uiCatalog.renderedFromA2UI' | transloco"
        >
          <copilot-a2ui-child [child]="props()['child']" />
        </pk-genui-frame>
      </pk-turn>
    } @else {
      <div class="w-full rounded-box border border-base-300 bg-base-100">
        @if (props()['title'] || props()['badge']) {
          <div class="flex items-center gap-2 px-3 h-9 border-b border-base-300 text-sm">
            <span class="font-medium">{{ props()['title'] ?? '' }}</span>
            @if (props()['badge']) {
              <span class="badge badge-sm" [class]="badgeClass()">{{ props()['badge'] }}</span>
            }
          </div>
        }
        <copilot-a2ui-child [child]="props()['child']" />
      </div>
    }
  `,
})
class PkA2uiCard extends PkA2uiComponent {
  protected readonly i18n = inject(Language);
  protected readonly isRoot = injectA2UIComponentContext().componentId === 'root';
  /** CopilotKit's activity renderer (a surface in the transcript) is an ancestor; its message is the activity the frame belongs to. */
  private readonly renderer = inject(CopilotA2UIActivityRenderer, { optional: true });
  protected readonly messageId = computed(() => this.renderer?.message()?.id);
  protected readonly header = computed(() => a2uiCardHeader(this.i18n.t, this.props()));
  protected readonly badgeClass = computed(() => BADGE[(this.props()['badgeTone'] as Tone | undefined) ?? 'neutral']);
}

// ---- Badge and Table, new

@Component({
  selector: 'pk-a2ui-badge',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<span class="badge badge-sm" [class]="tone()">{{ str(props()['text']) }}</span>`,
})
class PkA2uiBadge extends PkA2uiComponent {
  protected readonly str = str;
  protected readonly tone = computed(() => BADGE[(this.props()['tone'] as Tone | undefined) ?? 'neutral']);
}

@Component({
  selector: 'pk-a2ui-table',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="w-full overflow-x-auto">
      <table class="table table-sm">
        <thead>
          <tr>
            @for (column of columns(); track column.key) {
              <th [class.text-right]="column.align === 'end'">{{ column.label }}</th>
            }
          </tr>
        </thead>
        <tbody>
          @for (row of rows(); track $index) {
            <tr>
              @for (column of columns(); track column.key) {
                <td [class.text-right]="column.align === 'end'">
                  @switch (column.kind) {
                    @case ('code') {
                      <code>{{ str(row[column.key]) }}</code>
                    }
                    @case ('badge') {
                      <span class="badge badge-sm" [class]="badge(column)">{{ str(row[column.key]) }}</span>
                    }
                    @case ('action') {
                      <button type="button" class="btn btn-xs" (click)="act(column, row)">
                        {{ column.actionLabel ?? column.label }}
                      </button>
                    }
                    @default {
                      <span class="text-sm">{{ str(row[column.key]) }}</span>
                    }
                  }
                </td>
              }
            </tr>
          }
        </tbody>
      </table>
    </div>
  `,
})
class PkA2uiTable extends PkA2uiComponent {
  private readonly context = injectA2UIComponentContext();
  protected readonly str = str;
  protected readonly columns = computed(() => (this.props()['columns'] ?? []) as TableColumn[]);
  protected readonly rows = computed(
    () => (Array.isArray(this.props()['rows']) ? this.props()['rows'] : []) as Record<string, unknown>[],
  );
  protected badge(column: TableColumn): string {
    return BADGE[column.tone ?? 'neutral'];
  }
  protected act(column: TableColumn, row: Record<string, unknown>): void {
    void this.context.dispatch({
      event: { name: column.event ?? 'row_action', context: { ...row, column: column.key } },
    });
  }
}

/** The catalog the renderer gives CopilotKit (`provideCopilotKit({ a2ui: { catalog } })`). */
export const piKitA2uiCatalog = createAngularCatalog(
  definitions as A2UICatalogDefinitions,
  { Row: PkA2uiRow, Column: PkA2uiColumn, Card: PkA2uiCard, Badge: PkA2uiBadge, Table: PkA2uiTable },
  { catalogId: A2UI_CATALOG_ID, includeBasicCatalog: true },
);
