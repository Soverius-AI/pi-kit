import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RoomChannel } from '@pi-kit/protocol';
import { DatabaseService } from '../db/database.service';
import { MetaRepository } from '../db/meta.repository';
import { RoomsRepository } from '../db/rooms.repository';
import { RoomPhoneRepository } from '../db/room-phone.repository';
import { RoomAssistantRepository } from '../db/room-assistant.repository';
import { RoomPlaybooksRepository } from '../db/room-playbooks.repository';
import { RoomChannelRegistry } from './room-channel.registry';
import type { RoomMessagingTransport } from './room-messaging.transport';
import { presentPhonePrompt } from './room-phone.presenter';

function wire() {
  return {
    phase: 'connected',
    account: 'assistant',
    qr: null,
    error: null,
    input: { lastGroupAt: null, lastOwnGroupAt: null, lastAcceptedAt: null, ignoredHistory: 0 },
    receive: async () => undefined,
    receipt: async () => undefined,
    createMessageId: () => crypto.randomUUID(),
    connect: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => undefined),
    send: vi.fn(async () => 'provider-id'),
    media: vi.fn(async () => new Uint8Array()),
    configure: vi.fn(async (_values: Record<string, string>) => undefined),
    details: () => ({ configured: true }),
  } satisfies RoomMessagingTransport;
}
let directory: string, db: DatabaseService, rooms: RoomsRepository, meta: MetaRepository;
let registry: RoomChannelRegistry;
let wires: Record<RoomChannel, ReturnType<typeof wire>>;
function createRegistry() {
  return new RoomChannelRegistry(
    db,
    rooms,
    { found: (room: string) => rooms.get(room) } as never,
    meta,
    {} as never,
    new RoomAssistantRepository(db),
    {} as never,
    {} as never,
    new RoomPlaybooksRepository(db),
    {} as never,
    wires.whatsapp as never,
    wires.signal as never,
    wires.slack as never,
    wires.telegram as never,
  );
}
async function bind(store: RoomPhoneRepository, room: string, group: string) {
  await store.begin(room, 'code', Date.now() + 60_000);
  expect(await store.candidate('code', group, 'owner', 'Owner', 'Group', Date.now())).toBe(true);
  expect(await store.confirm(room, group, 'owner', 'assistant', Date.now())).toBe(true);
}
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'room-channel-delete-'));
  db = await DatabaseService.create({ dataDir: directory });
  rooms = new RoomsRepository(db);
  meta = new MetaRepository(db);
  for (const id of ['a', 'b'])
    await rooms.insert({
      id,
      title: id,
      repository: '',
      baseCommit: '',
      summary: '',
      sourceThreadId: null,
      projectFolder: null,
      createdAt: 1,
    });
  wires = { whatsapp: wire(), signal: wire(), slack: wire(), telegram: wire() };
  registry = createRegistry();
});
afterEach(async () => {
  await db.onApplicationShutdown();
  rmSync(directory, { recursive: true, force: true });
});

