import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/**
 * The run ring (doc/docs/design-system.md, "Run ring"): the small gauge that says "running" without a word. A 16px track, the context arc
 * filled to `percent` when the context size is known, and, while `running`, a dot that orbits the ring (the one thing in the app that
 * turns on its own; still under reduced motion) with a slow pulse of the whole. It takes the current colour, so the place that shows it
 * decides the tint (primary for a running thread or agent). The host is an image with `label` as its name, or decorative without one
 * (a gauge that spells the number out next to it); pass `data-testid` and `data-kind` through from the place that uses it, as the
 * sidebar's rows do.
 */
@Component({
  selector: 'pk-run-ring',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'pk-run-ring',
    '[class.running]': 'running()',
    '[attr.role]': "label() ? 'img' : null",
    '[attr.aria-label]': 'label() || null',
    '[attr.aria-hidden]': "label() ? null : 'true'",
    '[attr.data-level]': 'level()',
    '[style.--pk-run-ring-size.px]': 'size()',
  },
  template: `
    <svg viewBox="0 0 16 16" fill="none" stroke-width="2" aria-hidden="true">
      <circle class="track" cx="8" cy="8" r="6" />
      @if (percent() !== null) {
        <circle
          class="context"
          cx="8"
          cy="8"
          r="6"
          [attr.stroke-dasharray]="arc()"
          transform="rotate(-90 8 8)"
          stroke-linecap="round"
        />
      }
      @if (running()) {
        <circle class="runner" cx="8" cy="2" r="1.6" stroke="none" fill="currentColor" />
      }
    </svg>
  `,
})
export class PkRunRing {
  /** How full the context is, 0–100; null when it is not known (the track alone). */
  readonly percent = input<number | null>(null);
  /** The dot orbits and the ring pulses. */
  readonly running = input(false);
  /** The accessible name: "Running, context 73% full". Without one the ring is decorative (the element around it carries the name). */
  readonly label = input('');
  /** The ring's width and height in pixels. */
  readonly size = input(16);
  /** warn from 70 %, err from 90 %: the arc takes the warning or error colour. */
  protected readonly level = computed(() => {
    const p = this.percent();
    return p === null ? null : p >= 90 ? 'err' : p >= 70 ? 'warn' : null;
  });
  /** The arc's dash: the share of the circle of radius 6. */
  protected readonly arc = computed(() => {
    const c = 2 * Math.PI * 6;
    return `${(c * Math.min(100, Math.max(0, this.percent() ?? 0))) / 100} ${c}`;
  });
}
