import { ChangeDetectionStrategy, Component, InjectionToken, inject, input } from '@angular/core';

/**
 * Whether thinking traces start open ("Show thinking expanded" in Settings). The app provides a function that reads the preference; without a
 * provider the traces start closed. The user can still open or close each one; only a change of the preference sets them all again.
 */
export const PK_THINKING_OPEN = new InjectionToken<() => boolean>('PK_THINKING_OPEN');

/**
 * Thinking trace (doc/docs/design-system.md, "Thinking trace"): a disclosure row in the same grid as an
 * activity row. While `streaming` the dot pulses and `live` shows the newest sentence; when done it is
 * "Thought for 8s" with the size trailing. Opening it shows the whole trace (the projected content) in a
 * muted, scroll-capped block with a 2px left rule. The open state is the browser's own (`<details>`).
 */
@Component({
  selector: 'pk-think',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <details class="pk-think" [attr.data-state]="state()" [open]="startOpen()">
      <summary>
        <span class="dot" aria-hidden="true"></span>
        <span>{{ label() }}</span>
        <span class="live">{{ state() === 'streaming' ? live() : '' }}</span>
        <span class="m">{{ meta() }}</span>
      </summary>
      <div class="trace"><ng-content /></div>
    </details>
  `,
})
export class PkThink {
  readonly state = input<'streaming' | 'done'>('done');
  /** "Thinking" while streaming, "Thought for 8s" when done. */
  readonly label = input.required<string>();
  readonly live = input('');
  /** Trailing text: elapsed time while streaming, the size when done. */
  readonly meta = input('');

  private readonly preference = inject(PK_THINKING_OPEN, { optional: true });
  protected startOpen(): boolean {
    return this.preference?.() ?? false;
  }
}
