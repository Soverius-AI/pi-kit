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
      if (!entry) return { ok: false, output: `No MCP server named ${server} in your mcp.json.` };
      if (entry['enabled'] === false) return { ok: false, output: `The MCP server ${server} is turned off.` };
      const transport = await this.transport(mcp, server, entry, cwd);
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

  private async transport(
    mcp: Awaited<ReturnType<typeof loadPiMcp>>,
    server: string,
    entry: Record<string, unknown>,
    cwd: string,
  ) {
    const url = typeof entry['url'] === 'string' ? entry['url'] : undefined;
    if (!url && typeof entry['command'] !== 'string')
      throw new Error(`The MCP server ${server} names no command or url.`);
    if (url && entry['auth'] !== undefined)
      throw new Error(`The MCP server ${server} signs in through a model provider, which room tools cannot use.`);
    const headers = entry['headers'] && typeof entry['headers'] === 'object' ? Object.keys(entry['headers']) : [];
    const oauth = !!url && !headers.some((header) => header.toLowerCase() === 'authorization');
    const authProvider = oauth ? await this.authProvider(server, url, entry['oauth']) : undefined;
    return createMcpTransport<Parameters<InstanceType<typeof mcp.McpClient>['connect']>[0]>(
      mcp as never,
      { name: server, config: entry } as never,
      cwd,
      authProvider,
    );
  }

  private async authProvider(server: string, url: string, settings: unknown): Promise<unknown> {
    const { oauth, config } = await loadPiInternals();
    const store = new oauth.McpOAuthCredentialStore();
    if (!store.tokens(server, url))
      throw new Error(
        `${server} is not signed in yet. Sign in once under Settings, Connectors (or with /mcp in a thread); room tools then use that sign-in.`,
      );
    const resolved = this.oauthSettings(settings, server, config);
    return oauth.createMcpAuthProvider({
      serverUrl: url,
      store: store.forServer(server, url),
      settings: () => resolved,
      onChallenge: () => undefined,
    });
  }

  private oauthSettings(value: unknown, server: string, config: PiInternals['config']): Record<string, unknown> {
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
}
