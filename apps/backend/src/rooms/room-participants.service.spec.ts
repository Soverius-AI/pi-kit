import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type PlaybookParticipant,
  PlaybookConfigSchema,
  RoomParticipantsSchema,
  RoomParticipantInputSchema,
} from '@pi-kit/protocol';
import { DatabaseService } from '../db/database.service';
import { RoomsRepository } from '../db/rooms.repository';
import { RoomParticipantsRepository } from '../db/room-participants.repository';
import { InstanceRepository } from '../db/instance.repository';
import { RoomParticipants } from './room-participants.service';
import type { RoomPlaybookFiles } from './room-playbook-files.service';
import type { RoomAgents } from './room-agents';
import type { RoomEnvironments } from './room-environments';
import type { RoomA2aAgents } from './room-a2a-agents';
import type { PeersService } from '../peers/peers.service';
import type { RoomLeadService } from './room-lead.service';
let folder: string,
  db: DatabaseService,
  rooms: RoomsRepository,
  store: RoomParticipantsRepository,
  roster: RoomParticipants,
  roomId: string;
let inherited: PlaybookParticipant[];
const rebriefNext = vi.fn();
const machines = [{ environmentId: 'here', name: 'Here', local: true, ready: true, reason: null }];
const outside = {
  get: vi.fn(async (id: string) => (id === 'registered' ? { id } : undefined)),
  list: vi.fn(async () => []),
  remove: vi.fn(),
};
const member = (role: string): PlaybookParticipant => ({
  role,
  agent: { local: true },
  instructions: `Help as ${role}.`,
});
async function createRoom(id: string) {
  await rooms.insert({
    id,
    title: 'Personal',
    repository: '',
    baseCommit: '',
    summary: '',
    sourceThreadId: null,
    projectFolder: null,
    createdAt: Date.now(),
  });
}
beforeEach(async () => {
  folder = mkdtempSync(join(tmpdir(), 'room-participants-'));
  db = await DatabaseService.create({ dataDir: folder });
  rooms = new RoomsRepository(db);
  store = new RoomParticipantsRepository(db);
  roomId = randomUUID();
  await createRoom(roomId);
  inherited = [];
  vi.clearAllMocks();
  roster = new RoomParticipants(
    rooms,
    store,
    { place: () => ({}), load: () => ({ config: { participants: inherited } }) } as unknown as RoomPlaybookFiles,
    { projectFolder: async () => folder } as unknown as RoomAgents,
    { list: async () => machines } as unknown as RoomEnvironments,
    outside as unknown as RoomA2aAgents,
    {
      manager: async () => ({ self: { name: 'Here' }, peers: [{ peerId: 'paired', name: 'Laptop', state: 'active' }] }),
    } as unknown as PeersService,
    new InstanceRepository(db),
    { rebriefNext } as unknown as RoomLeadService,
  );
});
afterEach(async () => {
  await db.onApplicationShutdown();
  rmSync(folder, { recursive: true, force: true });
});
describe('room-local collaborators', () => {
  it('lists ordinary personal room targets without creating a lead, thread, or playbook', async () => {
    expect(await roster.list(roomId)).toEqual({ members: [] });
    expect(await roster.targets(roomId)).toEqual({ machines, agents: [] });
    const found = (await rooms.get(roomId))!;
    expect(found.leadThreadId).toBeNull();
    expect(found.playbook).toBeNull();
    expect((await db.db.prepare('SELECT COUNT(*) AS count FROM threads').get<{ count: number }>())?.count).toBe(0);
  });
  it('persists room-only roles and model settings and isolates another room', async () => {
    const input = { ...member('researcher'), model: 'provider/model', thinking: 'high' as const };
    expect((await roster.add(roomId, input)).members).toEqual([{ ...input, source: 'room' }]);
    expect(rebriefNext).toHaveBeenCalledWith(roomId);
    expect((await new RoomParticipantsRepository(db).read(roomId)).members).toEqual([input]);
    const other = randomUUID();
    await createRoom(other);
    expect(await roster.list(other)).toEqual({ members: [] });
  });
  it('serializes concurrent writes and rejects duplicate/reserved roles or contradictory targets', async () => {
    const results = await Promise.allSettled([
      roster.add(roomId, member('researcher')),
      roster.add(roomId, member('researcher')),
      roster.add(roomId, member('editor')),
    ]);
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
    expect((await roster.list(roomId)).members.map((value) => value.role)).toEqual(['researcher', 'editor']);
    await expect(roster.add(roomId, member('lead'))).rejects.toThrow('reserved');
    await expect(roster.add(roomId, { ...member('bad'), agent: { local: true, agent: 'registered' } })).rejects.toThrow(
      'exactly one',
    );
    expect(RoomParticipantInputSchema.safeParse({ ...member('bad'), agent: { local: false } }).success).toBe(false);
  });
  it('persists more than eight concurrent room roles without a count limit', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, (_, index) => roster.add(roomId, member(`role-${index}`))),
    );
    expect(results.every((result) => result.status === 'fulfilled')).toBe(true);
    const result = await roster.list(roomId);
    expect(result.members).toHaveLength(12);
    expect(RoomParticipantsSchema.safeParse(result).success).toBe(true);
    expect((await new RoomParticipantsRepository(db).read(roomId)).members).toHaveLength(12);
  });
  it('merges all inherited and room roles without truncation when a playbook is attached later', async () => {
    for (let index = 0; index < 8; index++) await roster.add(roomId, member(`room-${index}`));
    inherited = Array.from({ length: 10 }, (_, index) => member(`inherited-${index}`));
    expect(PlaybookConfigSchema.safeParse({ participants: inherited }).success).toBe(true);
    await db.db.prepare('UPDATE rooms SET playbook=? WHERE id=?').run('shared', roomId);
    expect((await roster.list(roomId)).members.map((value) => value.role)).toEqual([
      ...inherited.map((value) => value.role),
      ...Array.from({ length: 8 }, (_, index) => `room-${index}`),
    ]);
    await roster.remove(roomId, 'room-0');
    expect((await roster.list(roomId)).members).toHaveLength(17);
  });
  it('can remove more than 64 inherited roles without an exclusion count limit', async () => {
    inherited = Array.from({ length: 66 }, (_, index) => member(`inherited-${index}`));
    await db.db.prepare('UPDATE rooms SET playbook=? WHERE id=?').run('shared', roomId);
    await Promise.all(inherited.map((value) => roster.remove(roomId, value.role)));
    expect(await roster.list(roomId)).toEqual({ members: [] });
    expect((await new RoomParticipantsRepository(db).read(roomId)).excluded).toHaveLength(66);
  });
  it('accepts only this host, active paired IDs, and registered external IDs', async () => {
    await roster.add(roomId, { ...member('remote'), agent: { machine: 'paired' } });
    await roster.add(roomId, { ...member('external'), agent: { agent: 'registered' } });
    const local = await roster.add(roomId, { ...member('local'), agent: { machine: db.instanceId } });
    expect(local.members.find((value) => value.role === 'local')?.agent).toEqual({ local: true });
    await expect(roster.add(roomId, { ...member('unknown'), agent: { machine: 'foreign-host' } })).rejects.toThrow(
      'paired computer',
    );
    await expect(roster.add(roomId, { ...member('unknown'), agent: { agent: 'foreign-agent' } })).rejects.toThrow(
      'registered external',
    );
  });
  it('overrides, renames, and hides inherited roles only in this room', async () => {
    await db.db.prepare('UPDATE rooms SET playbook=? WHERE id=?').run('shared', roomId);
    inherited = [member('researcher'), member('editor')];
    expect((await roster.list(roomId)).members.map((value) => value.source)).toEqual(['playbook', 'playbook']);
    await roster.update(roomId, 'researcher', { ...member('researcher'), instructions: 'Changed only here.' });
    await roster.update(roomId, 'editor', member('reviewer'));
    expect((await roster.list(roomId)).members.map((value) => [value.role, value.source])).toEqual([
      ['researcher', 'room'],
      ['reviewer', 'room'],
    ]);
    await roster.remove(roomId, 'researcher');
    expect((await roster.list(roomId)).members.map((value) => value.role)).toEqual(['reviewer']);
    expect(inherited).toEqual([member('researcher'), member('editor')]);
    expect((await store.read(roomId)).excluded).toEqual(expect.arrayContaining(['editor', 'researcher']));
  });
  it('removes a room member without unregistering the external service', async () => {
    await roster.add(roomId, { ...member('external'), agent: { agent: 'registered' } });
    expect(await roster.remove(roomId, 'external')).toEqual({ members: [] });
    expect(outside.remove).not.toHaveBeenCalled();
    await expect(roster.update(roomId, 'missing', member('new'))).rejects.toThrow('No room participant');
    await expect(roster.remove(roomId, 'missing')).rejects.toThrow('No room participant');
    await expect(roster.list(randomUUID())).rejects.toThrow('No room');
  });
});
