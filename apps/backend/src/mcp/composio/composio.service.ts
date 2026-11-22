import { BadGatewayException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { ComposioAddRequest, ComposioConnection, ComposioStatus, ComposioToolkit } from '@pi-kit/protocol';
import { MetaRepository } from '../../db/meta.repository';
import { loadPiInternals } from '../../pi/load-pi';
import { PiSessionService } from '../../pi/pi-session.service';
import { SecretsService } from '../../secrets/secrets.service';
import { readMcpConfig, userMcpConfigPath, writeMcpServer } from '../mcp-config';

type ComposioServer = Pick<ComposioConnection, 'toolkit' | 'name' | 'readOnly'> & { sessionId: string };

interface ComposioSetting {
  key?: string;
  storage?: 'keychain' | 'plain';
  servers: Record<string, ComposioServer>;
}

@Injectable()
export class ComposioService {
  static readonly SETTING = 'composio';
  static readonly ACCOUNT = 'composio-api-key';
  static readonly TIMEOUT = 20_000;
  private resolved: { reference: string; key: string } | undefined;

  constructor(
    private readonly meta: MetaRepository,
    private readonly secrets: SecretsService,
    private readonly sessions: PiSessionService,
  ) {}

  /** The apps added read only: Composio leaves out every tool that creates, updates or deletes. */
  async readOnlyServers(): Promise<ReadonlySet<string>> {
    const { servers } = await this.setting();
    return new Set(Object.keys(servers).filter((server) => servers[server]?.readOnly));
  }

  async status(): Promise<ComposioStatus> {
    const setting = await this.setting();
    return { configured: !!setting.key, storage: setting.storage ?? null };
  }

  async setKey(apiKey: string): Promise<ComposioStatus> {
    await this.request('GET', '/toolkits?limit=1', undefined, apiKey);
    const kept = await this.secrets.keep(ComposioService.ACCOUNT, apiKey);
    const setting = await this.setting();
    await this.save({ ...setting, key: kept.value, storage: kept.storage === 'keychain' ? 'keychain' : 'plain' });
    return await this.status();
  }

  async forgetKey(): Promise<ComposioStatus> {
    const setting = await this.setting();
    if ((await this.live(setting)).length)
      throw new ConflictException('Remove the Composio apps under MCP servers first; they use this key.');
    await this.secrets.forget(ComposioService.ACCOUNT);
    await this.save({ servers: {} });
    return await this.status();
  }

  async toolkits(search?: string): Promise<ComposioToolkit[]> {
    const query = new URLSearchParams({ limit: '30', ...(search?.trim() ? { search: search.trim() } : {}) });
    const answer = (await this.request('GET', `/toolkits?${query.toString()}`)) as {
      items?: {
        slug: string;
        name: string;
        no_auth?: boolean;
        meta?: { description?: string; logo?: string; tools_count?: number };
      }[];
    };
    return (answer.items ?? []).map((item) => ({
      slug: item.slug,
      name: item.name,
      description: item.meta?.description ?? '',
      logo: item.meta?.logo ?? null,
      tools: item.meta?.tools_count ?? 0,
      noAuth: !!item.no_auth,
    }));
  }

  async add(request: ComposioAddRequest): Promise<ComposioConnection> {
    const setting = await this.setting();
    if (!setting.key) throw new ConflictException('Add your Composio API key first.');
    const server = `composio-${request.toolkit.replace(/_/g, '-')}${request.readOnly ? '' : '-write'}`;
    const session = (await this.request('POST', '/tool_router/session', {
      user_id: `pi-kit-${this.meta.instanceId}`,
      toolkits: { enable: [request.toolkit] },
      ...(request.readOnly ? { tags: { disable: ['createHint', 'updateHint', 'destructiveHint'] } } : {}),
      preload: { tools: 'all' },
      search: { enable: false },
      manage_connections: { enable: false },
      workbench: { enable: false },
      execute: { enable_multi_execute: false },
    })) as { session_id: string; mcp?: { url?: string } };
    if (!session.mcp?.url) throw new BadGatewayException('Composio did not answer with an MCP address.');
    writeMcpServer(userMcpConfigPath(await this.sessions.agentDir()), server, {
      url: session.mcp.url,
      headers: { 'x-api-key': setting.key },
      description: `${request.name} through Composio${request.readOnly ? ', read only' : ''}.`,
      exposure: 'deferred',
    });
    const record: ComposioServer = {
      sessionId: session.session_id,
      toolkit: request.toolkit,
      name: request.name,
      readOnly: request.readOnly,
    };
    await this.save({ ...setting, servers: { ...setting.servers, [server]: record } });
    return await this.connection(server, record, true);
  }

  async connections(): Promise<ComposioConnection[]> {
    return await Promise.all(
      (await this.live(await this.setting())).map(([server, record]) => this.connection(server, record, false)),
    );
  }

  async link(server: string): Promise<ComposioConnection> {
    const record = (await this.setting()).servers[server];
    if (!record) throw new NotFoundException(`${server} is not a Composio app pi-kit added.`);
    return await this.connection(server, record, true);
  }

  private async connection(server: string, record: ComposioServer, withLink: boolean): Promise<ComposioConnection> {
    const status = (await this.request(
      'GET',
      `/tool_router/session/${encodeURIComponent(record.sessionId)}/toolkits?toolkits=${encodeURIComponent(record.toolkit)}`,
    )) as { items?: { slug: string; is_no_auth?: boolean; connected_account?: { status?: string } | null }[] };
    const item = status.items?.find((candidate) => candidate.slug === record.toolkit);
    const connected = !!item?.is_no_auth || item?.connected_account?.status === 'ACTIVE';
    let signInUrl: string | null = null;
    if (!connected && withLink) {
      const link = (await this.request('POST', `/tool_router/session/${encodeURIComponent(record.sessionId)}/link`, {
        toolkit: record.toolkit,
      })) as { redirect_url?: string };
      signInUrl = link.redirect_url ?? null;
    }
    return { server, toolkit: record.toolkit, name: record.name, readOnly: record.readOnly, connected, signInUrl };
  }

  private async live(setting: ComposioSetting): Promise<[string, ComposioServer][]> {
    const config = readMcpConfig({ agentDir: await this.sessions.agentDir(), projectTrusted: false });
    const names = new Set(config.servers.map((server) => server.name));
    return Object.entries(setting.servers).filter(([server]) => names.has(server));
  }

  private async request(method: 'GET' | 'POST', path: string, body?: unknown, key?: string): Promise<unknown> {
    const apiKey = key ?? (await this.key());
    let response: Response;
    try {
      response = await fetch(`${this.base()}${path}`, {
        method,
        headers: { 'x-api-key': apiKey, ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(ComposioService.TIMEOUT),
      });
    } catch (error) {
      throw new BadGatewayException(
        `Composio did not answer: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const text = await response.text();
    if (response.status === 401 || response.status === 403)
      throw new ConflictException('Composio refused the API key. Check it in your Composio project settings.');
    if (!response.ok) {
      let message = text.slice(0, 300);
      try {
        const parsed = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
        message =
          (typeof parsed.error === 'object' ? parsed.error?.message : parsed.error) ?? parsed.message ?? message;
      } catch {
        message = text.slice(0, 300);
      }
      throw new BadGatewayException(`Composio answered ${response.status}: ${message}`);
    }
    return text ? (JSON.parse(text) as unknown) : {};
  }

  private async key(): Promise<string> {
    const setting = await this.setting();
    if (!setting.key) throw new ConflictException('Add your Composio API key first.');
    if (this.resolved?.reference !== setting.key)
      this.resolved = {
        reference: setting.key,
        key: (await loadPiInternals()).config.resolveConfigValueOrThrow(setting.key, 'The Composio API key'),
      };
    return this.resolved.key;
  }

  private base(): string {
    const override = process.env['PI_KIT_COMPOSIO_URL'];
    return process.env['NODE_ENV'] !== 'production' && override ? override : 'https://backend.composio.dev/api/v3.1';
  }

  private async setting(): Promise<ComposioSetting> {
    const value = (await this.meta.getSetting(ComposioService.SETTING)) as Partial<ComposioSetting> | undefined;
    return { ...value, servers: value?.servers ?? {} };
  }

  private async save(setting: ComposioSetting): Promise<void> {
    await this.meta.setSetting(ComposioService.SETTING, setting);
  }
}
