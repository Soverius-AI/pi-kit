import type { Translate } from '@pi-kit/i18n';
import { Language } from '@pi-kit/i18n';
import { TranslocoPipe } from '@pi-kit/i18n';
import { ChangeDetectionStrategy, Component, Directive, computed, inject, input } from '@angular/core';
import type { AbstractAgent } from '@ag-ui/client';
import { type ActivityRenderer, anyActivityContentSchema, registerRenderActivityMessage } from '@copilotkit/angular';
import { PkMarker, PkTurn } from '@pi-kit/design-system';
import { compactNumber } from '@pi-kit/ui';
import { usageLine } from '@pi-kit/chat/util';
import { ChatStore } from '@pi-kit/chat/data';
import { ShellRow } from './tools/shell-row';

type ActivityMessage = { role: 'activity'; content: Record<string, unknown>; id: string; activityType: string };

/** The wording of a compaction marker. */
export function markerLabel(translate: Translate, before?: number, after?: number): string {
  if (before !== undefined && after !== undefined)
    return translate('chat.activityRenderers.contextCompactedTokens', {
      value1: compactNumber(before),
      value2: compactNumber(after),
    });
  if (before !== undefined)
    return translate('chat.activityRenderers.contextCompactedWasTokens', { value1: compactNumber(before) });
  return translate('chat.activityRenderers.contextCompacted');
}

@Directive()
abstract class Activity implements ActivityRenderer<unknown> {
  readonly activityType = input.required<string>();
  readonly content = input.required<unknown>();
  readonly message = input.required<ActivityMessage>();
  readonly agent = input<AbstractAgent | undefined>(undefined);
}

/** `pi.compaction`: the hairline with "Context compacted, 51k → 18k tokens" (the id is the same live and in history). */
@Component({
  selector: 'pk-compaction-marker',
  imports: [PkMarker],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'contents' },
  template: `<pk-marker [attr.data-block]="message().id">{{ label() }}</pk-marker>`,
})
export class CompactionMarker extends Activity {
  protected readonly i18n = inject(Language);
  protected readonly label = computed(() => {
    const c = (this.message().content ?? {}) as { tokensBefore?: number; tokensAfter?: number };
    return markerLabel(this.i18n.t, c.tokensBefore, c.tokensAfter);
  });
}

/** `pi.branch_summary`: the summary pi wrote when the user left a branch. */
@Component({
  selector: 'pk-branch-summary-marker',
  imports: [PkMarker, TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'contents' },
  template: `<pk-marker [attr.data-block]="message().id">{{
    'chat.activityRenderers.summaryOfTheBranchYouLeft' | transloco
  }}</pk-marker>`,
})
export class BranchSummaryMarker extends Activity {}

/** `pi.bash`: a `!command` the user ran is a block of its own; the bash output of a model's tool call belongs to its row and draws nothing here. */
@Component({
  selector: 'pk-shell-activity',
  imports: [PkTurn, ShellRow],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'contents' },
  template: `
    @if (user()) {
      <pk-turn role="user" [attr.data-block]="message().id">
        <div class="pk-activity"><pk-shell-row [activityId]="message().id" /></div>
      </pk-turn>
    }
  `,
})
export class ShellActivity extends Activity {
  protected readonly user = computed(() => this.message().id.startsWith('bash:user:'));
}

/** `pi.turn_usage`: the muted usage line under a turn. Every request of a turn has one of these; only the last one draws, with the sum. */
@Component({
  selector: 'pk-usage-activity',
  imports: [PkTurn, TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'contents' },
  template: `
    @if (line(); as text) {
      <pk-turn
        role="pi"
        [attr.data-after]="after()"
        [attr.data-turn]="turnKey()"
        [attr.data-cont]="cont() ? 'usage' : null"
        [class.pk-hot]="chat.hotTurn() === turnKey()"
      >
        <div class="pk-usage" [attr.aria-label]="'chat.activityRenderers.usageOfThisTurn' | transloco">{{ text }}</div>
      </pk-turn>
    }
  `,
})
export class UsageActivity extends Activity {
  protected readonly i18n = inject(Language);
  protected readonly chat = inject(ChatStore);
  private readonly piece = computed(() => this.chat.turns().pieces.get(this.message().id));
  protected readonly line = computed(() => {
    const usage = this.chat.turns().usage.get(this.message().id);
    return usage ? usageLine(this.i18n.t, usage) : undefined;
  });
  protected readonly after = computed(() => this.piece()?.after ?? null);
  protected readonly turnKey = computed(() => this.piece()?.after ?? this.piece()?.block ?? null);
  protected readonly cont = computed(() => this.piece()?.cont ?? true);
}

/**
 * The activity messages of the transcript besides generated UI (which `genui/register.ts` handles): CopilotKit's message view draws
 * an `activity` message through the renderer registered for its type. Types with no renderer (`pi.tool`, `pi.diff`, `pi.widget`, `pi.review`, `pi.skills`)
 * draw nothing here: tool rows, the composer and the user block read them by id. Call from an injection context.
 */
export function registerActivityRenderers(): void {
  const renderers = [
    ['pi.compaction', CompactionMarker],
    ['pi.branch_summary', BranchSummaryMarker],
    ['pi.bash', ShellActivity],
    ['pi.turn_usage', UsageActivity],
  ] as const;
  for (const [activityType, component] of renderers) {
    registerRenderActivityMessage({ activityType, content: anyActivityContentSchema, component, agentId: 'pi' });
  }
}
