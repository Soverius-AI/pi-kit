import { Component, computed, inject, input } from '@angular/core';
import { type AgentLiveNestedTool, AgentLiveState, type AgentLiveTiming } from '@pi-kit/chat/util';
import { ClockStore } from '@pi-kit/data-access';
import { PkMarker, PkNotice, PkToolList, PkTurn, type PkNoticeTone } from '@pi-kit/design-system';
import { Language, TranslocoPipe } from '@pi-kit/i18n';
import type { PiLiveState } from '@pi-kit/protocol';
import { formatDuration } from '@pi-kit/ui';

@Component({
  selector: 'pk-agent-live',
  imports: [PkMarker, PkNotice, PkToolList, PkTurn, TranslocoPipe],
  host: { class: 'contents' },
  template: `
    <pk-turn role="pi" data-testid="agent-live" [attr.aria-busy]="!!live().run">
      @if (tools().length) {
        <pk-tool-list [items]="tools()" />
      }
      @for (marker of compacting(); track $index) {
        <pk-marker
          ><span class="animate-pulse">{{ marker }}</span></pk-marker
        >
      }
      @for (note of notes(); track note.id) {
        <pk-notice [attr.data-note]="note.id" [tone]="note.tone" [text]="note.text" [detail]="note.detail" />
      }
      @if (live().run) {
        <span
          class="loading loading-dots loading-sm text-primary"
          role="status"
          [attr.aria-label]="'chat.agentLive.working' | transloco"
        ></span>
      }
    </pk-turn>
  `,
})
export class AgentLive {
  private static readonly failures = [
    'model_error',
    'no_model',
    'aborted',
    'reset',
    'faulted',
    'orphaned',
    'interrupted',
    'restart_limit',
    'nothing_to_answer',
    'turn_limit',
  ];
  readonly live = input.required<PiLiveState>();
  readonly nested = input<ReadonlyMap<string, readonly AgentLiveNestedTool[]>>(new Map());
  readonly timing = input<ReadonlyMap<string, AgentLiveTiming>>(new Map());
  private readonly i18n = inject(Language);
  private readonly clock = inject(ClockStore);

  protected readonly tools = computed(() =>
    AgentLiveState.items(
      this.i18n.t,
      this.live().tools ?? [],
      { nested: this.nested(), timing: this.timing() },
      this.clock.now(),
    ),
  );

  protected readonly compacting = computed(() =>
    (this.live().compactions ?? []).map(() => this.i18n.t('chat.agentLive.compacting')),
  );

  protected readonly notes = computed(() => {
    const live = this.live();
    const notes: { id: string; tone: PkNoticeTone; text: string; detail?: string }[] = [];
    const retry = live.generation?.retry;
    if (retry)
      notes.push({ id: 'retry', tone: 'info', text: this.at('chat.agentLive.retry', retry.at), detail: retry.error });
    const deferred = live.generation?.deferred;
    if (deferred)
      notes.push({ id: 'deferred', tone: 'info', text: this.at('chat.agentLive.deferred', deferred.pollAt) });
    for (const [index, compaction] of (live.compactions ?? []).entries())
      if (compaction.retry)
        notes.push({
          id: `compaction-retry-${index}`,
          tone: 'info',
          text: this.at('chat.agentLive.compactionRetry', compaction.retry.at),
          detail: compaction.retry.error,
        });
    if (live.compactionFailure)
      notes.push({
        id: 'compaction-failure',
        tone: 'warning',
        text: this.i18n.t('chat.agentLive.compactionFailed'),
        detail: live.compactionFailure.error,
      });
    if (live.runFailure) {
      const { reason, detail } = live.runFailure;
      notes.push({
        id: 'run-failure',
        tone: 'error',
        text: AgentLive.failures.includes(reason)
          ? this.i18n.t(`chat.agentLive.failure.${reason}`)
          : this.i18n.t('chat.agentLive.failure.unknown', { value1: reason }),
        detail,
      });
    }
    return notes;
  });

  private at(key: string, at: number): string {
    const wait = at - this.clock.now();
    return this.i18n.t(key, {
      value1:
        wait >= 1000
          ? this.i18n.t('chat.agentLive.inTime', { value1: formatDuration(wait) })
          : this.i18n.t('chat.agentLive.now'),
    });
  }
}
