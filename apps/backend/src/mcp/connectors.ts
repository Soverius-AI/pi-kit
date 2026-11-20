import {
  type ConnectRequest,
  type Connector,
  type ConnectorCatalog,
  type ConnectorExposure,
  type CustomConnector,
  connectorOfServer,
  connectorScope,
  connectorUrl,
  readOnlyScope,
} from '@pi-kit/protocol';

/**
 * The `mcp.json` entry of a connector, as pure functions so the unit tests cover every sign-in mode: pi's own format (docs/mcp.md), nothing of pi-kit's in it.
 *  - OAuth (dynamic registration): the URL alone, plus `oauth.clientName` where the vendor only accepts known clients.
 *  - Client Metadata Document: `oauth.clientRegistration: "cimd"`.
 *  - A registered client (Slack, Google): `oauth.clientId`, `callbackPort`, the catalog's `scope` for the chosen access and, when there is one, `clientSecret` as the command that prints it, never the secret.
 *  - A bearer token: `headers.Authorization` is the command that prints the header (or, with no credential store, the header itself; the service refuses that for a project file).
 * `exposure: "codemode"` is pi's default and stays out of the file, as pi's own manager writes it.
 */

export interface EntryOptions {
  variant?: string;
  exposure: ConnectorExposure;
  /** The whole `Authorization` header value (a command, or `Bearer <token>` without a store). */
  authorization?: string;
  clientId?: string;
  /** The command that prints the client secret (`!security ...`), or the value another entry of the same app holds. */
  clientSecretCommand?: string;
  /** Replaces the catalog's URL (the end-to-end tests point a connector at a local server). */
  url?: string;
}

const withExposure = (exposure: ConnectorExposure): Record<string, unknown> =>
  exposure === 'codemode' ? {} : { exposure };

export function buildConnectorEntry(connector: Connector, options: EntryOptions): Record<string, unknown> {
  const { auth } = connector;
  if (connector.local) {
    const variant = connector.local.variants?.find((v) => v.id === options.variant);
    const env = { ...connector.local.env, ...variant?.env };
    return {
      command: connector.local.command,
      args: [...connector.local.args, ...(variant?.args ?? [])],
      ...(Object.keys(env).length ? { env } : {}),
      description: connector.summary,
      ...withExposure(options.exposure),
    };
  }
  const entry: Record<string, unknown> = {
    url: options.url ?? connectorUrl(connector, options.variant),
    description: connector.summary,
    ...withExposure(options.exposure),
  };
  switch (auth.type) {
    case 'oauth':
      if (auth.clientName) entry['oauth'] = { clientName: auth.clientName };
      break;
    case 'cimd':
      entry['oauth'] = { clientRegistration: 'cimd' };
      break;
    case 'oauth-client': {
      if (!options.clientId) throw new Error(`${connector.name} needs the client id of your ${connector.name} app.`);
      const scope = connectorScope(connector, options.variant);
      entry['oauth'] = {
        clientId: options.clientId,
        callbackPort: auth.callbackPort,
        ...(options.clientSecretCommand ? { clientSecret: options.clientSecretCommand } : {}),
        ...(scope ? { scope } : {}),
      };
      break;
    }
    case 'bearer':
      if (!options.authorization) throw new Error(`${connector.name} needs a token.`);
      entry['headers'] = { Authorization: options.authorization };
      break;
    case 'device':
      break;
  }
  return entry;
}

export function buildCustomEntry(
  custom: CustomConnector,
  exposure: ConnectorExposure,
  authorization?: string,
): Record<string, unknown> {
  const description = custom.description ? { description: custom.description } : {};
  if (custom.url)
    return {
      url: custom.url,
      ...description,
      ...withExposure(exposure),
      ...(authorization ? { headers: { Authorization: authorization } } : {}),
    };
  return {
    command: custom.command,
    ...(custom.args?.length ? { args: custom.args } : {}),
    ...description,
    ...withExposure(exposure),
  };
}

/** Catalog servers whose sign-in grants only `.readonly` scopes: a read-only room may call all their tools, as with a read-only Composio app. */
export function readOnlyServerNames(
  servers: readonly { name: string; transport: string; target: string; oauthScope?: string }[],
  catalog: ConnectorCatalog,
): string[] {
  return servers
    .filter((server) => readOnlyScope(server.oauthScope))
    .filter((server) => connectorOfServer(server, catalog)?.connector.auth.type === 'oauth-client')
    .map((server) => server.name);
}

/** What the connection will do before the person clicks: which sign-in it needs, for the confirmation text. */
export function needsSignIn(request: ConnectRequest, connector: Connector | undefined): boolean {
  if (!connector) return !!request.custom?.url && !request.token;
  return connector.auth.type === 'oauth' || connector.auth.type === 'cimd' || connector.auth.type === 'oauth-client';
}

/**
 * Test-only endpoints: `PI_KIT_CONNECTOR_URLS` is JSON of `{ "<id>": "<url>" }` (`"<id>/<variant>"` for a variant) and points a catalog entry at a server on this machine, so the end-to-end tests and the
 * screenshots can run the whole sign-in against a mock. It is ignored in production builds, and a catalog entry's own URL is still what the card shows.
 */
export function endpointOverrides(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  if (env['NODE_ENV'] === 'production' || !env['PI_KIT_CONNECTOR_URLS']) return {};
  try {
    const parsed: unknown = JSON.parse(env['PI_KIT_CONNECTOR_URLS']);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((pair): pair is [string, string] => typeof pair[1] === 'string'),
    );
  } catch {
    return {};
  }
}

/** The URL an entry is written with: an override for this id (and variant), else the catalog's. */
export function endpointFor(
  connector: Connector,
  variant: string | undefined,
  overrides: Record<string, string>,
): string | undefined {
  if (connector.local) return undefined;
  return (variant ? overrides[`${connector.id}/${variant}`] : undefined) ?? overrides[connector.id];
}
