import type { Translate } from '@pi-kit/i18n';
import {
  type Connector,
  type ConnectorCatalog,
  type McpServer,
  connectorMenuLine,
  connectorOfServer,
} from '@pi-kit/protocol';

/**
 * What a connector card shows, computed from the catalog and the MCP overview, with no Angular: which of the seven states a card is in, the wording of each, and the
 * `/` menu groups of the connected ones. A server is matched with its card by name or by URL, so one added with `pi mcp add` under another name still shows as connected.
 */

export type ConnectorState = 'available' | 'connecting' | 'signing-in' | 'needs-signin' | 'connected' | 'error' | 'off';

export interface ConnectorCard {
  connector: Connector;
  server?: McpServer;
  /** The variant the configured server's URL belongs to (`readonly`), if it is one. */
  variant?: string;
  state: ConnectorState;
}

/** The words of each state on its chip, and the chip's tone (`ok`, `warn`, `err`, `off`, `info`: the `.pk-group .chip` classes). */
export const connectorStateLabels = (
  translate: Translate,
): Record<ConnectorState, { text: string; tone: 'ok' | 'warn' | 'err' | 'off' | 'info' }> => ({
  available: { text: translate('settings.connectors.notConnected'), tone: 'off' },
  connecting: { text: translate('settings.connectors.connecting'), tone: 'warn' },
  'signing-in': { text: translate('settings.connectors.signingIn'), tone: 'warn' },
  'needs-signin': { text: translate('settings.connectors.needsSignIn'), tone: 'warn' },
  connected: { text: translate('settings.connectors.connected'), tone: 'ok' },
  error: { text: translate('settings.connectors.error'), tone: 'err' },
  off: { text: translate('settings.connectors.off'), tone: 'off' },
});

export function connectorState(server: McpServer | undefined): ConnectorState {
  if (!server) return 'available';
  if (!server.enabled || server.state === 'disabled') return 'off';
  switch (server.state) {
    case 'connected':
      return 'connected';
    case 'connecting':
      return 'connecting';
    case 'needs-auth':
      if (server.signIn?.phase === 'waiting') return 'signing-in';
      return server.signIn?.phase === 'failed' ? 'error' : 'needs-signin';
    case 'failed':
      return 'error';
    default:
      // disconnected, closed, unknown: the server is configured and not up; a sign-in or a reconnect is the next move
      return server.oauth ? 'needs-signin' : 'connecting';
  }
}

/** One card per catalog entry, connected and attention-needing ones first, the rest in the catalog's order. */
export function connectorCards(catalog: ConnectorCatalog, servers: readonly McpServer[]): ConnectorCard[] {
  const byConnector = new Map<string, { server: McpServer; variant?: string }>();
  for (const server of servers) {
    const match = connectorOfServer(server, catalog);
    // The server that has the connector's own name wins over one added by hand with the same URL.
    if (match && (!byConnector.has(match.connector.id) || server.name === match.connector.id))
      byConnector.set(match.connector.id, { server, ...(match.variant ? { variant: match.variant } : {}) });
  }
  const cards = catalog.connectors.map((connector, index): ConnectorCard & { index: number } => {
    const found = byConnector.get(connector.id);
    return {
      index,
      connector,
      ...(found ? { server: found.server } : {}),
      ...(found?.variant ? { variant: found.variant } : {}),
      state: connectorState(found?.server),
    };
  });
  const rank = (state: ConnectorState): number => (state === 'available' ? 1 : 0);
  return cards
    .sort((a, b) => rank(a.state) - rank(b.state) || a.index - b.index)
    .map(({ index: _index, ...card }) => card);
}

/** The line of a connected server in the footer, the card's tool count and the MCP Apps chip. */
export function toolCountText(server: McpServer): string | undefined {
  if (server.tools === undefined) return undefined;
  return `${server.tools} ${server.tools === 1 ? 'tool' : 'tools'}`;
}

export function appToolCount(server: McpServer): number {
  return (server.toolList ?? []).filter((tool) => tool.app).length;
}

/** The connected servers whose tools are declared to the model, as the groups of the `/` menu: "Linear: create issue, search issues…". */
export interface ConnectorMenuGroup {
  /** The server's name in `mcp.json` (the tool prefix `mcp__<name>__`). */
  server: string;
  title: string;
  line: string;
  /** What the composer is filled with when the group is picked. */
  insert: string;
}

export function connectorMenuGroups(
  translate: Translate,
  servers: readonly McpServer[],
  catalog: ConnectorCatalog,
): ConnectorMenuGroup[] {
  const groups: ConnectorMenuGroup[] = [];
  for (const server of servers) {
    if (server.state !== 'connected' || !server.enabled || server.exposure !== 'direct') continue;
    const connector = connectorOfServer(server, catalog)?.connector;
    const title = connector?.name ?? server.name;
    const tools = (server.toolList ?? []).map((tool) => tool.name);
    const names = tools.length > 0 ? tools : (connector?.highlights ?? []);
    if (names.length === 0) continue;
    groups.push({
      server: server.name,
      title,
      line: connectorMenuLine(title, names),
      insert: translate('settings.connectors.useTo', { value1: title }),
    });
  }
  return groups.sort((a, b) => a.title.localeCompare(b.title));
}

/** The footer of the sidebar: "N MCP servers" stays what it says, and a connector that needs a person is named. */
export function attentionText(
  translate: Translate,
  servers: readonly McpServer[],
  catalog: ConnectorCatalog,
): string | undefined {
  const waiting = servers.filter((s) => s.enabled && (s.state === 'needs-auth' || s.state === 'failed'));
  if (waiting.length === 0) return undefined;
  const first = waiting[0];
  const name = connectorOfServer(first, catalog)?.connector.name ?? first.name;
  return waiting.length === 1
    ? translate('settings.connectors.needsYou', { value1: name })
    : translate('settings.connectors.serversNeedYou', { value1: waiting.length });
}
