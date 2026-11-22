import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { TranslocoPipe } from '@pi-kit/i18n';
import { PkIcon } from './icon';
import type { PkIconName } from './icon-names';

export const PK_ENV_ICONS = ['runner', 'neko', 'drone', 'mech', 'katana', 'skull', 'glitch', 'spinner', 'oni'] as const;
export type PkEnvIcon = (typeof PK_ENV_ICONS)[number];
/** The same shape as the protocol's `EnvironmentLook`; the design system does not import the protocol. */
export interface PkEnvLook {
  icon: PkEnvIcon;
  color: number;
}
export const PK_ENV_COLORS = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const;

/** An environment's icon on its chamfered identity tile; decoration beside the name, never the name itself. */
@Component({
  selector: 'pk-env-glyph',
  imports: [PkIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'pk-env-glyph',
    'aria-hidden': 'true',
    '[attr.data-size]': 'size()',
    '[attr.data-icon]': 'look().icon',
    '[style.--pk-env-color]': '"var(--pk-identity-" + look().color + ")"',
  },
  template: `<pk-icon [name]="iconName()" [size]="iconSize()" />`,
})
export class PkEnvGlyph {
  readonly look = input.required<PkEnvLook>();
  readonly size = input<14 | 22 | 56>(14);
  protected readonly iconName = computed(() => `env-${this.look().icon}` as PkIconName);
  protected readonly iconSize = computed(() => Math.round(this.size() * 0.72));
}

export interface PkEnvLookOption {
  id: string;
  name: string;
  look: PkEnvLook;
  /** False when this window cannot save the look (an unreachable machine, a paired device). */
  editable: boolean;
  online: boolean;
}

