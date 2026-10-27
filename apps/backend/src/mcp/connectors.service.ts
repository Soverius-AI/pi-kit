import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import {
  CONNECTOR_CATALOG,
  type ConnectRequest,
  type Connector,
  type ConnectorCatalog,
  type ConnectorExposure,
  type McpActionResult,
  connectorAccount,
  connectorById,
  connectorSecretAccount,
  isProviderAccount,
  storedAccountsOf,
} from '@pi-kit/protocol';
import { SecretsService } from '../secrets/secrets.service';
import { PiSessionService } from '../pi/pi-session.service';
import { TrustService } from '../pi/trust.service';
import { ThreadsService } from '../threads/threads.service';
import { buildConnectorEntry, buildCustomEntry, endpointFor, endpointOverrides, needsSignIn } from './connectors';
import { type McpConfigEntry, projectMcpConfigPath, readMcpConfig, readMcpEntry, removeMcpServer, setMcpServerExposure, userMcpConfigPath, writeMcpServer } from './mcp-config';
import { McpService } from './mcp.service';

/**
 * Connectors: the one-click part of MCP. The catalog says what a connector is; this turns a click into pi's own configuration and lets pi do the rest. It writes the entry
 * into the user's `mcp.json` (or, for "project only" and only once the folder is trusted, the folder's `.pi/mcp.json`), reloads the thread's session so pi sees it, and starts pi's sign-in
 * (`McpService.login`, which is `/mcp login`). A token goes to the credential store and the file gets the command that prints it; the OAuth tokens are pi's, in `mcp-auth.json`.
 * Disconnect is the inverse: pi signs out (`/mcp logout`), the entry leaves its file, the stored secrets go, the session reloads.
 */
@Injectable()
export class ConnectorsService {
  constructor(
    private readonly sessions: PiSessionService,
    private readonly threads: ThreadsService,
    private readonly mcp: McpService,
    private readonly secrets: SecretsService,
    private readonly trust: TrustService,
  ) {}

  /**
   * The catalog the gallery shows. It is the one built into this release; the update path (a signed JSON at pi.dev or in the repository, checked against a public key built into the
   * app, `signature` of the schema) is designed and not wired, so there is nothing to fetch yet.
   */
  catalog(): ConnectorCatalog {
    return CONNECTOR_CATALOG;
  }

