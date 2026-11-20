import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import type { AbstractAgent } from '@ag-ui/client';
import { ProxiedCopilotRuntimeAgent } from '@copilotkit/core';
import { EntryApiClient } from '@pi-kit/api';
import { MCP_APPS_ACTIVITY, type McpAppActivity } from '@pi-kit/protocol';
import { PkMcpApp } from './mcp-app';

/** An MCP App the room's lead opened, its requests sent to the lead's thread on the room's host. */
@Component({
  selector: 'pk-room-mcp-app',
  imports: [PkMcpApp],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'contents' },
  template: `
    @if (agent(); as current) {
      <pk-mcp-app
        [activityType]="activityType"
        [content]="$any(app())"
        [message]="message()"
        [agent]="current"
        [send]="send()"
      />
    }
  `,
})
export class PkRoomMcpApp {
  readonly threadId = input.required<string>();
  readonly ownerId = input.required<string>();
  readonly app = input.required<McpAppActivity>();
  readonly id = input.required<string>();
  readonly send = input<((text: string) => void) | undefined>(undefined);

  protected readonly activityType = MCP_APPS_ACTIVITY;
  protected readonly agent = signal<AbstractAgent | undefined>(undefined);
  protected readonly message = computed(() => ({
    role: 'activity' as const,
    id: this.id(),
    activityType: MCP_APPS_ACTIVITY,
    content: this.app() as Record<string, unknown>,
  }));
  private readonly api = inject(EntryApiClient);

  constructor() {
    effect(() => {
      const threadId = this.threadId();
      const connection = this.api.connectionFor(this.ownerId());
      void Promise.all([connection.url(), connection.token()]).then(([url, token]) => {
        this.agent.set(
          new ProxiedCopilotRuntimeAgent({
            runtimeUrl: `${url.replace(/\/$/, '')}/api/copilotkit`,
            agentId: 'pi',
            threadId,
            headers: token ? { Authorization: `Bearer ${token}` } : {},
            transport: 'rest',
            runtimeMode: 'sse',
            ...(connection.mode === 'phone' ? { credentials: 'same-origin' as const } : {}),
          }),
        );
      });
    });
  }
}
