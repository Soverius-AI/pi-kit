import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RoomAssistantStatusSchema, ROOMS_SETTING_KEY, type RoomAssistantPolicy } from '@pi-kit/protocol';
import { DatabaseService } from '../db/database.service';
import { RoomAssistantRepository } from '../db/room-assistant.repository';
import { RoomsRepository } from '../db/rooms.repository';
import { RoomPlaybooksRepository } from '../db/room-playbooks.repository';
import { MetaRepository } from '../db/meta.repository';
import { ThreadsRepository } from '../db/threads.repository';
import { InstanceRepository } from '../db/instance.repository';
import type { BackendConfig } from '../app/config';
import { RoomAssistant } from './room-assistant.service';
import { RoomLeadService } from './room-lead.service';
import { RoomsService } from './rooms.service';
import { RoomFolders } from './room-folders';
import { RoomPlaybookFiles } from './room-playbook-files.service';
import { RoomWorkspace } from './room-workspace.service';
import { RoomBus } from './room-bus';
import { RoomMemory } from './room-memory';
import { roomMemoryScopes } from './room-memory-scopes';
import { RoomTime } from './room-time';

describe('personal room assistant persistence', () => {
  let dir: string;
  let db: DatabaseService;
  let rooms: RoomsRepository;
  let store: RoomAssistantRepository;
  let assistant: RoomAssistant;
  let roomId: string;
  const resumePending = vi.fn(async () => undefined);
  const policy: RoomAssistantPolicy = {
    enabled: true,
    timezone: 'Europe/Vienna',
    quietStart: '22:00',
    quietEnd: '08:00',
    dailyLimit: 10,
    dailyRunLimit: 20,
  };
  function bind() {
    rooms = new RoomsRepository(db);
    store = new RoomAssistantRepository(db);
    const folders = new RoomFolders({ dataDir: dir } as BackendConfig);
    assistant = new RoomAssistant(
      store,
      new RoomPlaybooksRepository(db),
      rooms,
      {
        found: async (id: string) => {
          const found = await rooms.get(id);
          if (!found) throw new Error('Missing room');
          return found;
        },
        state: () => 'idle',
        resumePending,
        rebriefNext: () => undefined,
      } as unknown as RoomLeadService,
      {
        ensureProject: async () => undefined,
        execution: async (id: string) => ({ cwd: folders.workspace(id), workspace: true, sandbox: true }),
        list: async () => [],
        path: (id: string) => folders.workspace(id),
        files: async () => [],
      } as unknown as RoomWorkspace,
      new RoomBus(rooms),
      new RoomMemory(new RoomPlaybooksRepository(db), new RoomBus(rooms)),
    );
  }
  beforeEach(async () => {
    vi.clearAllMocks();
    dir = mkdtempSync(join(tmpdir(), 'pi-personal-assistant-'));
    db = await DatabaseService.create({ dataDir: dir });
    bind();
    await new MetaRepository(db).setSetting(ROOMS_SETTING_KEY, true);
    const service = new RoomsService(
      rooms,
      new ThreadsRepository(db),
      new InstanceRepository(db),
      new MetaRepository(db),
      new RoomPlaybookFiles(new RoomFolders({ dataDir: dir } as BackendConfig)),
    );
    const room = await service.create({ title: 'Personal assistant', summary: 'Help with my commitments.' });
    roomId = room.id;
    await rooms.setLead(roomId, 'personal-lead');
  });
  afterEach(async () => {
    await assistant.onApplicationShutdown();
    await db.onApplicationShutdown();
    rmSync(dir, { recursive: true, force: true });
  });
  const input = (dueAt: number) => ({
    title: 'Prepare meeting',
    details: 'Use my saved preference.',
    dueAt,
    timezone: 'Europe/Vienna',
    dailyAt: null,
    source: 'owner',
  });

  it('uses memory without a source thread, Git folder or playbook, and preserves corrections across restart', async () => {
    expect(await rooms.get(roomId)).toMatchObject({
      sourceThreadId: null,
      projectFolder: null,
      playbook: null,
      room: { repository: '', baseCommit: '' },
    });
    expect(
      await assistant.command('personal-lead', { action: 'remember', key: 'briefing', text: 'Keep it short.' }),
    ).toContain('Remembered');
    await assistant.remember(roomId, { key: 'briefing', text: 'Use three bullets.' });
    expect(RoomAssistantStatusSchema.parse(await assistant.status(roomId)).memory).toMatchObject([
      { key: 'briefing', text: 'Use three bullets.', updatedBy: 'owner' },
    ]);
    await assistant.onApplicationShutdown();
    await db.onApplicationShutdown();
    db = await DatabaseService.create({ dataDir: dir });
    bind();
    expect((await assistant.status(roomId)).memory[0]).toMatchObject({ key: 'briefing', text: 'Use three bullets.' });
    expect(await assistant.briefing((await rooms.get(roomId))!)).toContain('Use three bullets.');
    await assistant.command('personal-lead', { action: 'forget', key: 'briefing' });
    expect((await assistant.status(roomId)).memory).toEqual([]);
  });

  it('retains only a forgotten key across restart and refuses automatic restoration from history', async () => {
    await assistant.command('personal-lead', {
      action: 'remember',
      key: 'reply-style',
      text: 'Use long explanations.',
    });
    await assistant.remember(roomId, { key: 'reply-style', text: 'Use concise replies.' });
    const reviewed = (await assistant.briefing((await rooms.get(roomId))!))!;
    expect(reviewed).toContain('Use concise replies. [owner,');
    expect(reviewed).not.toContain('Use long explanations.');
    await assistant.remember(roomId, { key: 'reply-style', text: '' });
    await assistant.onApplicationShutdown();
    await db.onApplicationShutdown();
    db = await DatabaseService.create({ dataDir: dir });
    bind();
    expect((await assistant.status(roomId)).memory).toEqual([]);
    const context = (await assistant.briefing((await rooms.get(roomId))!))!;
    expect(context).toContain('Explicitly forgotten memory keys: room:reply-style');
    expect(context).toContain('Never recreate forgotten facts from history');
    expect(context).not.toContain('Use concise replies.');
    await expect(
      assistant.command('personal-lead', { action: 'remember', key: 'reply-style', text: 'Use long explanations.' }),
    ).rejects.toThrow('was forgotten');
    const retained = await db.db.prepare('SELECT key,text FROM room_memory WHERE scope=?').all(`room:${roomId}`);
    expect(retained).toEqual([{ key: 'reply-style', text: '' }]);
    // Existing explicit owner APIs and advanced channel commands remain compatible.
    await assistant.remember(roomId, { key: 'reply-style', text: 'Only the owner reintroduced this.' });
    expect((await assistant.status(roomId)).memory).toMatchObject([
      { text: 'Only the owner reintroduced this.', updatedBy: 'owner' },
    ]);
  });

  it('preserves explicit playbook-note authoring after a note was removed', async () => {
    const notes = new RoomPlaybooksRepository(db),
      memory = new RoomMemory(notes, new RoomBus(rooms));
    const scope = `room-playbook:${roomId}/workflow`;
    await memory.change(roomId, { key: 'spec', text: 'Version one.' }, 'lead', scope);
    await memory.change(roomId, { key: 'spec', text: '' }, 'lead', scope);
    expect(await notes.memory([scope])).toEqual([]);
    await memory.change(roomId, { key: 'spec', text: 'Version two.' }, 'lead', scope);
    expect(await notes.memory([scope])).toMatchObject([{ key: 'spec', text: 'Version two.' }]);
  });

  it('lets the owner forget a legacy secret-shaped key without retaining it as a tombstone', async () => {
    const key = 'sk-proj-' + 'x'.repeat(40),
      notes = new RoomPlaybooksRepository(db),
      scope = `room:${roomId}`;
    await notes.remember(scope, key, 'Legacy entry.', 'owner');
    expect((await assistant.status(roomId)).memory).toMatchObject([{ key }]);
    const memory = new RoomMemory(notes, new RoomBus(rooms));
    await expect(memory.change(roomId, { key, text: '' }, 'owner', 'room:another-room')).rejects.toThrow(
      'current room only',
    );
    await assistant.remember(roomId, { key, text: '' });
    expect((await assistant.status(roomId)).memory).toEqual([]);
    expect(await db.db.prepare('SELECT key,text FROM room_memory WHERE scope=?').all(scope)).toEqual([]);
    expect(await notes.forgotten([scope])).toEqual([]);
    await expect(assistant.remember(roomId, { key, text: 'New entry.' })).rejects.toThrow(
      'secret values as memory keys',
    );
    await assistant.remember(roomId, { key: 'reply-style', text: 'Concise' });
    await assistant.remember(roomId, { key: 'reply-style', text: '' });
    expect(await notes.forgotten([scope])).toEqual([{ scope: 'room', key: 'reply-style' }]);
  });

  it('does not persist secrets or accept another room scope through the automatic memory path', async () => {
    await expect(
      assistant.command('personal-lead', { action: 'remember', key: 'api-key', text: 'sk-proj-' + 'x'.repeat(40) }),
    ).rejects.toThrow('does not store');
    await expect(
      assistant.command('personal-lead', {
        action: 'remember',
        key: 'account-context',
        text: '123456:abcdefghijklmnopqrstuvwxyz1234567890',
      }),
    ).rejects.toThrow('does not store');
    await expect(
      assistant.command('ordinary-thread', { action: 'remember', key: 'reply-style', text: 'Concise' }),
    ).rejects.toThrow('Only a room lead');
    await expect(
      assistant.command('personal-lead', {
        action: 'remember',
        key: 'sk-proj-' + 'x'.repeat(40),
        text: 'Do not retain secret keys.',
      }),
    ).rejects.toThrow('secret values as memory keys');
    const memory = new RoomMemory(new RoomPlaybooksRepository(db), new RoomBus(rooms));
    await expect(
      memory.change(roomId, { key: 'reply-style', text: 'Concise' }, 'lead', 'room:another-room'),
    ).rejects.toThrow('current room only');
    expect((await assistant.status(roomId)).memory).toEqual([]);
  });

  it('keeps remembered facts scoped to their room', async () => {
    await assistant.remember(roomId, { key: 'private', text: 'Only this room.' });
    const other = await rooms.insert({
      id: crypto.randomUUID(),
      title: 'Research',
      repository: '',
      baseCommit: '',
      summary: '',
      sourceThreadId: null,
      projectFolder: null,
      createdAt: Date.now(),
    });
    expect((await assistant.status(other.id)).memory).toEqual([]);
  });

  it('isolates personal playbook notes while preserving existing repository playbook memory', async () => {
    await rooms.setPlaybook(roomId, 'daily', null);
    const other = await rooms.insert({
      id: crypto.randomUUID(),
      title: 'Research',
      repository: '',
      baseCommit: '',
      summary: '',
      sourceThreadId: null,
      projectFolder: null,
      playbook: 'daily',
      createdAt: Date.now(),
    });
    const first = (await rooms.get(roomId))!;
    const second = (await rooms.get(other.id))!;
    const notes = new RoomPlaybooksRepository(db);
    await notes.remember('playbook:/daily', 'legacy', 'Unattributed legacy shared note.', 'lead');
    await notes.remember(roomMemoryScopes(first)[1], 'preference', 'Private first-room playbook fact.', 'lead');
    const firstBriefing = await assistant.briefing(first);
    const secondBriefing = await assistant.briefing(second);
    expect(firstBriefing).toContain('Private first-room playbook fact.');
    expect(secondBriefing).not.toContain('Private first-room playbook fact.');
    expect(firstBriefing).not.toContain('Unattributed legacy shared note.');
    expect(secondBriefing).not.toContain('Unattributed legacy shared note.');

    const repository = 'https://example.test/shared.git';
    await notes.remember(`playbook:${repository}/daily`, 'shared', 'Existing repository playbook fact.', 'lead');
    for (const found of [first, second]) {
      const briefing = await assistant.briefing({ ...found, room: { ...found.room, repository } });
      expect(briefing).toContain('Existing repository playbook fact.');
      expect(briefing).not.toContain('Private first-room playbook fact.');
    }
  });

  it('only runs opted-in commitments and durably enqueues a due occurrence once', async () => {
    const now = Date.now();
    const item = await assistant.create(roomId, input(now - 1000));
    await assistant.tick(now);
    expect(await rooms.pendingWakes(roomId)).toBe(0);
    await assistant.policy(roomId, policy);
    await Promise.all([assistant.tick(now), assistant.tick(now)]);
    await assistant.tick(now + 1000);
    expect(await rooms.pendingWakes(roomId)).toBe(1);
    const wake = await rooms.nextWake(roomId);
    expect(wake?.cause).toMatchObject({ kind: 'schedule', trigger: item.id });
    expect((await store.commitment(roomId, item.id))?.item.lastFiredAt).toBe(now);
    expect(
      (
        await db.db
          .prepare('SELECT commitment_revision AS revision FROM room_wakeups WHERE id=?')
          .get<{ revision: number }>(wake!.id)
      )?.revision,
    ).toBe(0);
  });

  it('completing or snoozing invalidates queued work and undelivered notifications', async () => {
    const now = Date.now();
    await assistant.policy(roomId, policy);
    const item = await assistant.create(roomId, input(now - 1000));
    await assistant.tick(now);
    const wake = (await rooms.nextWake(roomId))!;
    await db.db.prepare("INSERT INTO room_channel_links(channel,room_id) VALUES ('whatsapp',?)").run(roomId);
    await db.db
      .prepare(
        "INSERT INTO room_channel_deliveries(channel,room_id,seq,text,work_id,provider_id) VALUES ('whatsapp',?,1,'Old reminder',?,'fixture-id')",
      )
      .run(roomId, wake.id);
    await assistant.change(roomId, item.id, { dueAt: now + 3600000, state: 'open' });
    expect(await rooms.pendingWakes(roomId)).toBe(0);
    expect(
      (await db.db.prepare('SELECT state FROM room_channel_deliveries WHERE room_id=?').get<{ state: string }>(roomId))
        ?.state,
    ).toBe('dismissed');
    await assistant.tick(now + 3600000);
    expect(await rooms.pendingWakes(roomId)).toBe(1);
    await assistant.change(roomId, item.id, { state: 'done' });
    await assistant.tick(now + 7200000);
    expect(await rooms.pendingWakes(roomId)).toBe(0);
    expect((await store.commitment(roomId, item.id))?.item.state).toBe('done');
  });

  it('does not enqueue a stale due snapshot after the owner completed the commitment', async () => {
    const now = Date.now();
    await assistant.policy(roomId, policy);
    const item = await assistant.create(roomId, input(now - 1000));
    const stale = await store.due(now);
    await assistant.change(roomId, item.id, { state: 'done' });
    vi.spyOn(store, 'due').mockResolvedValueOnce(stale);
    await assistant.tick(now);
    expect(await rooms.pendingWakes(roomId)).toBe(0);
  });

  it('rolls back both the due acknowledgement and wakeup if scheduling fails', async () => {
    const now = Date.now();
    await assistant.policy(roomId, policy);
    const item = await assistant.create(roomId, input(now - 1000));
    const original = store.fired.bind(store);
    vi.spyOn(store, 'fired').mockRejectedValueOnce(new Error('Simulated commit failure'));
    await expect(assistant.tick(now)).rejects.toThrow('Simulated');
    expect(await rooms.pendingWakes(roomId)).toBe(0);
    expect((await store.commitment(roomId, item.id))?.item.lastFiredAt).toBeNull();
    vi.mocked(store.fired).mockImplementation(original);
    await assistant.tick(now);
    expect(await rooms.pendingWakes(roomId)).toBe(1);
  });

  it('keeps owner-message idempotence across a restart and requires review for an interrupted effect', async () => {
    const first = await rooms.acceptMessage(roomId, { text: 'Please prepare it.' }, 'phone:stable-id');
    const wake = (await rooms.nextWake(roomId))!;
    await rooms.claimWake(wake.id);
    await assistant.onApplicationShutdown();
    await db.onApplicationShutdown();
    db = await DatabaseService.create({ dataDir: dir });
    bind();
    await rooms.recoverWakes();
    const replay = await rooms.acceptMessage(roomId, { text: 'Please prepare it.' }, 'phone:stable-id');
    expect(replay).toEqual({ event: first.event, fresh: false });
    expect((await rooms.events(roomId)).filter((event) => event.actor === 'owner')).toHaveLength(1);
    expect((await store.work(roomId))[0].state).toBe('review');
    expect(await rooms.pendingWakes(roomId)).toBe(0);
    await assistant.work(roomId, wake.id, true);
    expect(await rooms.pendingWakes(roomId)).toBe(1);
  });

  it('persists opt-in independently of playbook attachment and does not impose a legacy run cap', async () => {
    expect((await store.policy(roomId)).enabled).toBe(false);
    await rooms.setPlaybook(roomId, 'new-playbook', null);
    expect((await store.policy(roomId)).enabled).toBe(false);
    await db.db
      .prepare('UPDATE room_assistant_policy SET policy=? WHERE room_id=?')
      .run(
        JSON.stringify({ enabled: true, timezone: null, quietStart: '22:00', quietEnd: '08:00', dailyLimit: 10 }),
        roomId,
      );
    expect(await store.policy(roomId)).toMatchObject({
      enabled: true,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
    expect((await store.policy(roomId)).dailyRunLimit).toBeUndefined();
    expect(await assistant.canWake((await rooms.get(roomId))!)).toBe(true);
  });

  it('does not let disabled rooms occupy the global due-reminder page', async () => {
    for (let n = 0; n < 101; n++) await store.create(roomId, input(1));
    const enabledRoom = await rooms.insert({
      id: crypto.randomUUID(),
      title: 'Enabled',
      repository: '',
      baseCommit: '',
      summary: '',
      sourceThreadId: null,
      projectFolder: null,
      createdAt: Date.now(),
    });
    await store.setPolicy(enabledRoom.id, policy);
    const reminder = await store.create(enabledRoom.id, input(2));
    await assistant.tick(100);
    expect(await rooms.nextWake(enabledRoom.id)).toMatchObject({ cause: { trigger: reminder.id } });
    expect(await rooms.nextWake(roomId)).toBeUndefined();
  });

  it('sends assistant snapshots only after changes and explicitly supersedes forgotten facts', async () => {
    await assistant.remember(roomId, { key: 'drink', text: 'Tea' });
    const found = (await rooms.get(roomId))!;
    const first = (await assistant.briefing(found))!;
    assistant.acknowledgeBriefing(roomId, first);
    expect(await assistant.briefing(found)).toBeUndefined();
    await assistant.remember(roomId, { key: 'drink', text: 'Coffee' });
    const correction = (await assistant.briefing(found))!;
    expect(correction).toContain('Coffee');
    expect(correction).not.toContain('Tea');
    assistant.acknowledgeBriefing(roomId, correction);
    await assistant.remember(roomId, { key: 'drink', text: '' });
    const forgotten = (await assistant.briefing(found))!;
    expect(forgotten).toContain('Explicitly forgotten memory keys: room:drink');
    expect(forgotten).toContain('replaces ALL earlier');
    expect(forgotten).not.toContain('Coffee');
  });

  it('uses actual start time for per-day autonomous limits and respects the global Rooms switch', async () => {
    await assistant.policy(roomId, { ...policy, dailyRunLimit: 2 });
    for (let n = 0; n < 2; n++) {
      const id = await rooms.enqueueWake(roomId, 'Check', { kind: 'schedule', title: 'Check' }, `run:${n}`);
      await rooms.claimWake(id);
      await rooms.finishWake(id, 'done');
    }
    await db.db.prepare('UPDATE room_wakeups SET created_at=1').run();
    expect(await assistant.canWake((await rooms.get(roomId))!)).toBe(false);
    await assistant.policy(roomId, { ...policy, dailyRunLimit: 3 });
    expect(await assistant.canWake((await rooms.get(roomId))!)).toBe(true);
    await new MetaRepository(db).setSetting(ROOMS_SETTING_KEY, false);
    expect(await assistant.canWake((await rooms.get(roomId))!)).toBe(false);
  });
});

describe('room-local daily routines', () => {
  it('uses the room timezone for quiet hours crossing midnight', () => {
    expect(RoomTime.quiet(Date.parse('2026-11-23T22:00:00Z'), 'Europe/Vienna', '22:00', '08:00')).toBe(true);
    expect(RoomTime.quiet(Date.parse('2026-11-23T10:00:00Z'), 'Europe/Vienna', '22:00', '08:00')).toBe(false);
  });
  it('moves a skipped spring time to the first valid minute and does not repeat a fall-back time', () => {
    expect(
      new Date(RoomTime.nextDaily('02:30', 'Europe/Vienna', Date.parse('2026-03-29T00:59:00Z'))).toISOString(),
    ).toBe('2026-03-29T01:00:00.000Z');
    expect(
      new Date(RoomTime.nextDaily('02:30', 'Europe/Vienna', Date.parse('2026-10-25T00:30:00Z'))).toISOString(),
    ).toBe('2026-10-26T01:30:00.000Z');
  });
});
