import { z } from 'zod';

/**
 * Connectors: remote MCP servers that pi-kit can add to pi's `mcp.json` with one click. The catalog is data (versioned JSON,
 * validated by `ConnectorCatalogSchema`): what the vendor's server is called, where it lives, how it signs a person in, and what to tell them before
 * they click. Nothing here is code that runs; the backend turns an entry into an `mcpServers` entry (`apps/backend/src/mcp/connectors.ts`) and pi does the rest.
 *
 * Every entry says whether its endpoint and sign-in mode were checked against the vendor's own documentation (`verification`). An entry that could not
 * be checked is `unverified` and the gallery says so on its card; an endpoint is never guessed.
 */

export const CONNECTOR_CATALOG_VERSION = 1;

/** How a connector may reach the model; `hidden` is left out on purpose, a hidden server is a disabled one. */
export const CONNECTOR_EXPOSURES = ['direct', 'codemode', 'deferred'] as const;
export const ConnectorExposureSchema = z.enum(CONNECTOR_EXPOSURES);
export type ConnectorExposure = z.infer<typeof ConnectorExposureSchema>;

/** What a person can read of each exposure, for the card's menu (mcp.md, "Control tool exposure"). */
export const CONNECTOR_EXPOSURE_TEXT: Record<ConnectorExposure, { label: string; hint: string }> = {
  direct: { label: 'Direct', hint: 'Every tool is declared to the model, like a built-in tool. Best for a few tools used all the time.' },
  codemode: { label: 'Codemode', hint: 'Tools are called from code the model writes, so they cost no context until used. The default.' },
  deferred: { label: 'Deferred', hint: 'Tools are found with a search and declared only when needed. For servers with many tools.' },
};

/**
 * How a server signs in:
 *  - `oauth`: pi registers itself with the vendor's authorization server (dynamic client registration) and the person approves in the browser. `clientName` is what pi registers as
 *    when the vendor only accepts known clients (pi's docs show Figma).
 *  - `cimd`: the same, identified by pi's Client ID Metadata Document instead of registering.
 *  - `oauth-client`: the vendor does not register clients dynamically; the person brings the client id (and secret) of an app they own.
 *  - `bearer`: a token the person creates at the vendor and pastes once; it goes to the credential store, and `mcp.json` holds the command that prints it.
 */
export const ConnectorAuthSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('oauth'), clientName: z.string().min(1).optional() }),
  z.object({ type: z.literal('cimd') }),
  z.object({
    type: z.literal('oauth-client'),
    /** The loopback port the redirect URI uses (`http://127.0.0.1:<port>/callback`), which the person registers with the vendor. */
    callbackPort: z.number().int().min(1024).max(65535),
    /** One sentence on where to create the app. */
    setup: z.string().min(1),
  }),
  z.object({
    type: z.literal('bearer'),
    /** The variable the vendor's own documentation names for this token (shown as a hint; the token itself is not read from it). */
    envVar: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
    /** One sentence on where to create the token. */
    setup: z.string().min(1),
  }),
]);
export type ConnectorAuth = z.infer<typeof ConnectorAuthSchema>;
export type ConnectorAuthType = ConnectorAuth['type'];

/** SVG path data: letters of the path grammar, numbers and separators, nothing else (the logo is drawn from it, never injected as markup). */
const PATH_DATA = /^[MmLlHhVvCcSsQqTtAaZz0-9eE+\-., ]+$/;

/** A monochrome mark on a 24 × 24 grid, stroked or filled in `currentColor`. */
export const ConnectorLogoSchema = z.object({
  paths: z.array(z.string().regex(PATH_DATA).max(600)).min(1).max(8),
  /** The paths are outlines (stroked, 1.6 wide) rather than shapes (filled). */
  style: z.enum(['fill', 'stroke']).default('stroke'),
});
export type ConnectorLogo = z.infer<typeof ConnectorLogoSchema>;

const httpsUrl = z
  .string()
  .url()
  .refine((value) => value.startsWith('https://'), 'a connector endpoint is https');

