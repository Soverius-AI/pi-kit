import type { Translate } from '@pi-kit/i18n';
import {
  CONNECTOR_EXPOSURE_TEXT,
  type Connector,
  type ConnectorCatalog,
  type ConnectorExposure,
  type McpServer,
  connectorOfServer,
} from '@pi-kit/protocol';
import { connectorStateLabels, type ConnectorState, connectorState, toolCountText } from './connectors';
import { letters } from './providers';

/**
 * What Settings › MCP servers lists: one row for every server, whether it came from the catalog (its logo tile and name) or was added by hand (a
 * glyph), with its state chip, scope chip, tool count, one detail line and the one text button its state asks for. Pure: the component renders these rows and forwards
 * the clicks.
 */

export type McpRowPrimary = 'sign-in' | 'try-again' | 'reconnect' | 'turn-on';

export interface McpRow {
  /** The server's name in `mcp.json`. */
  name: string;
  server: McpServer;
  /** The catalog entry the server is (matched by name or URL), if it is one. */
  connector?: Connector;
  variant?: string;
  state: ConnectorState;
  chip: { text: string; tone: 'ok' | 'warn' | 'err' | 'off' | 'info' };
  /** "user", "project" or "extension" (registered by a pi extension, so it cannot be changed here). */
  scope: 'user' | 'project' | 'extension';
  tools?: string;
  /** MCP App tools, counted. */
  apps: number;
  letters: string;
  detail: string;
  exposure: ConnectorExposure;
  primary?: McpRowPrimary;
  /** The wording of the primary button. */
  primaryText?: string;
  /** Whether the server's settings can be edited here (a pi extension's cannot). */
  editable: boolean;
}

const SCOPE = { global: 'user', project: 'project', extension: 'extension' } as const;

/** The file a server lives in, shortened for a line of text: `~/.pi/agent/mcp.json` stays itself, a project's becomes `.pi/mcp.json`. */
export function fileOf(server: Pick<McpServer, 'source' | 'scope'>): string {
  if (server.scope === 'extension') return server.source;
  return server.scope === 'project' ? '.pi/mcp.json' : server.source.replace(/^.*\/\.pi\/agent\//, '~/.pi/agent/');
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** The primary text button a state asks for; none for a server that is fine. */
export function primaryOf(
  translate: Translate,
  state: ConnectorState,
  server: McpServer,
): { action: McpRowPrimary; text: string } | undefined {
  switch (state) {
    case 'needs-signin':
      return { action: 'sign-in', text: translate('settings.mcpRows.signIn') };
    case 'error':
      return server.oauth
        ? { action: 'try-again', text: translate('settings.mcpRows.tryAgain') }
        : { action: 'reconnect', text: translate('settings.mcpRows.reconnect') };
    case 'off':
      return server.scope === 'extension'
        ? undefined
        : { action: 'turn-on', text: translate('settings.mcpRows.turnOn') };
    default:
      return undefined;
  }
}

/** The detail line: what a catalog service does, or where a custom server runs and the file it is in. */
export function detailOf(translate: Translate, server: McpServer, connector?: Connector): string {
  if (connector) {
    if (server.state === 'connected')
      return `${connector.summary} · ${CONNECTOR_EXPOSURE_TEXT[exposureOf(server)].label.toLowerCase()} · ${hostOf(server.target)}`;
    return connector.summary;
  }
  const where =
    server.scope === 'extension'
      ? translate('settings.mcpRows.registeredBy', { value1: server.source })
      : fileOf(server);
  const what = server.description ? `${server.description} · ` : '';
  return `${what}${server.target} · ${where}`;
}

export function exposureOf(server: McpServer): ConnectorExposure {
  return server.exposure === 'hidden' ? 'codemode' : server.exposure;
}

/** Every server as a row: servers that are on first (in the order of the files), those turned off last. */
export function mcpRows(translate: Translate, catalog: ConnectorCatalog, servers: readonly McpServer[]): McpRow[] {
  const rows = servers.map((server): McpRow => {
    const match = connectorOfServer(server, catalog);
    const state = connectorState(server);
    const primary = primaryOf(translate, state, server);
    const tools = toolCountText(server);
    return {
      name: server.name,
      server,
      ...(match?.connector ? { connector: match.connector } : {}),
      ...(match?.variant ? { variant: match.variant } : {}),
      state,
      chip: connectorStateLabels(translate)[state] ?? { text: state, tone: 'off' },
      scope: SCOPE[server.scope],
      ...(tools ? { tools } : {}),
      apps: (server.toolList ?? []).filter((t) => t.app).length,
      letters: letters(match?.connector.name ?? server.name),
      detail: detailOf(translate, server, match?.connector),
      exposure: exposureOf(server),
      ...(primary ? { primary: primary.action, primaryText: primary.text } : {}),
      editable: server.scope !== 'extension',
    };
  });
  return [...rows].sort((a, b) => Number(a.state === 'off') - Number(b.state === 'off'));
}

/** How many servers are on: the nav's count ("4 on"). */
export function onCount(servers: readonly McpServer[]): number {
  return servers.filter((s) => s.enabled && s.state !== 'disabled').length;
}

/** The heading's line: "4 servers on, 1 needs a sign-in." */
export function summaryText(translate: Translate, rows: readonly McpRow[]): string {
  if (rows.length === 0) return translate('settings.mcpRows.noServersYet');
  const on = rows.filter((r) => r.state !== 'off').length;
  const waiting = rows.filter((r) => r.state === 'needs-signin' || r.state === 'error').length;
  const parts = [
    translate('settings.mcpRows.on', {
      value1: on,
      value2: on === 1 ? translate('settings.mcpRows.server') : translate('settings.mcpRows.servers'),
    }),
  ];
  if (waiting > 0)
    parts.push(
      translate('settings.mcpRows.aSignInOrALook', {
        value1: waiting,
        value2: waiting === 1 ? translate('settings.mcpRows.needs') : translate('settings.mcpRows.need'),
      }),
    );
  return translate('settings.mcpRows.changesApplyToOpenThreadsAfterReload', { value1: parts.join(', ') });
}

/** The two files behind the list, with how many servers each holds. */
export interface McpFileRow {
  scope: 'user' | 'project';
  path: string;
  count: number;
}

export function fileRows(
  overview: { userConfig: string; projectConfig?: string; projectTrusted: boolean },
  servers: readonly McpServer[],
): McpFileRow[] {
  const rows: McpFileRow[] = [
    { scope: 'user', path: overview.userConfig, count: servers.filter((s) => s.scope === 'global').length },
  ];
  if (overview.projectConfig && overview.projectTrusted)
    rows.push({
      scope: 'project',
      path: overview.projectConfig,
      count: servers.filter((s) => s.scope === 'project').length,
    });
  return rows;
}
