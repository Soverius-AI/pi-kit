import { registerRenderActivityMessage } from '@copilotkit/angular';
import { mcpAppsSnapshotContentSchema } from '@copilotkit/angular/mcp-apps';
import { MCP_APPS_ACTIVITY } from '@pi-kit/protocol';
import { PkMcpApp } from './mcp-app';

/**
 * Registers the renderer of MCP Apps with CopilotKit (`registerRenderActivityMessage`). Application
 * registrations rank above the built-ins (`provideMCPApps()` contributes the stock MCP Apps renderer), so this is what the transcript
 * draws. A2UI surfaces have no registration of ours: CopilotKit's own renderer draws them with the catalog. Call from an
 * injection context.
 */
export function registerGenUiRenderers(): void {
  registerRenderActivityMessage({
    activityType: MCP_APPS_ACTIVITY,
    content: mcpAppsSnapshotContentSchema,
    component: PkMcpApp,
    agentId: 'pi',
  });
}
