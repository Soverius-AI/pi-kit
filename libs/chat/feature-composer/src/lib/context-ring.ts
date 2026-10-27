import { TranslocoPipe } from '@pi-kit/i18n';
import { ChangeDetectionStrategy, Component, ElementRef, effect, inject, untracked } from '@angular/core';
import { formatCost } from '@pi-kit/ui';
import { ChatStore, ChatTree, UsageStore } from '@pi-kit/chat/data';

/**
 * The context ring of the composer toolbar (doc/docs/design-system.md, "Composer"): a 32px disc with a 20px gauge that is muted below 70 %, warning
 * from 70 % and error from 90 %. Clicking it opens the usage popover (the fill, where pi compacts, cost by model, cache hit, and links to the
 * usage dialog and "Compact now"); `UsageStore` has the popover's state, `ChatStore.meter` the numbers of the ring. It keeps the old meter
 * bar's test id (`context-meter`) and its `data-level`, which the e2e tests read.
 */
@Component({
  imports: [TranslocoPipe],
  selector: 'pk-context-ring',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'relative inline-flex',
    '(document:click)': 'onDocumentClick($event)',
    '(keydown.escape)': 'onEscape($event)',
  },
  template: `
    @let m = chat.meter();
    <button
      type="button"
      class="pk-ring"
      data-testid="context-meter"
      aria-haspopup="dialog"
      [attr.aria-expanded]="usage.open()"
      [attr.data-level]="m?.level ?? 'ok'"
      [attr.aria-label]="m?.aria ?? ('chat.contextRing.contextSizeUnknownOpensUsage' | transloco)"
      [disabled]="!chat.threadId()"
      [title]="
        m
          ? m.aria.replace(' Opens usage.', '') +
            ('chat.contextRing.countsTheSystemPromptToolDefinitionsSkills' | transloco)
          : ('chat.contextRing.theContextWindowIsNotKnownYet' | transloco)
      "
      (click)="usage.toggle()"
    >
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <circle class="disc" cx="10" cy="10" r="10" />
        <circle class="track" cx="10" cy="10" r="6.25" />
        <circle
          class="arc"
          cx="10"
          cy="10"
          r="6.25"
          pathLength="100"
          [attr.stroke-dasharray]="(m?.percent ?? 0) + ' 100'"
        />
      </svg>
      <span class="sr">{{ m?.text ?? ('chat.contextRing.contextSizeUnknown' | transloco) }}</span>
    </button>
    @if (usage.open() && m) {
      <div
        class="pk-usage-pop"
        role="dialog"
        [attr.aria-label]="'chat.contextRing.contextWindow' | transloco"
        data-testid="usage-popover"
      >
        <div class="hd">
          <b>{{ m.headline }}</b>
          <span class="muted">{{ m.tokens }}</span>
        </div>
        <div class="bar">
          <span class="fill" [style.width.%]="m.percent"></span>
          @if (m.tick !== undefined) {
            <span
              class="tick"
              [style.left.%]="m.tick"
              [title]="('chat.contextRing.piCompactsAt' | transloco) + m.compactsAt"
            ></span>
          }
        </div>
        <dl class="kv">
          <dt>{{ 'chat.contextRing.compactsAt' | transloco }}</dt>
          <dd>{{ m.compactsAt ?? ('chat.contextRing.autoCompactionIsOff' | transloco) }}</dd>
          <dt>{{ 'chat.contextRing.thisThread' | transloco }}</dt>
          <dd>
            {{ cost(chat.totalCost()) }}, {{ chat.totalTurns() }}
            {{
              chat.totalTurns() === 1 ? ('chat.contextRing.turn' | transloco) : ('chat.contextRing.turns' | transloco)
            }}
          </dd>
          @for (row of usage.models(); track row.key) {
            <dt class="sub">{{ row.model }}</dt>
            <dd>{{ row.free ? ('chat.contextRing.free' | transloco) : cost(row.cost) }}</dd>
          }
          <dt>{{ 'chat.contextRing.cacheHit' | transloco }}</dt>
          <dd>{{ usage.cacheHit() ?? (usage.loading() ? '…' : ('chat.contextRing.noneYet' | transloco)) }}</dd>
        </dl>
        <div class="flex items-center justify-between t-sm">
          <button type="button" class="link link-hover" data-testid="usage-by-turn" (click)="usage.openDialog()">
            {{ 'chat.contextRing.usageByTurn' | transloco }}
          </button>
          <button type="button" class="link link-hover" data-testid="inspect-context" (click)="inspect()">
            {{ 'chat.contextRing.inspectContext' | transloco }}
          </button>
          <button
            type="button"
            class="link link-hover"
            data-testid="compact-now"
            [disabled]="chat.running()"
            [title]="
              chat.running()
                ? ('chat.contextRing.piCanCompactBetweenTurnsNotDuring' | transloco)
                : ('chat.contextRing.summariseTheOlderPartOfTheConversation' | transloco)
            "
            (click)="usage.compactNow()"
          >
            {{ 'chat.contextRing.compactNow' | transloco }}
          </button>
        </div>
      </div>
    }
  `,
})
export class ContextRing {
  protected readonly chat = inject(ChatStore);
  protected readonly usage = inject(UsageStore);
  private readonly tree = inject(ChatTree);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  /** "Inspect the context": the Session panel's inspector, with the popover closed. */
  protected inspect(): void {
    this.usage.close();
    this.tree.showContext();
  }
  protected readonly cost = formatCost;

  constructor() {
    // Another thread: an open popover closes (it would otherwise open again on coming back to the thread it was opened for).
    effect(() => {
      this.chat.threadId();
      untracked(() => this.usage.close());
    });
  }

  protected onDocumentClick(event: Event): void {
    if (this.usage.open() && !this.host.nativeElement.contains(event.target as Node)) this.usage.close();
  }

  protected onEscape(event: Event): void {
    if (!this.usage.open()) return;
    // The shell stops a run on Esc unless something else took the key.
    event.preventDefault();
    this.usage.close();
  }
}
