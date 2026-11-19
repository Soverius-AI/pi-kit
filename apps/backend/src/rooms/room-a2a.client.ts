import { Injectable } from '@nestjs/common';
import { AgentCard, type CancelTaskRequest, type SendMessageRequest, type Task, type Message } from '@a2a-js/sdk';
import {
  ClientFactory,
  ClientFactoryOptions,
  DefaultAgentCardResolver,
  JsonRpcTransportFactory,
  ServiceParameters,
  withA2AExtensions,
  type Client,
} from '@a2a-js/sdk/client';
import { A2A_ROOM_EXTENSION, A2A_VERSION_HEADER } from '@pi-kit/protocol';
import { PeerProxy } from '../peers/peer-proxy';
import { A2A_CARD_PATH, A2A_PATH, RoomA2a } from './room-a2a';

export class A2aOffline extends Error {}

@Injectable()
export class RoomA2aClient {
  private readonly clients = new Map<string, Promise<Client>>();
  private readonly factory: ClientFactory;
  private readonly resolver: DefaultAgentCardResolver;

  constructor(private readonly proxy: PeerProxy) {
    const fetchImpl = this.fetch.bind(this) as typeof fetch;
    this.resolver = new DefaultAgentCardResolver({ fetchImpl });
    this.factory = new ClientFactory(
      ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
        transports: [new JsonRpcTransportFactory({ fetchImpl })],
        cardResolver: this.resolver,
        preferredTransports: ['JSONRPC'],
      }),
    );
  }

  async card(peerId: string, timeout = 5000): Promise<{ status: number; card?: AgentCard }> {
    const answer = await this.proxy.call(peerId, A2A_CARD_PATH, 'GET', undefined, {
      signal: AbortSignal.timeout(timeout),
      headers: { [A2A_VERSION_HEADER]: '1.0' },
    });
    if (answer.status !== 200 || typeof answer.body !== 'object' || !answer.body) return { status: answer.status };
    try {
      return { status: answer.status, card: this.resolver.normalizeAgentCard(answer.body) };
    } catch {
      return { status: answer.status };
    }
  }

  async sendMessage(peerId: string, request: SendMessageRequest, timeout = 20_000): Promise<Task | Message> {
    return await this.call(
      peerId,
      async (client, signal) => await client.sendMessage(request, this.options(signal)),
      timeout,
    );
  }

  async cancelTask(peerId: string, request: CancelTaskRequest, timeout = 10_000): Promise<Task> {
    return await this.call(
      peerId,
      async (client, signal) => await client.cancelTask(request, this.options(signal)),
      timeout,
    );
  }

  static isOffline(error: unknown): boolean {
    for (let cause: unknown = error; cause; cause = (cause as { cause?: unknown }).cause)
      if (cause instanceof A2aOffline) return true;
    return false;
  }

  private options(signal: AbortSignal) {
    return {
      signal,
      serviceParameters: ServiceParameters.createFrom(undefined, withA2AExtensions(A2A_ROOM_EXTENSION)),
    };
  }

  private async call<T>(
    peerId: string,
    run: (client: Client, signal: AbortSignal) => Promise<T>,
    timeout: number,
  ): Promise<T> {
    let pending = this.clients.get(peerId);
    if (!pending) {
      pending = this.factory.createFromUrl(RoomA2a.peerUrl(peerId, `${A2A_PATH}/`));
      this.clients.set(peerId, pending);
    }
    try {
      return await run(await pending, AbortSignal.timeout(timeout));
    } catch (error) {
      this.clients.delete(peerId);
      throw error;
    }
  }

  private async fetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const target = RoomA2a.parsePeerUrl(url);
    if (!target) throw new A2aOffline(`Rooms reach other agents only through paired pi-kits, not ${url}.`);
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, name) => {
      if (name.startsWith('a2a-')) headers[name] = value;
    });
    const body = typeof init.body === 'string' && init.body ? (JSON.parse(init.body) as unknown) : undefined;
    let answer: { status: number; body: unknown };
    try {
      answer = await this.proxy.call(target.instanceId, target.path, init.method ?? 'GET', body, {
        signal: init.signal ?? AbortSignal.timeout(20_000),
        headers,
        limit: 32 * 1024 * 1024,
      });
    } catch (error) {
      throw new A2aOffline(error instanceof Error ? error.message : String(error), { cause: error });
    }
    const text =
      answer.body === undefined || answer.body === ''
        ? null
        : typeof answer.body === 'string'
          ? answer.body
          : JSON.stringify(answer.body);
    return new Response(answer.status === 204 ? null : text, {
      status: answer.status,
      headers: { 'content-type': 'application/json' },
    });
  }
}
