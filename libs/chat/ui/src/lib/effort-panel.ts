import type { Translate } from '@pi-kit/i18n';
import { inject } from '@angular/core';
import { Language } from '@pi-kit/i18n';
import { TranslocoPipe } from '@pi-kit/i18n';
import { CdkTrapFocus } from '@angular/cdk/a11y';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  input,
  output,
  viewChild,
} from '@angular/core';
import type { ThinkingLevel } from '@pi-kit/protocol';
import { FlaskIcon } from './flask-icon';

const descriptions = (translate: Translate): Record<ThinkingLevel, string> => ({
  off: translate('chat.effortPanel.respondDirectlyWithoutExtendedThinking'),
  minimal: translate('chat.effortPanel.aQuickCheckBeforeResponding'),
  low: translate('chat.effortPanel.keepThingsQuickWithALittleRoom'),
  medium: translate('chat.effortPanel.balanceResponseSpeedWithDeeperReasoning'),
  high: translate('chat.effortPanel.takeMoreTimeToWorkThroughComplex'),
  xhigh: translate('chat.effortPanel.exploreDifficultProblemsInGreaterDepth'),
  max: translate('chat.effortPanel.useTheMostReasoningThisModelSupports'),
});

/**
 * The thinking-effort popover: the flask tile, a slider over the levels the model supports with the current level's description,
 * and a footer. It owns no state: `preview` fires while the slider moves, `commit` when it is released and `dismiss` on Escape or
 * close, and the host (the composer toolbar or Settings) applies them.
 */
