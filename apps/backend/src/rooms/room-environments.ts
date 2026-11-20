import { Injectable } from '@nestjs/common';
import { defaultEnvironmentLook, type RoomWorkerCandidate } from '@pi-kit/protocol';
import { InstanceRepository } from '../db/instance.repository';
import { RoomA2a } from './room-a2a';
import { RoomA2aAgents } from './room-a2a-agents';
import { RoomA2aClient } from './room-a2a.client';
import { PeersService } from '../peers/peers.service';

@Injectable()
export class RoomEnvironments {
  constructor(
    private readonly instance: InstanceRepository,
    private readonly a2a: RoomA2aClient,
    private readonly agents: RoomA2aAgents,
    private readonly peers: PeersService,
  ) {}

  async list(options: { agents?: boolean } = {}): Promise<RoomWorkerCandidate[]> {
    const manager = await this.peers.manager();
    const local: RoomWorkerCandidate = {
      environmentId: this.instance.instanceId,
      name: manager.self.name,
      local: true,
      ready: true,
      reason: null,
      look: await this.instance.look(),
    };
    const remote = await Promise.all(
      manager.peers
        .filter((peer) => peer.state === 'active')
        .map(async (peer): Promise<RoomWorkerCandidate> => {
          const [look, card] = await Promise.all([
            this.a2a.look(peer.peerId).catch(() => undefined),
            this.a2a.card(peer.peerId).catch(() => undefined),
          ]);
          const base = {
            environmentId: peer.peerId,
            name: peer.name,
            local: false,
            look: look ?? defaultEnvironmentLook(peer.peerId),
          };
          if (!card) return { ...base, ready: false, reason: `${peer.name} is offline.` };
          if (card.status === 200 && RoomA2a.takesRoomTasks(card.card)) return { ...base, ready: true, reason: null };
          return {
            ...base,
            ready: false,
            reason:
              card.status === 404
                ? `Rooms are off on ${peer.name}.`
                : card.status === 200
                  ? `${peer.name} speaks no compatible A2A version. Update pi-kit there.`
                  : `${peer.name} cannot take rooms now.`,
          };
        }),
    );
    const outside = await Promise.all(
      (options.agents ? await this.agents.list() : []).map(async (agent): Promise<RoomWorkerCandidate> => {
        const base = { environmentId: agent.id, name: agent.name, local: false };
        try {
          await Promise.race([
            this.agents.card(agent.id),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000).unref?.()),
          ]);
          return { ...base, ready: true, reason: null };
        } catch {
          return { ...base, ready: false, reason: `${agent.name} does not answer.` };
        }
      }),
    );
    return [local, ...remote, ...outside];
  }
}