export const ConnectorVariantSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  label: z.string().min(1),
  url: httpsUrl,
  note: z.string().min(1),
});

export const ConnectorVerificationSchema = z.object({
  status: z.enum(['verified', 'unverified']),
  /** The day the endpoint and the sign-in mode were read against the vendor's documentation. */
  checkedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** What was read, and anything about the sign-in the person should know. */
  note: z.string().min(1),
});

export const ConnectorSchema = z.object({
  /** Becomes the server's name in `mcp.json` (letters, digits, `-`, `_`), so tools are `mcp__<id>__<tool>`. */
  id: z.string().regex(/^[A-Za-z0-9_-]+$/),
  name: z.string().min(1),
  vendor: z.string().min(1),
  logo: ConnectorLogoSchema,
  endpoint: z.object({ url: httpsUrl, variants: z.array(ConnectorVariantSchema).max(4).optional() }),
  auth: ConnectorAuthSchema,
  /** What access the sign-in asks for, in a phrase. */
  scopes: z.string().min(1),
  /** The server announces MCP Apps (interactive `ui://` panels). `unknown` when no vendor source says. */
  mcpApps: z.enum(['yes', 'no', 'unknown']),
  /** One line: what you can do with it. */
  summary: z.string().min(1).max(140),
  /** Tool names the `/` menu shows before the server has listed its own (a connector that is not connected yet is not in the menu, so this is a fallback). */
  highlights: z.array(z.string().min(1)).max(4),
  exposure: ConnectorExposureSchema,
  docs: httpsUrl,
  verification: ConnectorVerificationSchema,
}).meta({ id: 'Connector' });
export type Connector = z.infer<typeof ConnectorSchema>;

/**
 * The reserved shape of the signed update: the catalog a future pi.dev or repository fetch would return, with a detached signature over the canonical JSON of
 * `connectors`. Verification is designed (ed25519, a public key built into the app, `keyId` to rotate) and not wired: no code fetches it in this version.
 */
export const ConnectorSignatureSchema = z.object({ keyId: z.string().min(1), algorithm: z.literal('ed25519'), value: z.string().min(1) });

export const ConnectorCatalogSchema = z.object({
  version: z.literal(CONNECTOR_CATALOG_VERSION),
  /** The day the catalog was last edited. */
  updated: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  connectors: z
    .array(ConnectorSchema)
    .min(1)
    .superRefine((list, ctx) => {
      const seen = new Set<string>();
      list.forEach((entry, index) => {
        const key = entry.id.toLowerCase().replace(/-/g, '_');
        if (seen.has(key)) ctx.addIssue({ code: 'custom', path: [index, 'id'], message: `"${entry.id}" collides with another connector (ids that differ only in - and _ are one server for pi)` });
        seen.add(key);
      });
    }),
  signature: ConnectorSignatureSchema.optional(),
}).meta({ id: 'ConnectorCatalog' });
export type ConnectorCatalog = z.infer<typeof ConnectorCatalogSchema>;

// ---- requests

/** What a person typed for a server that is not in the catalog: a URL (HTTP) or a command (stdio). */
export const CustomConnectorSchema = z
  .object({
    name: z.string().regex(/^[A-Za-z0-9_-]+$/, 'letters, digits, "_" and "-"').max(48),
    url: httpsUrl.or(z.string().url().refine((value) => /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/.test(value), 'http only on this machine')).optional(),
    command: z.string().min(1).optional(),
    args: z.array(z.string()).max(32).optional(),
    description: z.string().max(200).optional(),
  })
  .refine((value) => (value.url === undefined) !== (value.command === undefined), 'a custom server has a url or a command, not both');
export type CustomConnector = z.infer<typeof CustomConnectorSchema>;

/**
 * `POST /api/connectors/connect?thread=`. `id` is a catalog id, or `custom` with `custom` filled in. A token (`bearer`) or a client secret (`oauth-client`) is sent once, goes
 * to the credential store, and is not part of any response, state or log.
 */
