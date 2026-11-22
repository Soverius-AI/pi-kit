import { Injectable } from '@nestjs/common';
import { RoomListSchema, type RoomDirectoryEntry } from '@pi-kit/protocol';
import { RoomsRepository } from '../db/rooms.repository';
import { PeerProxy } from '../peers/peer-proxy';
import { PeersService } from '../peers/peers.service';
import { RoomsService } from './rooms.service';

@Injectable()
export class RoomDirectoryService {
  constructor(
    private readonly rooms: RoomsRepository,
    private readonly hosted: RoomsService,
    private readonly proxy: PeerProxy,
    private readonly peers: PeersService,
  ) {}

  async list(now = Date.now()): Promise<RoomDirectoryEntry[]> {
    const manager = await this.peers.manager();
    const active = manager.peers.filter((peer) => peer.state === 'active');
    await Promise.all(active.map(async (peer) => await this.refresh(peer.peerId, peer.name, now)));
    await this.rooms.forgetHostsExcept(active.map((peer) => peer.peerId));
    const local = (await this.hosted.hosted()).map((room): RoomDirectoryEntry => ({
      room,
      hostName: manager.self.name,
      local: true,
      hostReachable: true,
      lastSeenAt: now,
    }));
    const remote = (await this.rooms.directory()).map((entry): RoomDirectoryEntry => ({ ...entry, local: false }));
    return [...local, ...remote].sort((a, b) => b.room.createdAt - a.room.createdAt);
  }

  private async refresh(peerId: string, name: string, now: number): Promise<void> {
    try {
      const answer = await this.proxy.call(peerId, '/api/rooms', 'GET', undefined, {
        signal: AbortSignal.timeout(5000),
      });
      if (answer.status === 404) return await this.rooms.rememberHost(peerId, name, [], now);
      const parsed = answer.status === 200 ? RoomListSchema.safeParse(answer.body) : undefined;
      if (parsed?.success) return await this.rooms.rememberHost(peerId, name, parsed.data, now);
      await this.rooms.hostUnreachable(peerId, name);
    } catch {
      await this.rooms.hostUnreachable(peerId, name);
    }
  }
}
