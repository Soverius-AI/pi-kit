import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type {
  AgentCard,
  CancelTaskRequest,
  GetTaskRequest,
  Message,
  SendMessageRequest,
  StreamResponse,
  SubscribeToTaskRequest,
  Task,
} from '@a2a-js/sdk';
import {
  ClientFactory,
  ClientFactoryOptions,
  DefaultAgentCardResolver,
  JsonRpcTransportFactory,
  RestTransportFactory,
  ServiceParameters,
  withA2AExtensions,
  type Client,
} from '@a2a-js/sdk/client';
import { A2A_ROOM_EXTENSION, type A2aAgent, type AddA2aAgent } from '@pi-kit/protocol';
import { A2aAgentsRepository, type A2aAgentRow } from '../db/a2a-agents.repository';
import { SecretsService } from '../secrets/secrets.service';
import { A2aOffline } from './room-a2a.client';

export const NO_AGENT = 'No A2A agent with this id.';

@Injectable()
export class RoomA2aAgents {
  static readonly CARD_FILE = 'agent-card.json';
  fetchImpl: typeof fetch = (input, init) => fetch(input, init);
  private readonly tokens = new Map<string, string | undefined>();
  private readonly clients = new Map<string, Promise<{ client: Client; card: AgentCard }>>();

  constructor(
    private readonly agents: A2aAgentsRepository,
    private readonly secrets: SecretsService,
  ) {}

  async list(): Promise<A2aAgent[]> {
    return (await this.agents.list()).map((row) => this.visible(row));
  }

  async get(id: string): Promise<A2aAgentRow | undefined> {
    return await this.agents.get(id);
  }

