import { Injectable } from '@nestjs/common';
import { AgentCard, Extensions } from '@a2a-js/sdk';
import {
  DefaultRequestHandler,
  JsonRpcTransportHandler,
  ServerCallContext,
  UnauthenticatedUser,
  validateVersion,
  type User,
} from '@a2a-js/sdk/server';
import { InstanceRepository } from '../db/instance.repository';
import { PeersService } from '../peers/peers.service';
import { appVersion } from '../pi/pi-update.service';
import { RoomA2a } from './room-a2a';
import { RoomA2aPushSender } from './room-a2a.push-sender';
import { RoomA2aPushStore } from './room-a2a.push-store';
import { RoomA2aTaskStore } from './room-a2a.task-store';
import { RoomWorkerService } from './room-worker.service';

class PeerUser implements User {
  constructor(private readonly instanceId: string) {}

  get isAuthenticated(): boolean {
    return true;
  }

  get userName(): string {
    return this.instanceId;
  }
}

@Injectable()
export class RoomA2aServer {
  private built: Promise<{ card: AgentCard; rpc: JsonRpcTransportHandler }> | undefined;

  constructor(
    private readonly worker: RoomWorkerService,
    private readonly store: RoomA2aTaskStore,
    private readonly sender: RoomA2aPushSender,
    private readonly pushes: RoomA2aPushStore,
    private readonly peers: PeersService,
    private readonly instance: InstanceRepository,
  ) {}

  async card(origin?: string): Promise<Record<string, unknown>> {
    const { card } = await this.build();
    if (!origin) return AgentCard.toJSON(card) as Record<string, unknown>;
    const manager = await this.peers.manager();
    return AgentCard.toJSON(RoomA2a.card(manager.self.name, appVersion(), this.instance.instanceId, origin)) as Record<
      string,
      unknown
    >;
  }

  async handle(
    caller: string | undefined,
    version: string | undefined,
    extensions: string | undefined,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const answer = await this.serve(caller, version, extensions, body);
    if (!(Symbol.asyncIterator in answer)) return answer;
    await answer.return(undefined);
    return {
      jsonrpc: '2.0',
      id: (body['id'] as string | number | null | undefined) ?? null,
      error: { code: -32004, message: 'This method streams; call it with Accept: text/event-stream.' },
    };
  }

  async serve(
    caller: string | undefined,
    version: string | undefined,
    extensions: string | undefined,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown> | AsyncGenerator<Record<string, unknown>, void, undefined>> {
    const { card, rpc } = await this.build();
    const context = new ServerCallContext({
      user: caller ? new PeerUser(caller) : new UnauthenticatedUser(),
      requestedVersion: version,
      requestedExtensions: Extensions.parseServiceParameter(extensions),
    });
    const id = (body['id'] as string | number | null | undefined) ?? null;
    try {
      validateVersion(context.requestedVersion, card, 'JSONRPC');
    } catch (error) {
      return { jsonrpc: '2.0', id, error: JsonRpcTransportHandler.mapToJSONRPCError(error) };
    }
    const answer = await rpc.handle(body, context);
    return answer as Record<string, unknown> | AsyncGenerator<Record<string, unknown>, void, undefined>;
  }

  private build(): Promise<{ card: AgentCard; rpc: JsonRpcTransportHandler }> {
    this.built ??= (async () => {
      const manager = await this.peers.manager();
      const card = RoomA2a.card(manager.self.name, appVersion(), this.instance.instanceId);
      const handler = new DefaultRequestHandler(card, this.store, this.worker, undefined, this.pushes, this.sender);
      return { card, rpc: new JsonRpcTransportHandler(handler) };
    })().catch((error: unknown) => {
      this.built = undefined;
      throw error;
    });
    return this.built;
  }
}