  async connect(threadId: string | undefined, request: ConnectRequest): Promise<McpActionResult> {
    if (threadId) await this.threads.openSession(threadId);
    const connector = request.id === 'custom' ? undefined : connectorById(request.id, this.catalog());
    if (request.id !== 'custom' && !connector) throw new NotFoundException(`No connector "${request.id}" in the catalog.`);
    if (!connector && !request.custom) throw new BadRequestException('custom: a custom server needs a name and a URL or a command.');
    const name = connector?.id ?? (request.custom as NonNullable<ConnectRequest['custom']>).name;
    const exposure: ConnectorExposure = request.exposure ?? connector?.exposure ?? 'codemode';
    const credential = connector ? (connector.auth.type === 'bearer' || connector.auth.type === 'oauth-client') : !!request.token;

    // Where it goes. A project file is read only for a trusted folder, and nothing with a credential goes into it (mcp.md: keep credentials in the user file).
    let path: string;
    if (request.scope === 'project') {
      if (!threadId) throw new ConflictException('Open a thread in the folder first: "Project only" writes that folder’s .pi/mcp.json.');
      if (credential) throw new BadRequestException('A connector with a token or a client secret stays in your user file; "Project only" is for servers without credentials.');
      const cwd = this.threads.cwdOf(threadId);
      // Answered, not merely "nothing to trust yet": the file this writes is what makes the folder ask.
      if (!(await this.trust.folderTrusted(cwd))) throw new ConflictException('This folder is not trusted yet, so pi would not read its .pi/mcp.json. Trust the folder first.');
      path = projectMcpConfigPath(cwd);
    } else {
      path = userMcpConfigPath(await this.sessions.agentDir());
    }
    if (threadId) this.requireIdle(threadId);

    const notes: string[] = [];
    let entry: Record<string, unknown>;
    if (connector) {
      let authorization: string | undefined;
      let clientSecretCommand: string | undefined;
      if (connector.auth.type === 'bearer') {
        if (!request.token) throw new BadRequestException(`token: paste the ${connector.name} token. ${connector.auth.setup}`);
        authorization = await this.keepToken(connectorAccount(connector.id), request.token, notes);
      } else if (connector.auth.type === 'oauth-client') {
        if (!request.clientId) throw new BadRequestException(`clientId: the client id of your ${connector.name} app is needed. ${connector.auth.setup}`);
        if (request.clientSecret) clientSecretCommand = await this.keepSecret(connectorSecretAccount(connector.id), request.clientSecret, notes);
      }
      entry = buildConnectorEntry(connector, {
        exposure,
        ...(request.variant ? { variant: request.variant } : {}),
        ...(authorization ? { authorization } : {}),
        ...(request.clientId ? { clientId: request.clientId } : {}),
        ...(clientSecretCommand ? { clientSecretCommand } : {}),
        ...overrideUrl(connector, request.variant),
      });
    } else {
      const custom = request.custom as NonNullable<ConnectRequest['custom']>;
      const authorization = request.token ? await this.keepToken(connectorAccount(name), request.token, notes) : undefined;
      entry = buildCustomEntry(custom, exposure, authorization);
    }

    try {
      writeMcpServer(path, name, entry);
    } catch (error) {
      throw new ConflictException(error instanceof Error ? error.message : String(error));
    }
    const added = `Added ${name} to ${path}.`;
    if (!threadId) {
      return { message: [added, 'Open a thread to connect it: pi connects servers when a session starts.', ...notes].join(' '), overview: await this.mcp.overview() };
    }
    // pi reads `mcp.json` when a session starts; the reload is how it sees the new entry.
    await this.sessions.reload(threadId);
    if (needsSignIn(request, connector)) {
      try {
        const login = await this.mcp.login(threadId, name);
        return { message: [added, login.message, ...notes].filter(Boolean).join(' '), ...(login.url ? { url: login.url } : {}), overview: login.overview };
      } catch (error) {
        // The entry is written and the server shows "Needs sign-in"; the card offers the sign-in again.
        notes.push(`The sign-in did not start: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return { message: [added, ...notes].join(' '), overview: await this.mcp.overview(threadId) };
  }

  async disconnect(threadId: string | undefined, name: string): Promise<McpActionResult> {
    const entry = await this.entryOf(threadId, name);
    if (threadId) this.requireIdle(threadId);
    else if (entry.oauth) throw new ConflictException('Open a thread first: signing out of an OAuth server is pi’s job, and it runs in a session.');
    const notes: string[] = [];
    if (threadId && entry.oauth && entry.enabled) {
      // pi deletes the stored credentials of the server; "no stored credentials" is an answer too, not an error.
      try {
        const result = await this.sessions.mcpCommand(threadId, `logout ${name}`, { timeoutMs: 20_000 });
        const said = result.failure ?? result.messages.at(-1)?.text;
        if (said) notes.push(said);
      } catch (error) {
        notes.push(`pi could not sign out: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    // What the entry read from the credential store (a header or variable the details form put there) goes with it.
    const raw = readMcpEntry(entry.source, name);
    try {
      removeMcpServer(entry.source, name);
    } catch (error) {
      throw new ConflictException(error instanceof Error ? error.message : String(error));
    }
    for (const account of [connectorAccount(name), connectorSecretAccount(name), ...(raw ? storedAccountsOf(raw) : [])]) if (isProviderAccount(account)) await this.secrets.forget(account);
    if (threadId) {
      this.mcp.forgetSignIn(threadId, name);
      await this.sessions.reload(threadId);
    }
    return { message: [`Removed ${name} from ${entry.source}.`, ...notes].join(' '), overview: await this.mcp.overview(threadId) };
  }

  async setExposure(threadId: string, name: string, exposure: ConnectorExposure): Promise<McpActionResult> {
    const entry = await this.entryOf(threadId, name);
    this.requireIdle(threadId);
    try {
      const path = setMcpServerExposure(entry, exposure);
      await this.sessions.reload(threadId);
      return { message: `${name} is ${exposure} now, saved to ${path}.`, overview: await this.mcp.overview(threadId) };
    } catch (error) {
      throw new ConflictException(error instanceof Error ? error.message : String(error));
    }
  }

  // ---- internals

  /** Stores a token and returns the `Authorization` value for `mcp.json`: the command that prints it, or (no store) the header itself, with a note that says so. */
  private async keepToken(account: string, token: string, notes: string[]): Promise<string> {
    if (!isProviderAccount(account)) throw new BadRequestException(`"${account}" is not a name the credential store can carry.`);
    const kept = await this.secrets.keepBearer(account, token);
    if (kept.storage === 'mcp.json') notes.push('Protected credential storage is disabled or unavailable, so the token is in mcp.json as plain text (readable by you only).');
    return kept.value;
  }

  private async keepSecret(account: string, secret: string, notes: string[]): Promise<string> {
    const kept = await this.secrets.keep(account, secret);
    if (kept.storage === 'auth.json') notes.push('Protected credential storage is disabled or unavailable, so the client secret is in mcp.json as plain text (readable by you only).');
    return kept.value;
  }

  private async entryOf(threadId: string | undefined, name: string): Promise<McpConfigEntry> {
    const agentDir = await this.sessions.agentDir();
    if (threadId) await this.threads.openSession(threadId);
    const config = readMcpConfig({
      agentDir,
      ...(threadId ? { cwd: this.threads.cwdOf(threadId) } : {}),
      projectTrusted: threadId ? this.sessions.isProjectTrusted(threadId) : false,
    });
    const entry = config.servers.find((e) => e.name === name);
    if (!entry) throw new NotFoundException(`No MCP server "${name}" is configured${threadId ? '' : ' in the user file (open a thread to see a folder’s own servers)'}.`);
    return entry;
  }

  private requireIdle(threadId: string): void {
    if (this.sessions.stats(threadId).streaming) throw new ConflictException('Stop the run first: pi reloads the session to see the change.');
  }
}

/** The URL the end-to-end tests asked for (`PI_KIT_CONNECTOR_URLS`, never in production), as a spread for the entry options. */
function overrideUrl(connector: Connector, variant?: string): { url?: string } {
  const url = endpointFor(connector, variant, endpointOverrides());
  return url ? { url } : {};
}