  async add(input: AddA2aAgent): Promise<A2aAgent> {
    const token = input.token?.trim() || undefined;
    let card: AgentCard;
    try {
      card = await this.resolver(token).resolve(...RoomA2aAgents.cardAddress(input.url));
    } catch (error) {
      throw new BadRequestException(
        `No A2A agent card at ${input.url}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (
      !card.supportedInterfaces.some(
        (face) => face.protocolBinding === 'JSONRPC' || face.protocolBinding === 'HTTP+JSON',
      )
    )
      throw new BadRequestException('The agent offers neither JSON-RPC nor HTTP+JSON, which pi-kit speaks.');
    const id = randomUUID();
    let tokenStorage: A2aAgentRow['tokenStorage'] = 'none';
    let stored: string | null = null;
    if (token) {
      if ((await this.secrets.credentialsEnabled()) && this.secrets.store.available()) {
        await this.secrets.store.set(this.account(id), token);
        tokenStorage = 'keychain';
      } else {
        tokenStorage = 'database';
        stored = token;
      }
    }
    const row: A2aAgentRow = {
      id,
      url: input.url,
      name: (card.name || input.url).slice(0, 200),
      tokenStorage,
      token: stored,
      createdAt: Date.now(),
    };
    await this.agents.insert(row);
    this.tokens.set(id, token);
    return this.visible(row);
  }

  async remove(id: string): Promise<void> {
    const row = await this.agents.get(id);
    if (!row) throw new NotFoundException(NO_AGENT);
    if (row.tokenStorage === 'keychain')
      await Promise.resolve(this.secrets.store.delete(this.account(id))).catch(() => undefined);
    await this.agents.delete(id);
    this.tokens.delete(id);
    this.clients.delete(id);
  }

  async card(id: string): Promise<AgentCard> {
    return (await this.connect(id)).card;
  }

  async sendMessage(id: string, request: SendMessageRequest): Promise<Task | Message> {
    return await this.call(
      id,
      async ({ client, card }, signal) => await client.sendMessage(request, this.options(card, signal)),
    );
  }

  async getTask(id: string, request: GetTaskRequest): Promise<Task> {
    return await this.call(
      id,
      async ({ client, card }, signal) => await client.getTask(request, this.options(card, signal)),
    );
  }

  async cancelTask(id: string, request: CancelTaskRequest): Promise<Task> {
    return await this.call(
      id,
      async ({ client, card }, signal) => await client.cancelTask(request, this.options(card, signal)),
    );
  }

  async streams(id: string): Promise<boolean> {
    return !!(await this.connect(id)).card.capabilities?.streaming;
  }

  async *subscribe(id: string, request: SubscribeToTaskRequest, signal: AbortSignal): AsyncGenerator<StreamResponse> {
    const { client, card } = await this.connect(id);
    if (!card.capabilities?.streaming) return;
    yield* client.resubscribeTask(request, {
      signal,
      serviceParameters: RoomA2aAgents.speaksRooms(card)
        ? ServiceParameters.createFrom(undefined, withA2AExtensions(A2A_ROOM_EXTENSION))
        : undefined,
    });
  }

  static speaksRooms(card: AgentCard): boolean {
    return !!card.capabilities?.extensions?.some((extension) => extension.uri === A2A_ROOM_EXTENSION);
  }

  static cardAddress(url: string): [string, string] {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith(`/${RoomA2aAgents.CARD_FILE}`)) {
      const file = parsed.pathname.split('/').pop() ?? RoomA2aAgents.CARD_FILE;
      return [new URL('.', parsed).href, file];
    }
    if (!parsed.pathname.endsWith('/')) parsed.pathname = `${parsed.pathname}/`;
    return [parsed.href, `.well-known/${RoomA2aAgents.CARD_FILE}`];
  }

  private options(card: AgentCard, signal: AbortSignal) {
    return {
      signal,
      serviceParameters: RoomA2aAgents.speaksRooms(card)
        ? ServiceParameters.createFrom(undefined, withA2AExtensions(A2A_ROOM_EXTENSION))
        : undefined,
    };
  }

  private async call<T>(
    id: string,
    run: (connection: { client: Client; card: AgentCard }, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const connection = await this.connect(id);
    try {
      return await run(connection, AbortSignal.timeout(30_000));
    } catch (error) {
      this.clients.delete(id);
      throw error;
    }
  }

  private connect(id: string): Promise<{ client: Client; card: AgentCard }> {
    let pending = this.clients.get(id);
    if (!pending) {
      pending = (async () => {
        const row = await this.agents.get(id);
        if (!row) throw new NotFoundException(NO_AGENT);
        const token = await this.token(row);
        const fetchImpl = this.authorized(token);
        const card = await new DefaultAgentCardResolver({ fetchImpl }).resolve(...RoomA2aAgents.cardAddress(row.url));
        if (card.name && card.name !== row.name) await this.agents.rename(id, card.name.slice(0, 200));
        const factory = new ClientFactory(
          ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
            transports: [new JsonRpcTransportFactory({ fetchImpl }), new RestTransportFactory({ fetchImpl })],
            preferredTransports: ['JSONRPC', 'HTTP+JSON'],
          }),
        );
        return { client: await factory.createFromAgentCard(card), card };
      })();
      pending.catch(() => this.clients.delete(id));
      this.clients.set(id, pending);
    }
    return pending;
  }

  private resolver(token: string | undefined): DefaultAgentCardResolver {
    return new DefaultAgentCardResolver({ fetchImpl: this.authorized(token) });
  }

  private authorized(token: string | undefined): typeof fetch {
    return async (input, init = {}) => {
      const headers = new Headers(init.headers);
      if (token && !headers.has('authorization')) headers.set('authorization', `Bearer ${token}`);
      try {
        return await this.fetchImpl(input, { ...init, headers });
      } catch (error) {
        throw new A2aOffline(error instanceof Error ? error.message : String(error), { cause: error });
      }
    };
  }

  private async token(row: A2aAgentRow): Promise<string | undefined> {
    if (this.tokens.has(row.id)) return this.tokens.get(row.id);
    const token =
      row.tokenStorage === 'keychain'
        ? ((await this.secrets.store.get(this.account(row.id))) ?? undefined)
        : row.tokenStorage === 'database'
          ? (row.token ?? undefined)
          : undefined;
    this.tokens.set(row.id, token);
    return token;
  }

  private account(id: string): string {
    return `a2a-agent-${id}`;
  }

  private visible(row: A2aAgentRow): A2aAgent {
    return { id: row.id, name: row.name, url: row.url, tokenStorage: row.tokenStorage, createdAt: row.createdAt };
  }
}
