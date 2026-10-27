import { TranslocoPipe } from '@pi-kit/i18n';
import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { ApiClient } from '@pi-kit/api';
import { PkActivityRow, PkAnsiText } from '@pi-kit/design-system';
import type { PiActivityContent } from '@pi-kit/protocol';

import { ToolRowBase, firstLine, tail } from './tool-row-base';

/**
 * `bash`: the command as target; while it runs a Stop button and the latest output line as sub-line, and the
 * streaming output in a terminal block (the `pi.bash` activity). Stop ends the whole run, like Esc in the CLI;
 * `!command` runs the user started have their own row (`ShellRow`) with `abort-bash`.
 */
@Component({
  selector: 'pk-bash-tool-row',
  imports: [PkActivityRow, PkAnsiText, TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'contents' },
  template: `
    <pk-activity-row
      tool="bash"
      [state]="state()"
      [target]="command()"
      [sub]="sub()"
      [expandable]="true"
      [expanded]="shown()"
      (expandedChange)="toggled.set($event)"
    >
      <span stat>{{ stat() }}</span>
      @if (running()) {
        <button actions type="button" class="btn btn-ghost btn-xs" (click)="stop()">
          {{ 'chat.bashToolRow.stop' | transloco }}
        </button>
      }
      @if (shown()) {
        <div class="pk-out term">
          @if (output().omitted > 0) {
            <div class="meta">
              {{ 'chat.bashToolRow.earlierLinesNotShown' | transloco: { value1: output().omitted } }}
            </div>
          }
          <pre><pk-ansi-text [text]="output().text" />@if (running()) {<span class="animate-pulse">▌</span>}</pre>
        </div>
      }
    </pk-activity-row>
  `,
})
export class BashToolRow extends ToolRowBase {
  private readonly api = inject(ApiClient);
  protected readonly bash = computed(
    () => this.session.activities().get(`bash:${this.callId()}`)?.content as PiActivityContent<'pi.bash'> | undefined,
  );
  protected readonly command = computed(() => firstLine(this.bash()?.command ?? this.str('command')) ?? '');
  protected readonly output = computed(() => tail(this.bash()?.output ?? this.result()?.content ?? ''));
  protected readonly shown = computed(() => this.toggled() ?? (this.running() || this.state() === 'error'));
  protected readonly stat = computed(() => {
    if (this.running()) return '';
    const code = this.bash()?.exitCode;
    if (code !== undefined && code !== 0) return this.i18n.t('chat.bashToolRow.exit', { value1: code });
    return this.took() ?? '';
  });

  protected stop(): void {
    void this.session.stop();
  }
}