@Component({
  selector: 'pk-env-look-picker',
  imports: [PkEnvGlyph, PkIcon, TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="pk-wf pk-env-look" data-testid="env-look-picker">
      <button
        type="button"
        class="pk-backdrop"
        tabindex="-1"
        [attr.aria-label]="'shared.envLook.close' | transloco"
        (click)="closed.emit()"
      ></button>
      <div
        #win
        class="win"
        role="dialog"
        aria-modal="true"
        [attr.aria-label]="'shared.envLook.title' | transloco"
        tabindex="-1"
        (keydown.escape)="$event.preventDefault(); $event.stopPropagation(); closed.emit()"
      >
        <div class="head">
          <h2>{{ 'shared.envLook.title' | transloco }}</h2>
          <button
            type="button"
            class="pk-close ml-auto"
            [attr.aria-label]="'shared.envLook.close' | transloco"
            (click)="closed.emit()"
          >
            <pk-icon name="close" />
          </button>
        </div>
        <div class="body">
          @if (environments().length > 1) {
            <div class="tabs" role="tablist">
              @for (env of environments(); track env.id) {
                <button
                  type="button"
                  role="tab"
                  [attr.data-testid]="'env-look-tab-' + env.id"
                  [attr.aria-selected]="env.id === current()?.id"
                  [disabled]="!env.online"
                  (click)="tab.set(env.id)"
                >
                  <pk-env-glyph [look]="env.id === current()?.id ? look() : env.look" />{{ env.name }}
                </button>
              }
            </div>
          }
          <fieldset [disabled]="!current()?.editable">
            <legend>{{ 'shared.envLook.icon' | transloco }}</legend>
            <div class="icons" role="radiogroup" [attr.aria-label]="'shared.envLook.icon' | transloco">
              @for (icon of icons; track icon; let i = $index) {
                <button
                  type="button"
                  role="radio"
                  [attr.data-testid]="'env-look-icon-' + icon"
                  [attr.aria-checked]="look().icon === icon"
                  [attr.aria-label]="'shared.envLook.icons.' + icon | transloco"
                  [attr.tabindex]="look().icon === icon ? 0 : -1"
                  (click)="icon$.set(icon)"
                  (keydown)="move($event, i, 'icon')"
                >
                  <pk-env-glyph [look]="{ icon, color: look().color }" [size]="22" />
                </button>
              }
            </div>
          </fieldset>
          <fieldset [disabled]="!current()?.editable">
            <legend>{{ 'shared.envLook.color' | transloco }}</legend>
            <div class="swatches" role="radiogroup" [attr.aria-label]="'shared.envLook.color' | transloco">
              @for (color of colors; track color; let i = $index) {
                <button
                  type="button"
                  role="radio"
                  [attr.data-testid]="'env-look-color-' + color"
                  [attr.aria-checked]="look().color === color"
                  [attr.aria-label]="'shared.envLook.colors.' + color | transloco"
                  [attr.tabindex]="look().color === color ? 0 : -1"
                  [style.--pk-env-color]="'var(--pk-identity-' + color + ')'"
                  (click)="color$.set(color)"
                  (keydown)="move($event, i, 'color')"
                ></button>
              }
            </div>
          </fieldset>
          <div class="preview" [attr.aria-label]="'shared.envLook.preview' | transloco">
            <pk-env-glyph [look]="look()" [size]="56" />
            <span class="byline"
              ><pk-env-glyph [look]="look()" />{{ current()?.name }} ·
              {{ 'shared.envLook.previewLine' | transloco }}</span
            >
          </div>
          @if (duplicate(); as other) {
            <p class="hint warn" role="status" data-testid="env-look-duplicate">
              {{ 'shared.envLook.duplicate' | transloco: { value1: other } }}
            </p>
          }
          @if (current(); as env) {
            @if (!env.editable) {
              <p class="hint" data-testid="env-look-elsewhere">
                {{ 'shared.envLook.elsewhere' | transloco: { value1: env.name } }}
              </p>
            }
          }
        </div>
        <div class="foot">
          <button type="button" class="btn btn-sm btn-ghost" (click)="closed.emit()">
            {{ 'shared.envLook.cancel' | transloco }}
          </button>
          <button
            type="button"
            class="btn btn-sm btn-primary"
            data-testid="env-look-save"
            [disabled]="!canSave()"
            (click)="save()"
          >
            {{ 'shared.envLook.save' | transloco }}
          </button>
        </div>
      </div>
    </div>
  `,
})
export class PkEnvLookPicker {
  readonly environments = input.required<readonly PkEnvLookOption[]>();
  readonly selected = input<string>();
  readonly saved = output<{ id: string; look: PkEnvLook }>();
  readonly closed = output<void>();

  protected readonly icons = PK_ENV_ICONS;
  protected readonly colors = PK_ENV_COLORS;
  protected readonly tab = signal<string | undefined>(undefined);
  protected readonly icon$ = signal<PkEnvIcon | undefined>(undefined);
  protected readonly color$ = signal<number | undefined>(undefined);
  protected readonly current = computed(() => {
    const id = this.tab() ?? this.selected();
    return this.environments().find((env) => env.id === id) ?? this.environments().find((env) => env.editable);
  });
  protected readonly look = computed<PkEnvLook>(() => {
    const base = this.current()?.look ?? { icon: 'runner', color: 1 };
    return { icon: this.icon$() ?? base.icon, color: this.color$() ?? base.color };
  });
  protected readonly duplicate = computed(() => {
    const { icon, color } = this.look();
    const current = this.current()?.id;
    return this.environments().find((env) => env.id !== current && env.look.icon === icon && env.look.color === color)
      ?.name;
  });
  protected readonly canSave = computed(() => {
    const env = this.current();
    return !!env?.editable && (env.look.icon !== this.look().icon || env.look.color !== this.look().color);
  });
  private readonly win = viewChild<ElementRef<HTMLElement>>('win');

  constructor() {
    const injector = inject(Injector);
    afterNextRender(() => this.win()?.nativeElement.focus(), { injector });
    effect(() => {
      this.current();
      untracked(() => {
        this.icon$.set(undefined);
        this.color$.set(undefined);
      });
    });
  }

  /** Arrow keys move the choice within a radio group, as native radios do. */
  protected move(event: KeyboardEvent, index: number, group: 'icon' | 'color'): void {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (step === undefined) return;
    event.preventDefault();
    const next = (index + step + 9) % 9;
    if (group === 'icon') this.icon$.set(PK_ENV_ICONS[next]);
    else this.color$.set(PK_ENV_COLORS[next]);
    const buttons = (event.currentTarget as HTMLElement).parentElement?.children;
    queueMicrotask(() => (buttons?.[next] as HTMLElement | undefined)?.focus());
  }

  protected save(): void {
    const env = this.current();
    if (env && this.canSave()) this.saved.emit({ id: env.id, look: this.look() });
  }
}