@Component({
  selector: 'pk-effort-panel',
  imports: [TranslocoPipe, FlaskIcon, CdkTrapFocus, TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section
      class="effort-panel"
      role="dialog"
      [attr.aria-label]="'chat.effortPanel.thinkingEffort' | transloco"
      cdkTrapFocus
      [cdkTrapFocusAutoCapture]="true"
      data-testid="effort-popover"
    >
      <header>
        <span class="flask-tile"><pk-flask [level]="level()" /></span>
        <div>
          <h2>{{ 'chat.effortPanel.thinkingEffort' | transloco }}</h2>
          <p>{{ 'chat.effortPanel.giveThisResponseMoreRoomToThink' | transloco }}</p>
        </div>
        <button
          type="button"
          class="btn btn-ghost btn-xs btn-square"
          [attr.aria-label]="'chat.effortPanel.closeThinkingEffort' | transloco"
          [attr.cdkFocusInitial]="adjustable() ? null : ''"
          (click)="dismiss.emit()"
        >
          ✕
        </button>
      </header>
      <div class="choice">
        <span>{{ 'chat.effortPanel.effort' | transloco }}</span
        ><strong>{{ label(level()) }}</strong>
      </div>
      <div class="track" [style.--p]="position()">
        <input
          #slider
          [attr.cdkFocusInitial]="adjustable() ? '' : null"
          type="range"
          min="0"
          step="1"
          [attr.aria-label]="'chat.effortPanel.thinkingEffort' | transloco"
          [max]="max()"
          [value]="index()"
          [disabled]="!adjustable()"
          [attr.aria-valuetext]="'common.effortValue.' + level() | transloco"
          [attr.data-testid]="testId()"
          (input)="preview.emit(slider.valueAsNumber)"
          (change)="commit.emit()"
        />
        <div class="ticks" aria-hidden="true">
          @for (stop of levels(); track stop; let i = $index) {
            <i [class.passed]="i < index()" [class.under]="i === index()"></i>
          }
        </div>
        <div class="stops" aria-hidden="true">
          @for (stop of levels(); track stop) {
            <span [class.chosen]="stop === level()">{{ label(stop) }}</span>
          }
        </div>
      </div>
      <p class="description" aria-live="polite">
        {{
          adjustable()
            ? description()
            : (unavailable() ?? ('chat.effortPanel.thisModelDoesNotOfferAdjustableThinking' | transloco))
        }}
      </p>
      @if (adjustable()) {
        <footer>
          <span>{{ 'chat.effortPanel.faster' | transloco }}</span
          ><span>{{ 'chat.effortPanel.moreThorough' | transloco }}</span>
        </footer>
      }
    </section>
  `,
  styles: `
    :host {
      display: block;
      width: min(336px, calc(100vw - 32px));
    }
    .effort-panel {
      padding: 18px;
      border: 1px solid var(--color-base-300);
      border-radius: calc(var(--radius-box) + 4px);
      background: var(--color-base-100);
      color: var(--color-base-content);
      box-shadow: var(--pk-shadow);
    }
    header {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    header > div {
      flex: 1;
      min-width: 0;
    }
    h2 {
      margin: 0;
      font-size: 14px;
      line-height: 20px;
      font-weight: 600;
    }
    header p {
      margin: 2px 0 0;
      font-size: 11px;
      line-height: 16px;
      color: var(--pk-muted);
    }
    .flask-tile {
      width: 34px;
      height: 34px;
      display: grid;
      place-items: center;
      flex: none;
      border-radius: var(--radius-box);
      --pk-flask-size: 20px;
      background: color-mix(in srgb, var(--color-primary) 10%, var(--color-base-100));
    }
    .choice {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin: 22px 0 6px;
      font-size: 12px;
      color: var(--pk-muted);
    }
    .choice strong {
      padding: 3px 9px;
      border-radius: var(--radius-selector);
      color: var(--color-primary);
      background: color-mix(in srgb, var(--color-primary) 10%, var(--color-base-100));
      font-size: 11px;
      font-weight: 600;
    }
    /* A thick track filled up to the thumb, a tick per level drawn over it (hidden under the thumb) and the level names below. Ticks
       and names sit where the thumb's centre stops: half a thumb in from each end, then evenly spread. */
    .track {
      --thumb: 24px;
      --height: 12px;
      --at: calc(var(--thumb) / 2 + (100% - var(--thumb)) * var(--p));
      position: relative;
    }
    input {
      appearance: none;
      width: 100%;
      height: 30px;
      display: block;
      margin: 0;
      border: 0;
      background: transparent;
      cursor: pointer;
    }
    input::-webkit-slider-runnable-track {
      height: var(--height);
      border-radius: 999px;
      background:
        linear-gradient(to right, color-mix(in srgb, var(--color-primary) 55%, transparent), var(--color-primary)) 0 /
          var(--at) 100% no-repeat,
        color-mix(in srgb, var(--color-base-content) 10%, transparent);
      transition: background-size 160ms ease-out;
    }
    input::-moz-range-track {
      height: var(--height);
      border-radius: 999px;
      background: color-mix(in srgb, var(--color-base-content) 10%, transparent);
    }
    input::-moz-range-progress {
      height: var(--height);
      border-radius: 999px;
      background: linear-gradient(
        to right,
        color-mix(in srgb, var(--color-primary) 55%, transparent),
        var(--color-primary)
      );
    }
    input::-webkit-slider-thumb {
      appearance: none;
      width: var(--thumb);
      height: var(--thumb);
      margin-top: calc((var(--height) - var(--thumb)) / 2);
      border-radius: 50%;
      border: 4px solid var(--color-base-100);
      background: var(--color-primary);
      box-shadow:
        0 0 0 1px color-mix(in srgb, var(--color-primary) 60%, transparent),
        0 2px 10px color-mix(in srgb, var(--color-primary) 45%, transparent);
      transition:
        transform 140ms ease-out,
        box-shadow 140ms ease-out;
    }
    input::-moz-range-thumb {
      width: calc(var(--thumb) - 8px);
      height: calc(var(--thumb) - 8px);
      border-radius: 50%;
      border: 4px solid var(--color-base-100);
      background: var(--color-primary);
      box-shadow: 0 2px 10px color-mix(in srgb, var(--color-primary) 45%, transparent);
    }
    input:not(:disabled):hover::-webkit-slider-thumb,
    input:not(:disabled):active::-webkit-slider-thumb {
      transform: scale(1.12);
      box-shadow:
        0 0 0 1px color-mix(in srgb, var(--color-primary) 60%, transparent),
        0 0 0 7px color-mix(in srgb, var(--color-primary) 18%, transparent),
        0 2px 12px color-mix(in srgb, var(--color-primary) 55%, transparent);
    }
    input:focus-visible {
      outline: none;
    }
    input:focus-visible::-webkit-slider-thumb {
      box-shadow:
        0 0 0 1px var(--color-primary),
        0 0 0 6px color-mix(in srgb, var(--color-primary) 35%, transparent);
    }
    input:focus-visible::-moz-range-thumb {
      box-shadow: 0 0 0 6px color-mix(in srgb, var(--color-primary) 35%, transparent);
    }
    input:disabled {
      opacity: 0.4;
      cursor: default;
    }
    .ticks,
    .stops {
      display: flex;
      justify-content: space-between;
      margin: 0 calc(var(--thumb) / 2);
      pointer-events: none;
    }
    .ticks {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 30px;
      align-items: center;
    }
    .ticks i.under {
      visibility: hidden;
    }
    .ticks i,
    .stops span {
      width: 0;
      display: flex;
      justify-content: center;
    }
    .ticks i::before {
      content: '';
      flex: none;
      width: 4px;
      height: 4px;
      border-radius: 50%;
      background: color-mix(in srgb, var(--color-base-content) 30%, transparent);
    }
    .ticks i.passed::before {
      background: color-mix(in srgb, var(--color-base-100) 70%, transparent);
    }
    .stops {
      margin-top: 4px;
    }
    .stops span {
      font-size: 10px;
      line-height: 14px;
      white-space: nowrap;
      color: var(--pk-muted);
      transition: color 140ms ease-out;
    }
    .stops .chosen {
      color: var(--color-primary);
      font-weight: 600;
    }
    @media (prefers-reduced-motion: reduce) {
      input::-webkit-slider-runnable-track,
      input::-webkit-slider-thumb,
      .stops span {
        transition: none;
      }
    }
    .description {
      min-height: 36px;
      margin: 18px 0 0;
      font-size: 12px;
      line-height: 18px;
      color: var(--pk-muted);
    }
    footer {
      display: flex;
      justify-content: space-between;
      padding-top: 12px;
      margin-top: 10px;
      border-top: 1px solid var(--color-base-300);
      font-size: 10px;
      color: var(--pk-muted);
    }
  `,
})
export class EffortPanel {
  protected readonly i18n = inject(Language);
  readonly levels = input.required<readonly ThinkingLevel[]>();
  readonly level = input.required<ThinkingLevel>();
  readonly adjustable = input(true);
  readonly unavailable = input<string>();
  readonly testId = input('effort-slider');
  readonly preview = output<number>();
  readonly commit = output<void>();
  readonly dismiss = output<void>();
  protected readonly max = computed(() => Math.max(0, this.levels().length - 1));
  protected readonly index = computed(() => Math.max(0, this.levels().indexOf(this.level())));
  protected readonly position = computed(() => (this.max() ? this.index() / this.max() : 0));
  protected readonly description = computed(() => descriptions(this.i18n.t)[this.level()]);
  private readonly slider = viewChild<ElementRef<HTMLInputElement>>('slider');

  constructor() {
    // The panel can open before the model's levels are known (`/thinking` right after a send): the focus trap then starts on ✕, or the
    // composer still holds the focus. Once the slider can be used it takes the focus, once per opening, as `cdkFocusInitial` intends.
    // A panel closed before the timer runs (Escape) leaves the focus where closing put it.
    let focused = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    inject(DestroyRef).onDestroy(() => clearTimeout(timer));
    effect(() => {
      const slider = this.slider()?.nativeElement;
      if (focused || !slider || !this.adjustable()) return;
      focused = true;
      // Only while nothing else took the focus in between (Escape gives it back to the effort chip).
      const before = document.activeElement;
      timer = setTimeout(() => {
        if (slider.isConnected && document.activeElement === before) slider.focus();
      });
    });
  }
  protected label(level: ThinkingLevel): string {
    return this.i18n.t(`common.effort.${level}`);
  }
}
