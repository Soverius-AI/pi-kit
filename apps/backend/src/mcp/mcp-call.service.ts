import { Injectable } from '@nestjs/common';
import { loadPiInternals, loadPiMcp, type PiInternals } from '../pi/load-pi';
import { createMcpTransport } from '../pi/mcp-transport';
import { PiSessionService } from '../pi/pi-session.service';
import { readMcpEntry, userMcpConfigPath } from './mcp-config';

export interface McpCallResult {
  ok: boolean;
  output: string;
}

@Injectable()
export class McpCallService {
  static readonly TIMEOUT = 90_000;

  constructor(private readonly sessions: PiSessionService) {}

  async call(cwd: string, server: string, tool: string, args: Record<string, unknown>): Promise<McpCallResult> {
    let client: InstanceType<Awaited<ReturnType<typeof loadPiMcp>>['McpClient']> | undefined;
    try {
      const mcp = await loadPiMcp();
      const entry = readMcpEntry(userMcpConfigPath(await this.sessions.agentDir()), server);
      const problem = await this.problemOf(server, entry);
      if (problem || !entry) return { ok: false, output: problem ?? '' };
      const url = McpCallService.oauthUrl(entry);
      const transport = createMcpTransport<Parameters<InstanceType<typeof mcp.McpClient>['connect']>[0]>(
        mcp as never,
        { name: server, config: entry } as never,
        cwd,
        url ? await this.authProvider(server, url, entry['oauth']) : undefined,
      );
      client = new mcp.McpClient({ name: 'pi-kit-rooms', version: '1', requestTimeoutMs: McpCallService.TIMEOUT });
      await client.connect(transport);
      const result = await client.callTool(tool, args, { timeoutMs: McpCallService.TIMEOUT });
      const text = result.content
        .map((part) => (part.type === 'text' ? part.text : `[${part.type}]`))
        .join('\n')
        .trim();
      const output =
        result.structuredContent !== undefined && result.structuredContent !== null
          ? JSON.stringify(result.structuredContent, null, 2)
          : text;
      return { ok: !result.isError, output: output || (result.isError ? `${tool} failed.` : '') };
    } catch (error) {
      return { ok: false, output: error instanceof Error ? error.message : String(error) };
    } finally {
      await client?.close().catch(() => undefined);
    }
  }

  /** Why a room tool could not call `server` now, or undefined when it can. */
  async problem(server: string): Promise<string | undefined> {
    return await this.problemOf(server, readMcpEntry(userMcpConfigPath(await this.sessions.agentDir()), server));
  }

  private async problemOf(server: string, entry: Record<string, unknown> | undefined): Promise<string | undefined> {
    if (!entry) return `No MCP server named ${server} in your mcp.json.`;
    if (entry['enabled'] === false) return `The MCP server ${server} is turned off.`;
    if (typeof entry['url'] !== 'string')
      return typeof entry['command'] === 'string' ? undefined : `The MCP server ${server} names no command or url.`;
    if (entry['auth'] !== undefined)
      return `The MCP server ${server} signs in through a model provider, which room tools cannot use.`;
    const url = McpCallService.oauthUrl(entry);
    if (!url) return undefined;
    const { oauth } = await loadPiInternals();
    return new oauth.McpOAuthCredentialStore().tokens(server, url)
      ? undefined
      : `${server} is not signed in yet. Sign in under Settings, Connectors; room tools then use that sign-in.`;
  }

  /** The URL of a server that signs in with OAuth: an HTTP server with no `Authorization` header of its own. */
  private static oauthUrl(entry: Record<string, unknown>): string | undefined {
    const url = typeof entry['url'] === 'string' ? entry['url'] : undefined;
    const headers = entry['headers'] && typeof entry['headers'] === 'object' ? Object.keys(entry['headers']) : [];
    return url && !headers.some((header) => header.toLowerCase() === 'authorization') ? url : undefined;
  }

  private async authProvider(server: string, url: string, settings: unknown): Promise<unknown> {
    const { oauth, config } = await loadPiInternals();
    const resolved = mcpOAuthSettings(settings, server, config);
    return oauth.createMcpAuthProvider({
      serverUrl: url,
      store: new oauth.McpOAuthCredentialStore().forServer(server, url),
      settings: () => resolved,
      onChallenge: () => undefined,
    });
  }
}

/** The `oauth` block of an `mcp.json` entry as pi-mcp's sign-in settings, the client secret resolved. */
export function mcpOAuthSettings(
  value: unknown,
  server: string,
  config: PiInternals['config'],
): Record<string, unknown> {
  if (!value || typeof value !== 'object') return {};
  const raw = value as Record<string, unknown>;
  const text = (key: string) => (typeof raw[key] === 'string' ? (raw[key] as string) : undefined);
  const secret = text('clientSecret');
  const metadata = text('authServerMetadataUrl');
  return {
    clientId: text('clientId'),
    clientSecret:
      secret === undefined
        ? undefined
        : config.resolveConfigValueOrThrow(secret, `MCP server "${server}" oauth.clientSecret`),
    callbackPort: typeof raw['callbackPort'] === 'number' ? raw['callbackPort'] : undefined,
    callbackUrl: text('callbackUrl'),
    scope: text('scope'),
    clientName: text('clientName'),
    clientRegistration: text('clientRegistration'),
    authServerMetadataUrl: metadata ? new URL(metadata) : undefined,
  };
}