export const ConnectRequestSchema = z
  .object({
    id: z.string().min(1),
    scope: z.enum(['user', 'project']).default('user'),
    variant: z.string().optional(),
    exposure: ConnectorExposureSchema.optional(),
    token: z.string().min(1).max(4096).meta({ secret: true }).optional(),
    clientId: z.string().min(1).max(512).optional(),
    clientSecret: z.string().min(1).max(4096).meta({ secret: true }).optional(),
    custom: CustomConnectorSchema.optional(),
  })
  .strict().meta({ id: 'ConnectRequest' });
export type ConnectRequest = z.infer<typeof ConnectRequestSchema>;

export const ConnectorExposureRequestSchema = z.object({ exposure: ConnectorExposureSchema }).strict().meta({ id: 'ConnectorExposureRequest' });

/** `POST /api/connectors/:name/signin/cancel` and `.../signin/paste`: the two ways out of a sign-in that is waiting for the browser. */
export const SignInPasteRequestSchema = z.object({ url: z.string().min(1).max(4096) }).strict().meta({ id: 'SignInPasteRequest' });

// ---- the catalog's own text

/** The tool names of `/` menu group text: `save_issue` and `search-issues` become "save issue" and "search issues". */
export function humanToolName(name: string): string {
  return name.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** "Linear: create issue, search issues…": the menu line of a connected connector (at most three tool names, then an ellipsis when there are more). */
export function connectorMenuLine(name: string, tools: readonly string[]): string {
  const shown = tools.slice(0, 3).map(humanToolName);
  return `${name}: ${shown.join(', ')}${tools.length > shown.length ? '…' : ''}`;
}

// ---- the catalog

const CHECKED = '2026-10-16';

export const CONNECTOR_CATALOG: ConnectorCatalog = /* @__PURE__ */ ConnectorCatalogSchema.parse({
  version: CONNECTOR_CATALOG_VERSION,
  updated: CHECKED,
  connectors: [
    {
      id: 'linear',
      name: 'Linear',
      vendor: 'Linear',
      logo: { style: 'stroke', paths: ['M4 12.5L11.5 20', 'M4 8.5L15.5 20', 'M4.8 5.2A9 9 0 0 1 20 11.5', 'M8.5 4A9 9 0 0 1 20 15.5'] },
      endpoint: {
        url: 'https://mcp.linear.app/mcp',
        variants: [{ id: 'readonly', label: 'Read only', url: 'https://mcp.linear.app/mcp/readonly', note: 'Only the tools that read: search and open issues, projects and documents.' }],
      },
      auth: { type: 'oauth' },
      scopes: 'Your Linear workspace: issues, projects, comments (read and write; the read-only endpoint reads only)',
      mcpApps: 'unknown',
      summary: 'Find, create and update issues, projects and comments in Linear.',
      highlights: ['create issue', 'search issues', 'list projects'],
      exposure: 'direct',
      docs: 'https://linear.app/docs/mcp',
      verification: { status: 'verified', checkedOn: CHECKED, note: 'Linear’s MCP page: Streamable HTTP at /mcp, OAuth 2.1 with dynamic client registration, /mcp/readonly for read tools only.' },
    },
    {
      id: 'github',
      name: 'GitHub',
      vendor: 'GitHub',
      logo: { style: 'stroke', paths: ['M9 19c-4 1.2-4-2-6-2.5', 'M15 21v-3.2a2.8 2.8 0 0 0-.8-2.2c2.7-.3 5.5-1.3 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.3 4.3 0 0 0-.1-3.2s-1-.3-3.4 1.3a11.6 11.6 0 0 0-6 0C6.5 2.1 5.5 2.4 5.5 2.4a4.3 4.3 0 0 0-.1 3.2A4.6 4.6 0 0 0 4 8.8c0 4.600 2.800 5.700 5.500 6A2.800 2.800 0 0 0 8.700 17V21'] },
      endpoint: {
        url: 'https://api.githubcopilot.com/mcp/',
        variants: [{ id: 'readonly', label: 'Read only', url: 'https://api.githubcopilot.com/mcp/readonly', note: 'Only the tools that read repositories, issues and pull requests.' }],
      },
      auth: { type: 'bearer', envVar: 'GITHUB_PERSONAL_ACCESS_TOKEN', setup: 'Create a personal access token at github.com/settings/tokens and paste it here once.' },
      scopes: 'What the token you create allows: choose repository, issue and pull request access when you make it',
      mcpApps: 'unknown',
      summary: 'Read repositories, search code, and work with issues and pull requests.',
      highlights: ['search repositories', 'get issue', 'create pull request'],
      exposure: 'deferred',
      docs: 'https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md',
      verification: {
        status: 'verified',
        checkedOn: CHECKED,
        note: 'GitHub’s remote-server page: /mcp/ and /mcp/readonly; a personal access token as a bearer header works in any client. OAuth needs the host to register a GitHub App, which pi-kit does not, so only the token is offered.',
      },
    },
    {
      id: 'slack',
      name: 'Slack',
      vendor: 'Slack',
      logo: { style: 'stroke', paths: ['M9 4v8', 'M15 12V4', 'M4 9h8', 'M12 15H4', 'M9 20v-5', 'M15 20v-8', 'M20 9h-8', 'M20 15h-5'] },
      endpoint: { url: 'https://mcp.slack.com/mcp' },
      auth: { type: 'oauth-client', callbackPort: 8765, setup: 'Slack only lets clients backed by a Slack app use its server. Create an app at api.slack.com/apps and register http://127.0.0.1:8765/callback as its redirect URL.' },
      scopes: 'User token scopes you grant the app: search, read history, post messages, canvases',
      mcpApps: 'yes',
      summary: 'Search conversations, read threads and draft messages in Slack.',
      highlights: ['search messages', 'read thread', 'send message'],
      exposure: 'codemode',
      docs: 'https://docs.slack.dev/ai/mcp-server',
      verification: { status: 'verified', checkedOn: CHECKED, note: 'Slack’s MCP page: https://mcp.slack.com/mcp, a registered app with a fixed client id, no dynamic client registration. MCP Apps: named in Anthropic’s interactive-connectors announcement.' },
    },
    {
      id: 'notion',
      name: 'Notion',
      vendor: 'Notion',
      logo: { style: 'stroke', paths: ['M5 4h11l3 3v13H5z', 'M9 16V8l6 8V8'] },
      endpoint: { url: 'https://mcp.notion.com/mcp' },
      auth: { type: 'oauth' },
      scopes: 'The pages and databases you can open in the workspace you choose',
      mcpApps: 'unknown',
      summary: 'Search and read pages, and create or update content in your Notion workspace.',
      highlights: ['search', 'fetch page', 'create pages'],
      exposure: 'codemode',
      docs: 'https://developers.notion.com/guides/mcp/get-started-with-mcp',
      verification: { status: 'verified', checkedOn: CHECKED, note: 'Notion’s guide: https://mcp.notion.com/mcp over Streamable HTTP, OAuth in the browser. Whether the authorization server registers clients dynamically is not stated there; pi tries it and reports the error if not. Workspace guests cannot connect; a token for Business and Enterprise plans exists and is not offered.' },
    },
    {
      id: 'sentry',
      name: 'Sentry',
      vendor: 'Sentry',
      logo: { style: 'stroke', paths: ['M12 4L21 19H15.5', 'M12 9.500L16.500 17', 'M3 19H8.500'] },
      endpoint: { url: 'https://mcp.sentry.dev/mcp' },
      auth: { type: 'oauth' },
      scopes: 'Your Sentry organizations: issues, events, projects',
      mcpApps: 'unknown',
      summary: 'Search errors, read stack traces and triage issues from Sentry.',
      highlights: ['search issues', 'get issue details', 'find projects'],
      exposure: 'codemode',
      docs: 'https://mcp.sentry.dev/',
      verification: { status: 'verified', checkedOn: CHECKED, note: 'Sentry’s MCP page: https://mcp.sentry.dev/mcp, all connections use OAuth; scope it with /mcp/<organization> or /mcp/<organization>/<project> (use Custom server for that).' },
    },
    {
      id: 'atlassian',
      name: 'Atlassian',
      vendor: 'Atlassian',
      logo: { style: 'stroke', paths: ['M4 17L10 6a1 1 0 0 1 1.800 0L19.500 20H9', 'M13 20L8 20'] },
      endpoint: { url: 'https://mcp.atlassian.com/v2/mcp' },
      auth: { type: 'oauth' },
      scopes: 'Jira, Confluence, Bitbucket and Loom content your Atlassian account can already open',
      mcpApps: 'unknown',
      summary: 'Search and update Jira issues, Confluence pages and Bitbucket from the chat.',
      highlights: ['search issues', 'create issue', 'get page'],
      exposure: 'codemode',
      docs: 'https://support.atlassian.com/atlassian-rovo-mcp-server/docs/getting-started-with-the-atlassian-remote-mcp-server/',
      verification: { status: 'verified', checkedOn: CHECKED, note: 'Atlassian’s Rovo MCP page: https://mcp.atlassian.com/v2/mcp, OAuth 2.1; an API token is an admin-enabled alternative and is not offered. Whether pi can register a client is not stated; pi reports the error if not.' },
    },
    {
      id: 'figma',
      name: 'Figma',
      vendor: 'Figma',
      logo: { style: 'stroke', paths: ['M9 3h3a3 3 0 0 1 0 6H9z', 'M12 3h3a3 3 0 0 1 0 6h-3', 'M9 9h3a3 3 0 0 1 0 6H9z', 'M9 15a3 3 0 1 1-3 3a3 3 0 0 1 3-3z', 'M12 9a3 3 0 1 1 0 6'] },
      endpoint: { url: 'https://mcp.figma.com/mcp' },
      auth: { type: 'oauth', clientName: 'Claude Code' },
      scopes: 'Design files you can open: layout, styles and assets of a frame you select',
      mcpApps: 'yes',
      summary: 'Read frames and design context from Figma, and turn them into code.',
      highlights: ['get design context', 'get screenshot', 'get variable defs'],
      exposure: 'codemode',
      docs: 'https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/',
      verification: {
        status: 'verified',
        checkedOn: CHECKED,
        note: 'Figma’s page: https://mcp.figma.com/mcp, and only clients in Figma’s catalog may connect. pi’s own docs (mcp.md) register as "Claude Code" for it, which is what this entry does; Figma may stop accepting that. MCP Apps: named in Anthropic’s interactive-connectors announcement.',
      },
    },
  ],
});

export const connectorById = (id: string, catalog: ConnectorCatalog): Connector | undefined => catalog.connectors.find((c) => c.id === id);

/** The URL a connector's entry uses for a variant (the default endpoint when none, or an unknown, is named). */
export function connectorUrl(connector: Connector, variant?: string): string {
  return connector.endpoint.variants?.find((v) => v.id === variant)?.url ?? connector.endpoint.url;
}

/** `https://Host/path/` and `https://host/path` are one endpoint when a server added by hand is matched with a card. */
export function normalizeEndpoint(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    return `${parsed.origin.toLowerCase()}${parsed.pathname.replace(/\/+$/, '')}${parsed.search}`;
  } catch {
    return url;
  }
}

/** The catalog entry a configured server belongs to: by its name, or by its URL when it was added by hand under another name. */
export function connectorOfServer(server: { name: string; transport: string; target: string }, catalog: ConnectorCatalog): { connector: Connector; variant?: string } | undefined {
  if (server.transport !== 'http') return undefined;
  const target = normalizeEndpoint(server.target);
  for (const connector of catalog.connectors) {
    const variant = connector.endpoint.variants?.find((v) => normalizeEndpoint(v.url) === target);
    if (variant) return { connector, variant: variant.id };
    if (normalizeEndpoint(connector.endpoint.url) === target) return { connector };
  }
  return catalog.connectors.find((c) => c.id === server.name && server.transport === 'http') ? { connector: connectorById(server.name, catalog) as Connector } : undefined;
}
