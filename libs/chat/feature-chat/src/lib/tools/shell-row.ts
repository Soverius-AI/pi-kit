import { Language } from '@pi-kit/i18n';
import { TranslocoPipe } from '@pi-kit/i18n';
import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { ApiClient, sessionAbortBash, unwrap } from '@pi-kit/api';
import { PkActivityRow } from '@pi-kit/design-system';
import type { PiActivityContent } from '@pi-kit/protocol';

import { ChatStore } from '@pi-kit/chat/data';
import { firstLine, tail } from './tool-row-base';

/** A `!command` the user ran: the command, its streaming output and a Stop that reaches `abort-bash`. */
@Component({
  selector: 'pk-shell-row',
  imports: [PkActivityRow, TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'contents' },
  template: `
    <pk-activity-row
      tool="!"
      [state]="state()"
      [target]="command()"
      [sub]="running() ? 'Running' : undefined"
      [expandable]="true"
      [expanded]="shown()"
      (expandedChange)="toggled.set($event)"
    >
      <span stat>{{ stat() }}</span>
      @if (running()) {
        <button actions type="button" class="btn btn-ghost btn-xs" (click)="stop()">
          {{ 'chat.shellRow.stop' | transloco }}
        </button>
      }
      @if (shown()) {
        <div class="pk-out term">
          @if (output().omitted > 0) {
            <div class="meta">{{ 'chat.shellRow.earlierLinesNotShown' | transloco: { value1: output().omitted } }}</div>
          }
          <pre>{{ output().text }}@if (running()) {<span class="animate-pulse">▌</span>}</pre>
        </div>
      }
    </pk-activity-row>
  `,
})
export class ShellRow {
  protected readonly i18n = inject(Language);
  readonly activityId = input.required<string>();
  private readonly session = inject(ChatStore);
  private readonly api = inject(ApiClient);
  protected readonly toggled = signal<boolean | undefined>(undefined);

  protected readonly bash = computed(
    () => this.session.activities().get(this.activityId())?.content as PiActivityContent<'pi.bash'> | undefined,
  );
  protected readonly running = computed(() => this.bash()?.running === true);
  protected readonly state = computed(() =>
    this.running() ? 'running' : this.bash()?.cancelled || (this.bash()?.exitCode ?? 0) !== 0 ? 'error' : 'done',
  );
  protected readonly command = computed(() => firstLine(this.bash()?.command) ?? '');
  protected readonly output = computed(() => tail(this.bash()?.output ?? ''));
  protected readonly shown = computed(
    () => this.toggled() ?? (this.running() || this.state() === 'error' || (this.bash()?.output.length ?? 0) < 4000),
  );
  protected readonly stat = computed(() => {
    const b = this.bash();
    if (!b || b.running) return '';
    if (b.cancelled) return 'stopped';
    return b.exitCode ? this.i18n.t('chat.shellRow.exit', { value1: b.exitCode }) : '';
  });

  protected stop(): void {
    const id = this.session.threadId();
    if (id) void unwrap(sessionAbortBash({ client: this.api.client, path: { id } }));
  }
}
