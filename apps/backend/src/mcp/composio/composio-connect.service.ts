import { homedir } from 'node:os';
import { BadGatewayException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import {
  COMPOSIO_POPULAR_APPS,
  type ComposioApp,
  type ComposioConnect,
  type ComposioFoundApp,
  type ComposioWireRequest,
} from '@pi-kit/protocol';
import { MetaRepository } from '../../db/meta.repository';
import { PiSessionService } from '../../pi/pi-session.service';
import { McpCallService } from '../mcp-call.service';
import { readMcpConfig } from '../mcp-config';

type WiredApp = Pick<ComposioApp, 'toolkit' | 'name'>;

/** Composio Connect (browser sign-in): Composio keeps the connections; pi-kit only remembers which apps the person chose. */
@Injectable()
export class ComposioConnectService {
  private static readonly HOST = 'connect.composio.dev';
  private static readonly SETTING = 'composio.connect';
  private static readonly MANAGE = 'COMPOSIO_MANAGE_CONNECTIONS';
  private static readonly SEARCH = 'COMPOSIO_SEARCH_TOOLS';

  constructor(
    private readonly meta: MetaRepository,
    private readonly sessions: PiSessionService,
    private readonly mcp: McpCallService,
  ) {}

  private async server(): Promise<string | undefined> {
    const config = readMcpConfig({ agentDir: await this.sessions.agentDir(), projectTrusted: false });
    return config.servers.find((server) => {
      if (server.transport !== 'http' || !server.enabled) return false;
      try {
        return new URL(server.target).host === ComposioConnectService.HOST;
      } catch {
        return false;
      }
    })?.name;
  }

  async state(): Promise<ComposioConnect> {
    return await this.check(await this.wired());
  }

  async wire(request: ComposioWireRequest): Promise<ComposioConnect> {
    if (!(await this.server())) throw new ConflictException('Add Composio under MCP servers and sign in first.');
    const apps = [...(await this.wired()).filter((app) => app.toolkit !== request.toolkit), request];
    await this.meta.setSetting(ComposioConnectService.SETTING, { apps });
    return await this.check(apps);
  }

  async unwire(toolkit: string): Promise<ComposioConnect> {
    const apps = (await this.wired()).filter((app) => app.toolkit !== toolkit);
    await this.meta.setSetting(ComposioConnectService.SETTING, { apps });
    return await this.check(apps);
  }

  /** Apps for a use case or a name, through Composio's own search, which only reads. */
  async search(query: string): Promise<ComposioFoundApp[]> {
    const server = await this.server();
    if (!server) throw new ConflictException('Add Composio under MCP servers and sign in first.');
    const result = await this.mcp.call(homedir(), server, ComposioConnectService.SEARCH, {
      queries: [{ use_case: query }],
      session: { generate_id: true },
    });
    if (!result.ok) throw new BadGatewayException(result.output.slice(0, 500));
    let data: {
      results?: { toolkits?: unknown }[];
      toolkit_connection_statuses?: { toolkit?: unknown; description?: unknown }[];
    };
    try {
      data = (JSON.parse(result.output) as { data?: typeof data }).data ?? {};
    } catch {
      throw new BadGatewayException('Composio answered the search in a form pi-kit does not read.');
    }
    const descriptions = new Map(
      (data.toolkit_connection_statuses ?? []).map((status) => [
        String(status.toolkit),
        String(status.description ?? ''),
      ]),
    );
    const slugs = [
      ...(data.results ?? []).flatMap((item) => (Array.isArray(item.toolkits) ? item.toolkits.map(String) : [])),
      ...descriptions.keys(),
    ].filter((slug) => /^[a-z0-9_-]{1,64}$/.test(slug));
    return [...new Set(slugs)].map((toolkit) => ({
      toolkit,
      name: ComposioConnectService.nameOf(toolkit),
      description: descriptions.get(toolkit) ?? '',
    }));
  }

  private static nameOf(toolkit: string): string {
    return (
      COMPOSIO_POPULAR_APPS.find((app) => app.toolkit === toolkit)?.name ??
      toolkit
        .split(/[_-]/)
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ')
    );
  }

  /** What a room lead is told: the server and the apps the owner chose, unchecked so a room never waits on Composio. */
  async forRooms(): Promise<{ server: string; apps: string[] } | undefined> {
    const server = await this.server();
    const apps = await this.wired();
    return server && apps.length ? { server, apps: apps.map((app) => app.name) } : undefined;
  }

  private async wired(): Promise<WiredApp[]> {
    const value = (await this.meta.getSetting(ComposioConnectService.SETTING)) as { apps?: WiredApp[] } | undefined;
    return Array.isArray(value?.apps) ? value.apps : [];
  }

  /** A fresh Composio page to connect the app (Composio's `add`, which makes a new link each time; it works for 10 minutes). */
  async link(toolkit: string): Promise<ComposioApp> {
    const app = (await this.wired()).find((candidate) => candidate.toolkit === toolkit);
    if (!app) throw new NotFoundException(`${toolkit} is not one of your Composio apps.`);
    const server = await this.server();
    if (!server) throw new ConflictException('Add Composio under MCP servers and sign in first.');
    const result = await this.mcp.call(homedir(), server, ComposioConnectService.MANAGE, {
      toolkits: [{ name: toolkit, action: 'add' }],
    });
    const entry = result.ok
      ? ComposioConnectService.entry(ComposioConnectService.parse(result.output), toolkit)
      : undefined;
    const url = typeof entry?.['redirect_url'] === 'string' ? entry['redirect_url'] : null;
    const connected = !!entry && ComposioConnectService.active(entry);
    return {
      ...app,
      connected,
      signInUrl: connected ? null : url,
      error:
        connected || url
          ? null
          : result.ok
            ? 'Composio sent no page to connect this app.'
            : result.output.slice(0, 500),
    };
  }

  private async check(apps: WiredApp[]): Promise<ComposioConnect> {
    const server = await this.server();
    const unchecked = (error: string | null): ComposioApp[] =>
      apps.map((app) => ({ ...app, connected: false, signInUrl: null, error }));
    if (!server) return { server: null, signedIn: false, problem: null, apps: unchecked(null) };
    const problem = await this.mcp.problem(server);
    if (problem) return { server, signedIn: false, problem, apps: unchecked(null) };
    if (!apps.length) return { server, signedIn: true, problem: null, apps: unchecked(null) };
    const result = await this.mcp.call(homedir(), server, ComposioConnectService.MANAGE, {
      toolkits: apps.map((app) => ({ name: app.toolkit, action: 'list' })),
    });
    const results = result.ok ? ComposioConnectService.parse(result.output) : undefined;
    if (!results) return { server, signedIn: true, problem: result.output.slice(0, 500), apps: unchecked(null) };
    return {
      server,
      signedIn: true,
      problem: null,
      apps: apps.map((app) => {
        const entry = ComposioConnectService.entry(results, app.toolkit);
        return {
          ...app,
          connected: !!entry && ComposioConnectService.active(entry),
          signInUrl: null,
          error: entry ? null : 'Composio does not know this app.',
        };
      }),
    };
  }

  /** `data.results` of a COMPOSIO_MANAGE_CONNECTIONS answer: one entry per toolkit, `{ status, redirect_url?, accounts: [{ id, status }] }`. */
  private static parse(output: string): Record<string, unknown> | undefined {
    try {
      const results = (JSON.parse(output) as { data?: { results?: unknown } }).data?.results;
      return results && typeof results === 'object' ? (results as Record<string, unknown>) : undefined;
    } catch {
      return undefined;
    }
  }

  private static entry(
    results: Record<string, unknown> | undefined,
    toolkit: string,
  ): Record<string, unknown> | undefined {
    const entry = results?.[toolkit];
    return entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : undefined;
  }

  /** The entry's own `status` says "initiated" even with no account, so only an account counts. */
  private static active(entry: Record<string, unknown>): boolean {
    const accounts = Array.isArray(entry['accounts']) ? (entry['accounts'] as { status?: unknown }[]) : [];
    return accounts.some((account) => typeof account?.status === 'string' && account.status.toUpperCase() === 'ACTIVE');
  }
}
