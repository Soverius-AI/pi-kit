import { Language } from '@pi-kit/i18n';
import { Directive, computed, inject, input, signal } from '@angular/core';
import type { AngularToolCall } from '@copilotkit/angular';
import type { PiActivityContent } from '@pi-kit/protocol';
import { type PkActivityState } from '@pi-kit/design-system';
import { formatDuration } from '@pi-kit/ui';
import { ChatStore } from '@pi-kit/chat/data';
import { PkToolCall } from './tool-call-scope';
import { ClockStore } from '@pi-kit/data-access';

/**
 * What every tool-call renderer shares: the call as CopilotKit parsed it, its id (from `PkToolCall`; `RenderToolCalls` does not pass it), and the live state from the `pi.tool` activity: running,
 * done or failed, the latest output line and the elapsed time.
 */
@Directive()
export abstract class ToolRowBase {
  protected readonly i18n = inject(Language);
  readonly toolCall = input.required<AngularToolCall<Record<string, unknown>>>();

  /** The call this row draws: the scope the wrapper around CopilotKit's tool-calls view put around it. */
  private readonly scope = inject(PkToolCall);
  protected readonly callId = this.scope.callId;
  protected readonly session = inject(ChatStore);
  private readonly clock = inject(ClockStore);

  protected readonly name = computed(() => this.toolCall().name ?? 'tool');
  protected readonly args = computed(() => (this.toolCall().args ?? {}) as Record<string, unknown>);
  protected readonly info = computed(
    () => this.session.activities().get(`tool:${this.callId()}`)?.content as PiActivityContent<'pi.tool'> | undefined,
  );
  protected readonly result = computed(() => this.session.results().get(this.callId()));

  protected readonly state = computed<PkActivityState>(() => {
    const info = this.info();
    if (info) return info.status;
    const result = this.result();
    if (result) return result.error ? 'error' : 'done';
    // No result and nothing running: the call was cut off.
    return this.session.running() ? 'running' : 'error';
  });
  protected readonly running = computed(() => this.state() === 'running');

  protected readonly elapsedMs = computed(() => {
    const info = this.info();
    if (!info) return undefined;
    if (info.durationMs !== undefined) return info.durationMs;
    return info.status === 'running' ? Math.max(0, this.clock.now() - info.startedAt) : undefined;
  });

  /** The live sub-line: the latest update in one sentence, with the elapsed time. */
  protected readonly sub = computed(() => {
    if (this.state() === 'running') {
      const elapsed = this.elapsedMs();
      return [
        this.info()?.progress ?? this.i18n.t('chat.toolRowBase.running'),
        elapsed !== undefined ? formatDuration(elapsed) : undefined,
      ]
        .filter(Boolean)
        .join(', ');
    }
    if (this.state() === 'error' && !this.result() && !this.info())
      return this.i18n.t('chat.toolRowBase.noResultTheRunWasInterrupted');
    return undefined;
  });

  /** "1.2s" for a finished call that took a while. */
  protected readonly took = computed(() => {
    const ms = this.info()?.durationMs;
    return ms !== undefined && ms >= 1000 ? formatDuration(ms) : undefined;
  });

  protected str(key: string): string | undefined {
    const value = this.args()[key];
    return typeof value === 'string' ? value : undefined;
  }

  /** Expanded rows, kept per row instance. */
  protected readonly open = signal(false);
  /** Set once the user clicked a row that opens by default (a running bash call, an edit's diff). */
  protected readonly toggled = signal<boolean | undefined>(undefined);
}

/** First line of a text, trimmed, for a row's target column. */
export const firstLine = (text: string | undefined): string | undefined =>
  text
    ?.split('\n')
    .find((l) => l.trim())
    ?.trim();

export function lineCount(text: string): number {
  if (!text) return 0;
  return text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length;
}

/** The tail of a long output, so a huge command does not freeze the page. */
export function tail(text: string, maxLines = 400): { text: string; omitted: number } {
  const lines = text.split('\n');
  if (lines.length <= maxLines) return { text, omitted: 0 };
  return { text: lines.slice(-maxLines).join('\n'), omitted: lines.length - maxLines };
}
