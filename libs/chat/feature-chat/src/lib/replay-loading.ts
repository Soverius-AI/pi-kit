import { TranslocoPipe } from '@pi-kit/i18n';
import { ChangeDetectionStrategy, Component, effect, input, signal } from '@angular/core';

/**
 * What the transcript shows while a thread's replay loads: a shimmering placeholder of a turn when there are no messages yet, or
 * a small "Syncing" line when there are. Nothing appears for the first 150 ms, so a fast load never flashes it.
 */
@Component({
  selector: 'pk-replay-loading',
  imports: [TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (delayed()) {
      <div role="status" aria-live="polite" [class.sync]="hasMessages()" [class.placeholder]="!hasMessages()">
        @if (hasMessages()) {
          <span class="loading loading-spinner loading-xs" aria-hidden="true"></span>
          {{ 'chat.replay.syncing' | transloco }}
        } @else {
          <span class="sr-only">{{ 'chat.replay.loading' | transloco }}</span>
          <div class="bubble shimmer" aria-hidden="true"></div>
          <div class="line shimmer" aria-hidden="true"></div>
          <div class="line short shimmer" aria-hidden="true"></div>
          <div class="tool shimmer" aria-hidden="true"></div>
          <div class="line shimmer" aria-hidden="true"></div>
          <div class="line short shimmer" aria-hidden="true"></div>
        }
      </div>
    }
  `,
  styles: `
    :host {
      display: block;
    }
    .sync {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 0;
      font-size: 12px;
      color: var(--pk-muted);
    }
    .placeholder {
      display: grid;
      gap: 14px;
      padding: 32px 0;
      max-width: 680px;
      margin: auto;
    }
    .shimmer {
      border-radius: 6px;
      background: linear-gradient(
        100deg,
        var(--color-base-200) 25%,
        var(--color-base-300) 50%,
        var(--color-base-200) 75%
      );
      background-size: 200% 100%;
      animation: shimmer 1.4s ease-in-out infinite;
    }
    .bubble {
      height: 60px;
      width: 66%;
      margin-left: auto;
      margin-bottom: 20px;
    }
    .line {
      height: 14px;
      width: 90%;
    }
    .short {
      width: 62%;
    }
    .tool {
      height: 40px;
      width: 78%;
      margin: 12px 0;
    }
    @keyframes shimmer {
      from {
        background-position: 100% 0;
      }
      to {
        background-position: -100% 0;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .shimmer {
        animation: none;
      }
    }
  `,
})
export class ReplayLoading {
  readonly loading = input(false);
  readonly hasMessages = input(false);
  protected readonly delayed = signal(false);
  constructor() {
    effect((onCleanup) => {
      this.delayed.set(false);
      if (!this.loading()) return;
      const timer = setTimeout(() => this.delayed.set(true), 150);
      onCleanup(() => clearTimeout(timer));
    });
  }
}
