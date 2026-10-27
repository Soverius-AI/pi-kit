import { z } from 'zod';

/** REST shapes of the MCP panel (`/api/mcp`). The state names are pi's own (`/mcp` output). */

export const MCP_EXPOSURES = ['codemode', 'deferred', 'direct', 'hidden'] as const;
export const McpExposureSchema = z.enum(MCP_EXPOSURES);
export type McpExposure = z.infer<typeof McpExposureSchema>;

/**
 * `unknown`: no pi session was asked (no thread is open, or it did not answer in time), so only the
 * configuration is known. `disabled` is configuration, not connection state.
 */
export const McpStateSchema = z.enum(['connected', 'connecting', 'needs-auth', 'failed', 'disconnected', 'closed', 'disabled', 'unknown']);
export type McpState = z.infer<typeof McpStateSchema>;

/**
 * A sign-in that pi-kit started (`/mcp login`) and its outcome: `waiting` while the browser has the authorization page (`url` is the fallback link),
 * `failed` with pi's own error text, `cancelled` when the person gave up. A finished, successful sign-in leaves nothing: the server is connected.
 */
export const McpSignInSchema = z.object({
  phase: z.enum(['waiting', 'failed', 'cancelled']),
  url: z.string().optional(),
  message: z.string().optional(),
});
export type McpSignIn = z.infer<typeof McpSignInSchema>;

/** One tool a connected server listed (from its `tools/list`), with whether it links an MCP App (`_meta.ui.resourceUri`). */
export const McpToolSchema = z.object({ name: z.string(), description: z.string().optional(), app: z.string().optional() });
export type McpTool = z.infer<typeof McpToolSchema>;

export const McpServerSchema = z.object({
  name: z.string(),
  /** `global`: `~/.pi/agent/mcp.json`; `project`: `<folder>/.pi/mcp.json` (trusted projects only); `extension`: registered by a pi extension for this session. */
  scope: z.enum(['global', 'project', 'extension']),
  /** The config file (or extension) that defines the server. */
  source: z.string(),
  /** The project file that overrides this global server's `enabled` / `exposure`. */
  override: z.string().optional(),
  transport: z.enum(['stdio', 'http']),
  /** The command line, or the URL. */
  target: z.string(),
  description: z.string().optional(),
  exposure: McpExposureSchema,
  enabled: z.boolean(),
  state: McpStateSchema,
  /** Tools the server offers, once it is connected. */
  tools: z.number().int().optional(),
  /** Why it failed (the first lines of pi's report). */
  error: z.string().optional(),
  /** An HTTP server without an `Authorization` header: it can be signed in to. */
  oauth: z.boolean(),
  /** The sign-in pi-kit started and has not finished, or how the last one ended. */
  signIn: McpSignInSchema.optional(),
  /** The tools it listed (names and the first line of their descriptions), once connected in this session. */
  toolList: z.array(McpToolSchema).optional(),
}).meta({ id: 'McpServer' });
export type McpServer = z.infer<typeof McpServerSchema>;

export const McpOverviewSchema = z.object({
  servers: z.array(McpServerSchema),
  /** Configuration problems pi reports (`config: ...`) and files we could not read. */
  errors: z.array(z.string()),
  /** Whether the thread's folder is trusted, i.e. its `.pi/mcp.json` is read. */
  projectTrusted: z.boolean(),
  /** A pi session reported the connection states. False: configuration only. */
  live: z.boolean(),
  /** Where the user-level servers are configured, for the empty state. */
  userConfig: z.string(),
  projectConfig: z.string().optional(),
}).meta({ id: 'McpOverview' });
export type McpOverview = z.infer<typeof McpOverviewSchema>;

/** The result of an action: what pi said (if anything), a link to open for a sign-in, and the overview afterwards. */
export const McpActionResultSchema = z.object({
  message: z.string().optional(),
  url: z.string().optional(),
  overview: McpOverviewSchema,
}).meta({ id: 'McpActionResult' });
export type McpActionResult = z.infer<typeof McpActionResultSchema>;

export const McpEnabledRequestSchema = z.object({ enabled: z.boolean() }).strict().meta({ id: 'McpEnabledRequest' });

// ---- the "Add a server" wizard and "The files" group

const checkUrl = z.string().url().refine((value) => /^https:\/\//.test(value) || /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/.test(value), 'https, or http on this machine');

/**
 * `POST /api/mcp/check`: is the server reachable, before it is added. A URL gets one MCP `initialize` (and a `tools/list` when that works); a command is looked up on the
 * PATH and is not run. A token typed for the check is used for that request only: it is not stored, logged or answered.
 */
export const McpCheckRequestSchema = z
  .object({ url: checkUrl.optional(), command: z.string().min(1).max(1024).optional(), token: z.string().min(1).max(4096).meta({ secret: true }).optional() })
  .strict()
  .refine((value) => (value.url === undefined) !== (value.command === undefined), 'a check needs a url or a command, not both')
  .meta({ id: 'McpCheckRequest' });
export type McpCheckRequest = z.infer<typeof McpCheckRequestSchema>;

/** `reachable`: answered; `needs-sign-in`: answered 401 and no token was given, which is what an OAuth server does; `refused`: the token was refused; `unreachable`; `found` / `missing`: a command on the PATH. */
export const McpCheckResultSchema = z
  .object({
    ok: z.boolean(),
    status: z.enum(['reachable', 'needs-sign-in', 'refused', 'unreachable', 'found', 'missing']),
    message: z.string(),
    /** How long the answer took. */
    ms: z.number().int().optional(),
    /** The tools it listed, when it was asked and answered. */
    tools: z.array(z.string()).optional(),
  })
  .meta({ id: 'McpCheckResult' });
export type McpCheckResult = z.infer<typeof McpCheckResultSchema>;

/** `POST /api/mcp/files/open` and `/reveal?thread=`: which of the two `mcp.json` files; the project's needs the thread to know the folder. */
export const McpFileRequestSchema = z.object({ scope: z.enum(['user', 'project']) }).strict().meta({ id: 'McpFileRequest' });
export type McpFileRequest = z.infer<typeof McpFileRequestSchema>;