describe('persistent room channel deletion', () => {
  it('removes a configured unbound channel across database and registry restarts without disconnecting the host', async () => {
    expect(await registry.status('slack', 'a')).toMatchObject({
      configured: true,
      removedFromRoom: false,
      binding: null,
    });
    await registry.get('slack').unlink('a');
    expect(await registry.status('slack', 'a')).toMatchObject({
      configured: true,
      removedFromRoom: true,
      binding: null,
    });
    expect(wires.slack.disconnect).not.toHaveBeenCalled();
    await db.onApplicationShutdown();
    db = await DatabaseService.create({ dataDir: directory });
    rooms = new RoomsRepository(db);
    meta = new MetaRepository(db);
    registry = createRegistry();
    expect(await new RoomPhoneRepository(db, 'slack').removedFromRoom('a')).toBe(true);
    expect((await registry.status('slack', 'a')).removedFromRoom).toBe(true);
    expect((await registry.status('slack', 'b')).removedFromRoom).toBe(false);
    expect((await registry.status('telegram', 'a')).removedFromRoom).toBe(false);
  });
  it('atomically revokes bound queues, commands, prompts, and challenges while retaining other rooms, providers, history, memory, and echo guards', async () => {
    const slack = new RoomPhoneRepository(db, 'slack');
    const telegram = new RoomPhoneRepository(db, 'telegram');
    await bind(slack, 'a', 'group-a');
    await bind(slack, 'b', 'group-b');
    await bind(telegram, 'a', 'group-a');
    await slack.receive('group-a', 'owner', 'assistant', 'input', 'Keep this input queued');
    await slack.notify('a', 'Queued output');
    await slack.prompt('a', 'question', 'question', presentPhonePrompt('question', 'Question', 'token'));
    await slack.claimCommand('a', 'command');
    await slack.recordOutgoing('group-a', 'assistant', 'sent-id');
    await rooms.append('a', { kind: 'message', actor: 'lead', text: 'Existing room conversation' });
    const notes = new RoomPlaybooksRepository(db);
    await notes.remember('room:a', 'preference', 'Concise replies', 'owner');
    const history = await rooms.events('a');
    await registry.get('slack').unlink('a');
    await registry.get('slack').unlink('a');
    for (const table of [
      'room_channel_inbox',
      'room_channel_deliveries',
      'room_channel_prompts',
      'room_channel_commands',
      'room_channel_links',
    ])
      expect(
        (
          await db.db
            .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE channel=? AND room_id=?`)
            .get<{ count: number }>('slack', 'a')
        )?.count,
      ).toBe(0);
    expect(await slack.removedFromRoom('a')).toBe(true);
    expect(await slack.isOutgoing('group-a', 'assistant', 'sent-id')).toBe(true);
    expect(await slack.get('b')).toMatchObject({ group_id: 'group-b' });
    expect(await telegram.get('a')).toMatchObject({ group_id: 'group-a' });
    expect(await rooms.events('a')).toEqual(history);
    expect(await notes.memory(['room:a'])).toMatchObject([{ key: 'preference', text: 'Concise replies' }]);
    expect(wires.slack.disconnect).not.toHaveBeenCalled();
    expect(await slack.candidate('code', 'stale', 'owner', 'Owner', 'Old group', Date.now())).toBe(false);
    expect(await slack.confirm('a', 'group-a', 'owner', 'assistant', Date.now())).toBe(false);
    expect(await slack.removedFromRoom('a')).toBe(true);
  });
  it('rolls back removal and queued-data deletion together when revocation cannot commit', async () => {
    const slack = new RoomPhoneRepository(db, 'slack');
    await bind(slack, 'a', 'group-a');
    await slack.notify('a', 'Pending');
    await db.db.exec(
      "CREATE TRIGGER reject_channel_delete BEFORE DELETE ON room_channel_links WHEN OLD.channel='slack' BEGIN SELECT RAISE(ABORT, 'revocation failed'); END",
    );
    await expect(registry.get('slack').unlink('a')).rejects.toThrow('revocation failed');
    expect(await slack.get('a')).toMatchObject({ group_id: 'group-a' });
    expect(await slack.removedFromRoom('a')).toBe(false);
    expect(await slack.delivery('a')).toBeDefined();
  });
  it('restores a removed channel when linking begins and keeps stale confirmations revoked', async () => {
    const slack = new RoomPhoneRepository(db, 'slack');
    const old = await registry.get('slack').begin('a');
    await registry.get('slack').unlink('a');
    expect(await slack.candidate(old.code, 'stale', 'owner', 'Owner', 'Old', Date.now())).toBe(false);
    await expect(registry.get('slack').confirm('a', { group: 'stale', sender: 'owner' })).rejects.toThrow();
    expect(await slack.removedFromRoom('a')).toBe(true);
    const link = await registry.get('slack').begin('a');
    expect((await registry.status('slack', 'a')).removedFromRoom).toBe(false);
    expect(await slack.candidate(link.code, 'new-group', 'owner', 'Owner', 'New', Date.now())).toBe(true);
    await registry.get('slack').confirm('a', { group: 'new-group', sender: 'owner' });
    expect(await registry.status('slack', 'a')).toMatchObject({
      removedFromRoom: false,
      binding: { group: 'new-group' },
    });
  });
  it('restores on a connect attempt and only after successful settings validation', async () => {
    await registry.get('slack').unlink('a');
    wires.slack.configure.mockRejectedValueOnce(new Error('Invalid settings'));
    await expect(registry.get('slack').configure('a', { setting: 'invalid' })).rejects.toThrow('Invalid settings');
    expect((await registry.status('slack', 'a')).removedFromRoom).toBe(true);
    await registry.get('slack').configure('a', { setting: 'valid' });
    expect((await registry.status('slack', 'a')).removedFromRoom).toBe(false);
    await registry.get('slack').unlink('a');
    wires.slack.connect.mockRejectedValueOnce(new Error('Offline'));
    await expect(registry.get('slack').connect('a')).rejects.toThrow('could not connect');
    expect((await registry.status('slack', 'a')).removedFromRoom).toBe(false);
    expect((await registry.status('slack', 'b')).removedFromRoom).toBe(false);
  });
});
