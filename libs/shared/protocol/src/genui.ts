import { z } from 'zod';

/**
 * Generative UI on the wire. Unlike the `pi.*` activities these two activity types are
 * CopilotKit's own, so their names and content shapes are the ones its renderers read:
 *
 * - `a2ui-surface`: `{ a2ui_operations: [...] }` (A2UI v0.9 `createSurface` / `updateComponents` /
 *   `updateDataModel` messages). The runtime's A2UI middleware makes it from a tool result whose JSON text has an
 *   `a2ui_operations` array; `sessionToMessages()` makes the same message from a stored result, so history agrees
 *   with the live stream. Message id `a2ui-surface-<toolCallId>`.
 * - `mcp-apps`: `{ serverHash, serverId, resourceUri, result, toolInput }`, one per call of an MCP tool whose
 *   definition links a `ui://` resource. Message id `mcp-app:<toolCallId>`.
 *
 * CopilotKit's third, `open-generative-ui` (a `generateSandboxedUi` call), is in `genui-tools.ts`.
 *
 * The data model of a surface is an object. An `updateDataModel` writes
 * `{ path: '/', value: { specs: [...] } }` (an object at the root or at a path), not the bare array at `/specs`,
 * because CopilotKit's A2UI renderer reveals a surface only after it has seen a data update whose `value` is an
 * object with something in it. `@pi-kit/pi-adapter` (`normalizeA2uiOperations`) rewrites a bare value at a path into the
 * object at the parent path, so an extension written to the old convention keeps rendering at once; a surface that
 * arrives as the JSON text of a tool result goes through the runtime's A2UI middleware and is not rewritten, so
 * its data has to follow the convention.
 */

export const A2UI_SURFACE_ACTIVITY = 'a2ui-surface';
export const MCP_APPS_ACTIVITY = 'mcp-apps';
/** The key CopilotKit's A2UI middleware looks for in a tool result. */
export const A2UI_OPERATIONS_KEY = 'a2ui_operations';

export const genUiId = {
  a2uiSurface: (toolCallId: string) => `a2ui-surface-${toolCallId}`,
  mcpApp: (toolCallId: string) => `mcp-app:${toolCallId}`,
};

export type A2uiOperation = Record<string, unknown>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The operations of an `a2ui_operations` container, if `value` is one. */
function operationsOf(value: unknown): A2uiOperation[] | undefined {
  if (!isRecord(value) || !Array.isArray(value[A2UI_OPERATIONS_KEY])) return undefined;
  const operations = (value[A2UI_OPERATIONS_KEY] as unknown[]).filter(isRecord);
  return operations.length > 0 ? operations : undefined;
}

/**
 * The A2UI operations a tool result carries: pi-kit's own convention is `details.a2ui_operations` (the model
 * only sees the result's short text), the AG-UI convention is a result text that is JSON with an
 * `a2ui_operations` array (also accepted when the JSON is itself a JSON string).
 */
export function a2uiOperationsOf(result: { details?: unknown; text?: string }): A2uiOperation[] | undefined {
  const fromDetails = operationsOf(result.details);
  if (fromDetails) return fromDetails;
  const text = result.text?.trim();
  if (!text || !text.startsWith('{') && !text.startsWith('"')) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return operationsOf(typeof parsed === 'string' ? JSON.parse(parsed) : parsed);
  } catch {
    return undefined;
  }
}

/** The text of a tool result as the A2UI middleware needs it: JSON with the operations, whatever the source. */
export const a2uiResultText = (operations: A2uiOperation[]): string => JSON.stringify({ [A2UI_OPERATIONS_KEY]: operations });

/** A tool result as an MCP App sees it (`ui/notifications/tool-result`): an MCP `CallToolResult` without `_meta`. */
export const McpAppResultSchema = z
  .object({
    content: z.array(z.record(z.string(), z.unknown())).default([]),
    structuredContent: z.record(z.string(), z.unknown()).optional(),
    isError: z.boolean().optional(),
  })
  .passthrough();
export type McpAppResult = z.infer<typeof McpAppResultSchema>;

/** Content of an `mcp-apps` activity (the shape `@copilotkit/angular/mcp-apps` validates). */
export const McpAppActivitySchema = z
  .object({
    serverHash: z.string(),
    serverId: z.string(),
    /** The MCP tool whose result this is (pi-kit's addition, for the frame's bar). */
    tool: z.string().optional(),
    resourceUri: z.string(),
    result: McpAppResultSchema,
    toolInput: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
export type McpAppActivity = z.infer<typeof McpAppActivitySchema>;

/** `serverHash` is opaque to the browser (it only echoes it back); pi addresses its servers by name. */
export const mcpServerHash = (server: string): string => `pi-mcp:${server}`;

/**
 * What the MCP Apps host sends through the agent for resource loads and tool calls
 * (`forwardedProps.__proxiedMCPRequest`, the contract of `@copilotkit/angular/mcp-apps` 0.3.1).
 */
export const ProxiedMcpRequestSchema = z.object({
  serverHash: z.string(),
  serverId: z.string().optional(),
  method: z.string(),
  params: z.record(z.string(), z.unknown()).optional(),
});
export type ProxiedMcpRequest = z.infer<typeof ProxiedMcpRequestSchema>;

export const PROXIED_MCP_REQUEST_KEY = '__proxiedMCPRequest';
/** Methods the browser may ask the agent to relay to an MCP server (the same list the CopilotKit middleware allows, minus pings). */
export const PROXIED_MCP_METHODS = ['tools/call', 'resources/read', 'notifications/message', 'ping'] as const;

/** `forwardedProps.__proxiedMCPRequest` of a run input, if there is a well-formed one. */
export function proxiedMcpRequestOf(forwardedProps: unknown): ProxiedMcpRequest | undefined {
  if (!isRecord(forwardedProps)) return undefined;
  const parsed = ProxiedMcpRequestSchema.safeParse(forwardedProps[PROXIED_MCP_REQUEST_KEY]);
  return parsed.success ? parsed.data : undefined;
}

/** True if the run input carries a proxied request, well-formed or not (it must never reach pi as a prompt). */
export const isProxiedMcpRun = (forwardedProps: unknown): boolean => isRecord(forwardedProps) && PROXIED_MCP_REQUEST_KEY in forwardedProps;

/**
 * `_meta.ui.resourceUri` of an MCP tool definition (MCP Apps, SEP-1865), or the flat key an earlier draft of the
 * spec used (`_meta["ui/resourceUri"]`, which is what `@ag-ui/mcp-apps-middleware` 0.0.3 reads).
 */
export function uiResourceUriOf(meta: unknown): string | undefined {
  if (!isRecord(meta)) return undefined;
  const nested = isRecord(meta['ui']) ? meta['ui']['resourceUri'] : undefined;
  const flat = meta['ui/resourceUri'];
  const uri = typeof nested === 'string' ? nested : typeof flat === 'string' ? flat : undefined;
  return uri?.startsWith('ui://') ? uri : undefined;
}

/**
 * The prompt for pi when the user acted on an A2UI surface. The runtime's A2UI middleware turns
 * `forwardedProps.a2uiAction` into an assistant `log_a2ui_event` tool call plus a tool message with this text;
 * `PiAgent` has no use for the pair, so it prompts with the text.
 */
export const A2UI_EVENT_TOOL_NAME = 'log_a2ui_event';
