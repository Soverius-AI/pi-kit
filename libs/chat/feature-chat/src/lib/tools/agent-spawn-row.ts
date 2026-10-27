import { TranslocoPipe } from '@pi-kit/i18n';
import { ChangeDetectionStrategy, Component, computed } from '@angular/core';
import { PkActivityRow } from '@pi-kit/design-system';
import { ToolRowBase } from './tool-row-base';

/**
 * `agent_spawn`: the card of a background agent the main agent started, named after the agent, with its role and permission
 * mode and, expanded, the brief it got.
 */
@Component({
  selector: 'pk-agent-spawn-row',
  imports: [PkActivityRow, TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'contents', 'data-testid': 'agent-spawn-card' },
  template: `
    <pk-activity-row
      [tool]="'chat.agentSpawnRow.agent' | transloco"
      [state]="state()"
      [target]="agentName()"
      [sub]="sub() ?? role()"
      [expandable]="true"
      [(expanded)]="open"
    >
      <span stat>{{ permission() }}</span>
      @if (open()) {
        <div class="pk-out">
          <p class="t-sm">
            <b>{{ role() }}</b>
            @if (agentId(); as id) {
              <span class="muted"> · {{ 'chat.agentSpawnRow.id' | transloco: { value1: id } }}</span>
            }
          </p>
          <pre class="whitespace-pre-wrap break-words">{{ brief() }}</pre>
        </div>
      }
    </pk-activity-row>
  `,
})
export class AgentSpawnRow extends ToolRowBase {
  protected readonly agentName = computed(() => this.str('name') ?? '');
  protected readonly role = computed(() => this.str('role') ?? '');
  protected readonly brief = computed(() => this.str('brief') ?? '');
  protected readonly permission = computed(() => this.str('permission') ?? 'read-only');
  /** The agent's id, from the tool's result once it started. */
  protected readonly agentId = computed(() => {
    const content = this.result()?.content;
    if (!content) return undefined;
    try {
      const parsed = JSON.parse(content) as { agentId?: unknown };
      return typeof parsed.agentId === 'string' ? parsed.agentId : undefined;
    } catch {
      return undefined;
    }
  });
}
