import { describe, expect, it, vi } from 'vitest';
import { ROOMS_PERSONAL_ACCEPT, RoomSchema, type Room } from '@pi-kit/protocol';
import { RoomsController } from './rooms.controller';
import { RoomDirectoryService } from './room-directory.service';
import type { RoomsRepository } from '../db/rooms.repository';
import type { PeerProxy } from '../peers/peer-proxy';
import type { PeersService } from '../peers/peers.service';
import type { RoomsService } from './rooms.service';

const personal: Room = {
  id: 'fbd21ddd-fabd-4c89-a37f-560bec46970e',
  title: 'Personal',
  repository: '',
  baseCommit: '',
  hostInstanceId: '15754a13-d51f-41bd-b4cc-c63600ea4146',
  waiting: 0,
  createdAt: 1,
};
const repository: Room = {
  ...personal,
  id: 'd510dbed-2f9a-4c56-a6ac-dc622c3311a1',
  title: 'Repository',
  repository: 'repo',
  baseCommit: 'a'.repeat(40),
};

describe('personal room peer compatibility', () => {
  it('keeps repository rooms visible to old peers while local owners and capable peers see all rooms', async () => {
    const rooms = { hosted: vi.fn().mockResolvedValue([personal, repository]) };
    const hosted = (peer?: string, accept?: string): Promise<Room[]> =>
      Reflect.apply(RoomsController.prototype.hosted, { rooms }, [{ headers: { 'x-pi-peer-id': peer, accept } }]);
    expect(await hosted()).toEqual([personal, repository]);
    expect(await hosted('old-peer', 'application/json')).toEqual([repository]);
    expect(await hosted('new-peer', `application/json, ${ROOMS_PERSONAL_ACCEPT}`)).toEqual([personal, repository]);
    const legacy = RoomSchema.extend({
      repository: RoomSchema.shape.repository.min(1),
      baseCommit: RoomSchema.shape.baseCommit.regex(/^[0-9a-f]{40,64}$/),
    }).array();
    expect(legacy.safeParse(await hosted('old-peer')).success).toBe(true);
  });
  it('advertises personal-room support when refreshing paired hosts', async () => {
    const call = vi.fn().mockResolvedValue({ status: 200, body: [personal, repository] });
    const rememberHost = vi.fn();
    const service = new RoomDirectoryService(
      {
        rememberHost,
        forgetHostsExcept: vi.fn(),
        directory: vi.fn().mockResolvedValue([]),
      } as unknown as RoomsRepository,
      { hosted: vi.fn().mockResolvedValue([]) } as unknown as RoomsService,
      { call } as unknown as PeerProxy,
      {
        manager: vi.fn().mockResolvedValue({
          peers: [{ peerId: 'peer', name: 'Other host', state: 'active' }],
          self: { name: 'Here' },
        }),
      } as unknown as PeersService,
    );
    await service.list(100);
    expect(call).toHaveBeenCalledWith(
      'peer',
      '/api/rooms',
      'GET',
      undefined,
      expect.objectContaining({ headers: { accept: ROOMS_PERSONAL_ACCEPT } }),
    );
    expect(rememberHost).toHaveBeenCalledWith('peer', 'Other host', [personal, repository], 100);
  });
});
