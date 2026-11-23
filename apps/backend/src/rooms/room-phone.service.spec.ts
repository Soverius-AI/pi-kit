import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ROOMS_SETTING_KEY,
  type PostRoomMessage,
  type RoomActionDecision,
  type RoomTaskAnswer,
} from '@pi-kit/protocol';
import { DatabaseService } from '../db/database.service';
import { MetaRepository } from '../db/meta.repository';
import { RoomsRepository } from '../db/rooms.repository';
import { RoomPhoneRepository } from '../db/room-phone.repository';
import { RoomAssistantRepository } from '../db/room-assistant.repository';
import { RoomPlaybooksRepository } from '../db/room-playbooks.repository';
import type { RoomAssistant } from './room-assistant.service';
import type { RoomWorkspace } from './room-workspace.service';
import type { TranscribeService } from '../transcribe/transcribe.service';
import type { RoomPlaybookService } from './room-playbook.service';
import { RoomPhoneService } from './room-phone.service';
import { presentPhonePrompt } from './room-phone.presenter';
import { RoomLeadService } from './room-lead.service';
import { RoomWhatsAppTransport, type PhoneMessage } from './room-whatsapp.transport';

describe('WhatsApp rooms with persistent SQLite routing', () => {
  let dir: string;
  let db: DatabaseService;
  let rooms: RoomsRepository;
  let store: RoomPhoneRepository;
  let meta: MetaRepository;
  let phone: RoomPhoneService;
  let policy: RoomAssistantRepository;
  let notes: RoomPlaybooksRepository;
  let states: Map<string, 'idle' | 'working' | 'error'>;
  const post = vi.fn();
  const answerQuestions = vi.fn(async (roomId: string, body: RoomTaskAnswer) => {
    await rooms.setLeadQuestions(roomId, []);
    return body;
  });
  const change = vi.fn(async (roomId: string, id: string, body: Parameters<RoomAssistantRepository['change']>[2]) => {
    await policy.change(roomId, id, body);
  });
  const decide = vi.fn(async (roomId: string, id: string, body: RoomActionDecision) => {
    await notes.decide(roomId, id, body.decision === 'approve' ? 'done' : 'discarded', 'decided');
    return notes.action(roomId, id);
  });
  const workspace = {
    upload: vi.fn(async (_room: string, id: number, name: string, _bytes: Uint8Array) => `inbox/${id}-${name}`),
    readUpload: vi.fn(async () => Buffer.from('image')),
  };
  const transcribe = { transcribe: vi.fn(async () => ({ text: 'Prepare the meeting', language: 'en' })) };
  const transport = {
    phase: 'connected',
    account: 'assistant@s.whatsapp.net',
    qr: null,
    error: null as string | null,
    input: { lastGroupAt: null, lastOwnGroupAt: null, lastAcceptedAt: null, ignoredHistory: 0 },
    receive: async (_message: PhoneMessage) => undefined,
    connect: vi.fn(),
    disconnect: vi.fn(),
    send: vi.fn(),
    media: vi.fn(async (): Promise<Uint8Array> => new Uint8Array([1, 2, 3])),
    receipt: async (_id: string, _status: number, _group: string) => undefined,
  };
  const message = (text: string, id = text, group = 'baileys:group-a@g.us', sender = 'owner@lid'): PhoneMessage => ({
    id,
    group,
    sender,
    senderName: 'Owner',
    groupName: 'Personal',
    text,
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    dir = mkdtempSync(join(tmpdir(), 'pi-room-phone-'));
    db = await DatabaseService.create({ dataDir: dir });
    rooms = new RoomsRepository(db);
    store = new RoomPhoneRepository(db);
    meta = new MetaRepository(db);
    await meta.setSetting(ROOMS_SETTING_KEY, true);
    states = new Map();
    policy = new RoomAssistantRepository(db);
    notes = new RoomPlaybooksRepository(db);
    workspace.upload.mockClear();
    workspace.readUpload.mockClear();
    transcribe.transcribe.mockClear();
    transport.media.mockResolvedValue(new Uint8Array([1, 2, 3]));
    for (const id of ['a', 'b'])
      await rooms.insert({
        id,
        title: id,
        summary: '',
        sourceThreadId: null,
        projectFolder: dir,
        repository: 'test',
        baseCommit: 'a'.repeat(40),
        createdAt: 1,
      });
    post.mockImplementation(async (id: string, body: PostRoomMessage, sourceKey: string) => {
      const { event, fresh } = await rooms.acceptMessage(id, body, sourceKey);
      if (fresh) states.set(id, 'working');
      return event;
    });
    transport.error = null;
    transport.phase = 'connected';
    transport.account = 'assistant@s.whatsapp.net';
    transport.send.mockImplementation(async (_group: string, _text: string, id?: string) => id ?? 'outgoing-id');
    phone = makePhone();
    await phone.onModuleInit();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await phone.onApplicationShutdown();
    await db.onApplicationShutdown();
    rmSync(dir, { recursive: true, force: true });
  });

  function makePhone() {
    return new RoomPhoneService(
      store,
      rooms,
      {
        found: (id: string) => rooms.get(id),
        state: (id: string) => states.get(id) ?? 'idle',
        post,
        answerQuestions,
        update: async (id: string, body: { paused: boolean }) => {
          await rooms.setPaused(id, body.paused);
          return rooms.get(id);
        },
      } as unknown as RoomLeadService,
      transport as unknown as RoomWhatsAppTransport,
      meta,
      {
        rememberFact: async (id: string, input: { key: string; text: string }) => {
          if (input.text) await notes.remember(`room:${id}`, input.key, input.text, 'phone owner');
          else await notes.forget(`room:${id}`, input.key);
        },
        status: async (id: string) => ({ memory: await notes.memory([`room:${id}`]) }),
        changeCommitment: change,
      } as unknown as RoomAssistant,
      policy,
      workspace as unknown as RoomWorkspace,
      transcribe as unknown as TranscribeService,
      notes,
      { decide } as unknown as RoomPlaybookService,
    );
  }

  async function bind(room = 'a', group = 'baileys:group-a@g.us') {
    const link = await phone.begin(room);
    await transport.receive(message(`/room-link ${link.code}`, 'challenge', group));
    await phone.confirm(room, { group, sender: 'owner@lid' });
  }

  it('requires an expiring challenge and paired-app confirmation before admitting commands', async () => {
    const link = await phone.begin('a');
    await transport.receive(message(`/room-link ${link.code}`));
    expect((await phone.status('a')).candidate).toMatchObject({ groupName: 'Personal', sender: 'owner@lid' });
    await transport.receive(message('before confirmation'));
    await phone.flush();
    expect(post).not.toHaveBeenCalled();
    await expect(phone.confirm('a', { group: 'different', sender: 'owner@lid' })).rejects.toThrow();
    await phone.confirm('a', { group: 'baileys:group-a@g.us', sender: 'owner@lid' });
    expect((await phone.status('a')).binding?.sender).toBe('owner@lid');
    expect((await store.get('a'))?.code_hash).toBeNull();
    const second = await phone.begin('b');
    await transport.receive(message(`/room-link ${second.code}`));
    await expect(phone.confirm('b', { group: 'baileys:group-a@g.us', sender: 'owner@lid' })).rejects.toThrow();
  });

  it('links the host account explicitly and handles its input and controls without admitting other senders', async () => {
    const group = 'baileys:group-a@g.us';
    const sender = transport.account;
    const link = await phone.begin('a');
    await transport.receive(message(`/room-link ${link.code}`, 'own-link', group, sender));
    await transport.receive(message('before confirmation', 'before', group, sender));
    await phone.flush();
    expect(post).not.toHaveBeenCalled();
    await phone.confirm('a', { group, sender });
    await transport.receive(message('/remember timezone: Europe/Vienna', 'own-control', group, sender));
    await transport.receive(message('Prepare my day', 'own-input', group, sender));
    await transport.receive(message('/remember secret: rogue', 'rogue-control', group, 'someone@lid'));
    await phone.flush();
    expect(post).toHaveBeenCalledExactlyOnceWith(
      'a',
      { text: 'Prepare my day', route: 'lead', images: [] },
      expect.any(String),
    );
    expect(await notes.memory(['room:a'])).toEqual([
      expect.objectContaining({ key: 'timezone', text: 'Europe/Vienna' }),
    ]);
  });

  it('rejects generated own-account echoes before queueing, including inline echoes during send', async () => {
    const group = 'baileys:group-a@g.us';
    const sender = transport.account;
    const link = await phone.begin('a');
    await transport.receive(message(`/room-link ${link.code}`, 'own-link', group, sender));
    await phone.confirm('a', { group, sender });
    await rooms.append('a', { kind: 'message', actor: 'lead', text: '/remember generated: must not execute' });
    transport.send.mockImplementation(async (sentGroup: string, text: string, id: string) => {
      await transport.receive(message(text, id, sentGroup, sender));
      return id;
    });
    await phone.flush();
    expect(transport.send).toHaveBeenCalledTimes(1);
    expect(post).not.toHaveBeenCalled();
    expect(await notes.memory(['room:a'])).toEqual([]);
    expect((await phone.status('a')).queued).toBe(0);
  });

  it('retains outgoing identity after an ambiguous send, restart, unlink and binding the same group to another room', async () => {
    const group = 'baileys:group-a@g.us';
    const sender = transport.account;
    const link = await phone.begin('a');
    await transport.receive(message(`/room-link ${link.code}`, 'own-link', group, sender));
    await phone.confirm('a', { group, sender });
    await rooms.append('a', { kind: 'message', actor: 'lead', text: 'May have reached WhatsApp' });
    transport.send.mockRejectedValueOnce(new Error('Socket closed after write'));
    await phone.flush();
    const id = transport.send.mock.calls[0][2] as string;
    expect(await store.isOutgoing(group, sender, id)).toBe(true);
    await phone.onApplicationShutdown();
    await db.onApplicationShutdown();
    db = await DatabaseService.create({ dataDir: dir });
    rooms = new RoomsRepository(db);
    store = new RoomPhoneRepository(db);
    meta = new MetaRepository(db);
    notes = new RoomPlaybooksRepository(db);
    policy = new RoomAssistantRepository(db);
    phone = makePhone();
    await phone.onModuleInit();
    await transport.receive(message('/remember replay: forbidden', id, group, sender));
    await phone.unlink('a');
    const second = await phone.begin('b');
    await transport.receive(message(`/room-link ${second.code}`, id, group, sender));
    expect((await phone.status('b')).candidate).toBeNull();
    await transport.receive(message(`/room-link ${second.code}`, 'fresh-link', group, sender));
    await phone.confirm('b', { group, sender });
    await transport.receive(message('/remember replay: forbidden', id, group, sender));
    expect(await notes.memory(['room:a', 'room:b'])).toEqual([]);
    expect(post).not.toHaveBeenCalled();
    expect(await store.isOutgoing('other-group', sender, id)).toBe(false);
    expect(await store.isOutgoing(group, 'other-account', id)).toBe(false);
  });

  it('serializes control admission with unlink so commands cannot act after revocation', async () => {
    await bind();
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const resume = new Promise<void>((resolve) => {
      release = resolve;
    });
    const authorized = store.authorized.bind(store);
    vi.spyOn(store, 'authorized').mockImplementationOnce(async (...args) => {
      const binding = await authorized(...args);
      entered();
      await resume;
      return binding;
    });
    const input = transport.receive(message('/remember before: accepted', 'before-unlink'));
    await started;
    let unlinked = false;
    const removal = phone.unlink('a').then(() => {
      unlinked = true;
    });
    await Promise.resolve();
    expect(unlinked).toBe(false);
    release();
    await input;
    await removal;
    await transport.receive(message('/remember after: forbidden', 'after-unlink'));
    expect(await notes.memory(['room:a'])).toEqual([expect.objectContaining({ key: 'before' })]);
  });

  it('does not admit an expired or replaced link code', async () => {
    const first = await phone.begin('a');
    const second = await phone.begin('a');
    await transport.receive(message(`/room-link ${first.code}`));
    expect((await phone.status('a')).candidate).toBeNull();
    await db.db.prepare('UPDATE room_phone_links SET expires_at = 1').run();
    await transport.receive(message(`/room-link ${second.code}`));
    expect((await phone.status('a')).candidate).toBeNull();
    expect((await phone.status('a')).error).toContain('Generate a fresh code');
  });

  it('deduplicates input, canonically queues while busy, and isolates rooms and sender identities', async () => {
    await bind();
    await bind('b', 'baileys:group-b@g.us');
    await transport.receive(message('first', '1'));
    await transport.receive(message('first', '1'));
    await transport.receive(message('second', '2'));
    await transport.receive(message('rogue', '3', undefined, 'someone-else@lid'));
    await transport.receive(message('other room', '4', 'baileys:group-b@g.us'));
    await phone.flush();
    expect(post.mock.calls.map(([room, body]) => [room, body.text])).toEqual([
      ['a', 'first'],
      ['b', 'other room'],
    ]);
    expect((await phone.status('a')).queued).toBe(1);
    await phone.flush();
    expect(post).toHaveBeenCalledTimes(3);
    expect((await phone.status('a')).queued).toBe(0);
    states.set('a', 'idle');
    await phone.flush();
    expect(post).toHaveBeenLastCalledWith(
      'a',
      { text: 'second', route: 'lead', images: [] },
      'phone:assistant@s.whatsapp.net:baileys:group-a@g.us:2',
    );
  });

  it('keeps other rooms and owner controls responsive while attachment I/O is stalled, and revokes the pending commit on unlink', async () => {
    await bind();
    await bind('b', 'baileys:group-b@g.us');
    let entered!: () => void;
    let release!: (bytes: Uint8Array) => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const media = new Promise<Uint8Array>((resolve) => {
      release = resolve;
    });
    transport.media.mockImplementationOnce(async () => {
      entered();
      return media;
    });
    await transport.receive({
      ...message('', 'stalled-a'),
      raw: '{}',
      files: [{ name: 'voice.ogg', mime: 'audio/ogg', type: 'audio', size: 3 }],
    });
    await transport.receive(message('Do this in parallel', 'parallel-b', 'baileys:group-b@g.us'));
    const processing = phone.flush();
    await started;
    await transport.receive(message('/pause', 'pause-during-io'));
    expect((await rooms.get('a'))?.paused).toBe(true);
    await vi.waitFor(() =>
      expect(post).toHaveBeenCalledWith(
        'b',
        expect.objectContaining({ text: 'Do this in parallel' }),
        expect.any(String),
      ),
    );
    await phone.unlink('a');
    await processing;
    release(new Uint8Array([1, 2, 3]));
    await Promise.resolve();
    expect(workspace.upload).not.toHaveBeenCalled();
    expect(post.mock.calls.some(([room]) => room === 'a')).toBe(false);
  });

  it('lets unlink and another room proceed while a send is unresolved, without committing a late send result', async () => {
    await bind();
    await bind('b', 'baileys:group-b@g.us');
    let entered!: () => void;
    let release!: (id: string) => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const sending = new Promise<string>((resolve) => {
      release = resolve;
    });
    transport.send.mockImplementationOnce(async () => {
      entered();
      return sending;
    });
    await rooms.append('a', { kind: 'message', actor: 'lead', text: 'Slow network' });
    const processing = phone.flush();
    await started;
    await transport.receive(message('Second room input', 'parallel-input', 'baileys:group-b@g.us'));
    const parallel = phone.flush();
    await vi.waitFor(() =>
      expect(post).toHaveBeenCalledWith(
        'b',
        expect.objectContaining({ text: 'Second room input' }),
        expect.any(String),
      ),
    );
    await phone.unlink('a');
    await Promise.all([processing, parallel]);
    release('late-provider-id');
    await Promise.resolve();
    expect((await phone.status('a')).binding).toBeNull();
    expect(post).toHaveBeenCalledWith('b', expect.objectContaining({ text: 'Second room input' }), expect.any(String));
  });

  it('returns cancelled inbox claims to pending on disconnect and bounds shutdown while I/O never resolves', async () => {
    await bind();
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    transport.media.mockImplementationOnce(async () => {
      entered();
      return new Promise<Uint8Array>(() => undefined);
    });
    await transport.receive({
      ...message('', 'cancelled-inbox'),
      raw: '{}',
      files: [{ name: 'note.ogg', mime: 'audio/ogg', type: 'audio', size: 3 }],
    });
    const processing = phone.flush();
    await started;
    await phone.disconnect('a');
    await processing;
    expect((await store.pending('a'))?.provider_id).toBe('cancelled-inbox');
    let enteredAgain!: () => void;
    const startedAgain = new Promise<void>((resolve) => {
      enteredAgain = resolve;
    });
    transport.media.mockImplementationOnce(async () => {
      enteredAgain();
      return new Promise<Uint8Array>(() => undefined);
    });
    const second = phone.flush();
    await startedAgain;
    await phone.onApplicationShutdown();
    await second;
    expect(post).not.toHaveBeenCalled();
    expect((await store.pending('a'))?.provider_id).toBe('cancelled-inbox');
  });

  it('derives each input status from its own canonical wake rather than the global lead state', async () => {
    await bind();
    await transport.receive(message('First operation', 'work-one'));
    await phone.flush();
    await transport.receive(message('Second operation', 'work-two'));
    await phone.flush();
    const work = await db.db
      .prepare('SELECT id,provider_id,work_id FROM room_phone_inbox ORDER BY id')
      .all<{ id: number; provider_id: string; work_id: string }>();
    expect(work.every((row) => !!row.work_id)).toBe(true);
    await db.db.prepare("UPDATE room_wakeups SET state='failed' WHERE id=?").run(work[0].work_id);
    await db.db.prepare("UPDATE room_wakeups SET state='queued' WHERE id=?").run(work[1].work_id);
    states.set('a', 'idle');
    await phone.flush();
    expect(await db.db.prepare('SELECT provider_id,state FROM room_phone_inbox ORDER BY id').all()).toEqual([
      { provider_id: 'work-one', state: 'review' },
      { provider_id: 'work-two', state: 'accepted' },
    ]);
    await db.db.prepare("UPDATE room_wakeups SET state='queued' WHERE id=?").run(work[0].work_id);
    await db.db.prepare("UPDATE room_wakeups SET state='done' WHERE id=?").run(work[1].work_id);
    await phone.flush();
    expect(await db.db.prepare('SELECT provider_id,state FROM room_phone_inbox ORDER BY id').all()).toEqual([
      { provider_id: 'work-one', state: 'accepted' },
      { provider_id: 'work-two', state: 'done' },
    ]);
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('recognizes canonical acceptance after an uncertain dispatch instead of re-enqueueing work', async () => {
    await bind();
    post.mockImplementationOnce(async (id: string, body: PostRoomMessage, sourceKey: string) => {
      await rooms.acceptMessage(id, body, sourceKey);
      throw new Error('Acknowledgement lost');
    });
    await transport.receive(message('Exactly one operation', 'uncertain-input'));
    await phone.flush();
    await phone.flush();
    expect(post).toHaveBeenCalledTimes(1);
    expect(await store.counts('a')).toEqual({ queued: 0, needsReview: 0 });
    expect(await db.db.prepare('SELECT COUNT(*) AS n FROM room_wakeups').get()).toEqual({ n: 1 });
  });

  it('quarantines malformed persisted attachments without blocking another room', async () => {
    await bind();
    await bind('b', 'baileys:group-b@g.us');
    await transport.receive(message('Bad stored metadata', 'bad-metadata'));
    await db.db
      .prepare("UPDATE room_phone_inbox SET files_json=? WHERE room_id='a'")
      .run(JSON.stringify([{ size: 'invalid' }]));
    await transport.receive(message('Unaffected', 'good-metadata', 'baileys:group-b@g.us'));
    await phone.flush();
    expect(await store.counts('a')).toEqual({ queued: 0, needsReview: 1 });
    expect(post).toHaveBeenCalledExactlyOnceWith(
      'b',
      expect.objectContaining({ text: 'Unaffected' }),
      expect.any(String),
    );
  });

  it('expires prompt deliveries by their explicit relation even when rendered text contains no token', async () => {
    await bind();
    const token = await store.prompt('a', 'localized-question', 'question', presentPhonePrompt('question', 'Question'));
    await db.db.prepare("UPDATE room_phone_deliveries SET text='Localized display' WHERE prompt_id=?").run(token);
    await db.db.prepare('UPDATE room_phone_prompts SET expires_at=1 WHERE token=?').run(token);
    await phone.flush();
    expect(transport.send).not.toHaveBeenCalled();
    expect(await db.db.prepare('SELECT state FROM room_phone_deliveries WHERE prompt_id=?').get(token)).toEqual({
      state: 'dismissed',
    });
  });

  it('mirrors only new lead replies once and holds work while paused or Rooms is disabled', async () => {
    await rooms.append('a', { kind: 'message', actor: 'lead', text: 'Old private history' });
    await bind();
    await rooms.append('a', { kind: 'message', actor: 'owner', text: 'Do not echo owner' });
    await rooms.append('a', { kind: 'message', actor: 'lead', text: 'New reply' });
    await rooms.setPaused('a', true);
    await phone.flush();
    expect(transport.send).not.toHaveBeenCalled();
    await rooms.setPaused('a', false);
    await meta.setSetting(ROOMS_SETTING_KEY, false);
    await phone.flush();
    expect(transport.send).not.toHaveBeenCalled();
    await meta.setSetting(ROOMS_SETTING_KEY, true);
    await phone.flush();
    await phone.flush();
    expect(transport.send).toHaveBeenCalledExactlyOnceWith(
      'baileys:group-a@g.us',
      'New reply',
      expect.stringMatching(/^3EB0[A-F0-9]+$/),
      undefined,
    );
  });

  it('retains pending and accepted canonical work across reopening without a false interruption', async () => {
    await bind();
    await transport.receive(message('accepted turn', '1'));
    await transport.receive(message('still queued', '2'));
    await phone.flush();
    await phone.onApplicationShutdown();
    await db.onApplicationShutdown();
    db = await DatabaseService.create({ dataDir: dir });
    store = new RoomPhoneRepository(db);
    await store.recover();
    expect((await store.get('a'))?.sender_id).toBe('owner@lid');
    expect((await store.pending('a'))?.text).toBe('still queued');
    expect(await store.counts('a')).toEqual({ queued: 1, needsReview: 0 });
  });

  it('retries an uncertain send with the same provider id at most three times, and unlink revokes queued work', async () => {
    await bind();
    await rooms.append('a', { kind: 'message', actor: 'lead', text: 'A result' });
    transport.send.mockRejectedValue(new Error('Connection lost after send'));
    for (let attempt = 0; attempt < 3; attempt++) {
      await phone.flush();
      await db.db.prepare('UPDATE room_phone_deliveries SET next_at=0').run();
    }
    await phone.flush();
    expect(transport.send).toHaveBeenCalledTimes(3);
    expect(new Set(transport.send.mock.calls.map((call) => call[2])).size).toBe(1);
    expect((await phone.status('a')).needsReview).toBe(1);
    await transport.receive(message('remove this'));
    await phone.unlink('a');
    await transport.receive(message('after removal'));
    await phone.flush();
    expect(post).not.toHaveBeenCalled();
    expect(await store.counts('a')).toEqual({ queued: 0, needsReview: 0 });
  });

  it('suspends a binding if the host links a different WhatsApp account or archives the room', async () => {
    await bind();
    transport.account = 'different-account@s.whatsapp.net';
    await transport.receive(message('not authorized on this account'));
    await rooms.append('a', { kind: 'message', actor: 'lead', text: 'Private result' });
    await phone.flush();
    expect(post).not.toHaveBeenCalled();
    expect(transport.send).not.toHaveBeenCalled();
    transport.account = 'assistant@s.whatsapp.net';
    await rooms.archive('a', Date.now());
    await transport.receive(message('archived'));
    await phone.flush();
    expect(post).not.toHaveBeenCalled();
    expect(transport.send).not.toHaveBeenCalled();
  });
  it('recovers a dispatch around canonical acceptance without executing the owner input twice', async () => {
    await bind();
    await transport.receive(message('one operation', 'once'));
    await phone.flush();
    await db.db.prepare("UPDATE room_phone_inbox SET state='dispatching'").run();
    await phone.onApplicationShutdown();
    await db.onApplicationShutdown();
    db = await DatabaseService.create({ dataDir: dir });
    rooms = new RoomsRepository(db);
    store = new RoomPhoneRepository(db);
    meta = new MetaRepository(db);
    policy = new RoomAssistantRepository(db);
    notes = new RoomPlaybooksRepository(db);
    states.clear();
    await rooms.recoverWakes();
    phone = makePhone();
    await phone.onModuleInit();
    await phone.flush();
    expect((await rooms.events('a')).filter((event) => event.actor === 'owner')).toHaveLength(1);
    expect(await db.db.prepare('SELECT count(*) AS n FROM room_wakeups').get()).toEqual({ n: 1 });
    expect(post).toHaveBeenCalledTimes(1);
    expect(await store.counts('a')).toEqual({ queued: 0, needsReview: 0 });
  });

  it('reconciles server receipts during an uncertain send and scopes receipts to the bound account', async () => {
    await bind();
    await rooms.append('a', { kind: 'message', actor: 'lead', text: 'Receipt test' });
    transport.send.mockImplementationOnce(async (group: string, _text: string, id?: string) => {
      if (!id) throw new Error('Missing stable delivery id');
      await store.receipt(id, 4, group, 'wrong-account');
      expect((await store.health('a')).lastDelivery?.readAt).toBeNull();
      await transport.receipt(id, 4, group);
      throw new Error('Acknowledgement raced with socket closure');
    });
    await phone.flush();
    await phone.flush();
    expect(transport.send).toHaveBeenCalledTimes(1);
    expect((await phone.status('a')).lastDelivery?.deliveredAt).toEqual(expect.any(Number));
    expect((await phone.status('a')).lastDelivery?.readAt).toEqual(expect.any(Number));
    expect((await phone.status('a')).pendingDeliveries).toBe(0);
  });

  it('requires a bound owner reply to the outbound connection test', async () => {
    await bind();
    await phone.test('a');
    await phone.flush();
    const row = await db.db.prepare("SELECT token FROM room_phone_prompts WHERE kind='test'").get<{ token: string }>();
    expect(row).toBeDefined();
    expect((await phone.status('a')).verifiedAt).toBeNull();
    await transport.receive(message(`/room-test ${row?.token}`, 'rogue-test', undefined, 'other@lid'));
    expect((await phone.status('a')).verifiedAt).toBeNull();
    await transport.receive(message(`/room-test ${row?.token}`, 'owner-test'));
    expect((await phone.status('a')).verifiedAt).toEqual(expect.any(Number));
  });

  it('answers only a current, unexpired question in its own room and only once', async () => {
    await bind();
    await bind('b', 'baileys:group-b@g.us');
    await rooms.setLeadQuestions('a', [
      { id: 'question-1', method: 'confirm', title: 'Allow calendar change?', message: 'Move meeting to 10:00 UTC.' },
    ]);
    await phone.flush();
    const prompt = await db.db
      .prepare("SELECT token FROM room_phone_prompts WHERE target='question-1'")
      .get<{ token: string }>();
    await transport.receive(message(`/answer ${prompt?.token} yes`, 'wrong-group', 'baileys:group-b@g.us'));
    expect(answerQuestions).not.toHaveBeenCalled();
    await transport.receive(message(`/answer ${prompt?.token} yes`, 'right-group'));
    await transport.receive(message(`/answer ${prompt?.token} yes`, 'right-group'));
    await transport.receive(message(`/answer ${prompt?.token} yes`, 'replay-new-id'));
    expect(answerQuestions).toHaveBeenCalledExactlyOnceWith('a', { answers: [{ id: 'question-1', confirmed: true }] });
    await rooms.setLeadQuestions('a', [{ id: 'question-2', method: 'confirm', title: 'New approval' }]);
    await phone.flush();
    const expired = await db.db
      .prepare("SELECT token FROM room_phone_prompts WHERE target='question-2'")
      .get<{ token: string }>();
    await db.db.prepare("UPDATE room_phone_prompts SET expires_at=1 WHERE target='question-2'").run();
    await transport.receive(message(`/answer ${expired?.token} yes`, 'expired'));
    expect(answerQuestions).toHaveBeenCalledTimes(1);
  });

  it('never makes an incomplete long action preview approvable over the phone', async () => {
    await bind();
    const action = await notes.insertAction({
      id: '0f331f36-ffbf-4739-abf4-14e0810776c2',
      roomId: 'a',
      kind: 'call',
      name: 'mail-send',
      summary: 'Send draft',
      payload: { body: 'X'.repeat(12000) },
    });
    await phone.flush();
    const prompt = await db.db
      .prepare('SELECT token,consumed_at FROM room_phone_prompts WHERE target=?')
      .get<{ token: string; consumed_at: number | null }>(action.id);
    expect(prompt?.consumed_at).toEqual(expect.any(Number));
    expect(transport.send.mock.calls.map((call) => call[1]).join('\n')).not.toContain('/approve');
    await transport.receive(message(`/approve ${prompt?.token}`, 'approval'));
    expect(decide).not.toHaveBeenCalled();
  });

  it('keeps pause and unlink responsive during approved external execution and fences its late notification after relinking', async () => {
    await bind();
    await bind('b', 'baileys:group-b@g.us');
    const action = await notes.insertAction({
      id: '40c4fb71-6070-4f72-a157-dfce7113eb87',
      roomId: 'a',
      kind: 'call',
      name: 'slow-tool',
      summary: 'Approved external work',
      payload: {},
    });
    await phone.flush();
    const prompt = await db.db
      .prepare('SELECT token FROM room_phone_prompts WHERE target=?')
      .get<{ token: string }>(action.id);
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const outcome = new Promise<void>((resolve) => {
      release = resolve;
    });
    decide.mockImplementationOnce(async (roomId: string, id: string) => {
      entered();
      await outcome;
      await notes.decide(roomId, id, 'done', 'complete');
      return notes.action(roomId, id);
    });
    const approved = transport.receive(message(`/approve ${prompt?.token}`, 'slow-approval'));
    await started;
    await transport.receive(message('/pause', 'parallel-pause', 'baileys:group-b@g.us'));
    expect((await rooms.get('b'))?.paused).toBe(true);
    await phone.unlink('a');
    await bind();
    release();
    await approved;
    expect((await notes.action('a', action.id))?.state).toBe('done');
    expect((await rooms.events('a')).some((event) => event.text === 'Your decision was recorded.')).toBe(false);
    expect(decide).toHaveBeenCalledTimes(1);
  });

  it('returns after approval admission so subsequent messages in the same SDK batch can pause the room', async () => {
    await bind();
    const action = await notes.insertAction({
      id: '3e36c8ab-6070-4f72-a157-dfce7113eb87',
      roomId: 'a',
      kind: 'call',
      name: 'batch-tool',
      summary: 'Slow approved call',
      payload: {},
    });
    await phone.flush();
    const prompt = await db.db
      .prepare('SELECT token FROM room_phone_prompts WHERE target=?')
      .get<{ token: string }>(action.id);
    let release!: () => void;
    let finished = false;
    const external = new Promise<void>((resolve) => {
      release = resolve;
    });
    decide.mockImplementationOnce(async (roomId: string, id: string) => {
      await external;
      finished = true;
      await notes.decide(roomId, id, 'done', 'complete');
      return notes.action(roomId, id);
    });
    // The adapter awaits each callback in a batch; this sequence must not await external completion.
    await transport.receive(message(`/approve ${prompt?.token}`, 'batch-approval'));
    expect(finished).toBe(false);
    await transport.receive(message('/pause', 'batch-pause'));
    expect((await rooms.get('a'))?.paused).toBe(true);
    release();
    await vi.waitFor(() => expect(finished).toBe(true));
  });

  it('does not hold admission while an answered question is returning its refreshed detail', async () => {
    await bind();
    await bind('b', 'baileys:group-b@g.us');
    await rooms.setLeadQuestions('a', [{ id: 'slow-question', method: 'confirm', title: 'Continue?' }]);
    await phone.flush();
    const prompt = await db.db
      .prepare("SELECT token FROM room_phone_prompts WHERE target='slow-question'")
      .get<{ token: string }>();
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const detail = new Promise<void>((resolve) => {
      release = resolve;
    });
    answerQuestions.mockImplementationOnce(async (roomId: string, body: RoomTaskAnswer) => {
      await rooms.setLeadQuestions(roomId, []);
      entered();
      await detail;
      return body;
    });
    const answered = transport.receive(message(`/answer ${prompt?.token} yes`, 'slow-answer'));
    await started;
    await transport.receive(message('/pause', 'pause-during-answer', 'baileys:group-b@g.us'));
    expect((await rooms.get('b'))?.paused).toBe(true);
    await phone.unlink('a');
    release();
    await answered;
    expect((await rooms.events('a')).some((event) => event.text === 'Answer recorded.')).toBe(false);
  });

  it('applies short action approvals to that exact draft once', async () => {
    await bind();
    const action = await notes.insertAction({
      id: '5ffcc6a7-6070-4f72-a157-dfce7113eb87',
      roomId: 'a',
      kind: 'call',
      name: 'calendar-move',
      summary: 'Move the meeting',
      payload: { meeting: 'customer', to: '10:00 UTC' },
    });
    await phone.flush();
    const prompt = await db.db
      .prepare('SELECT token FROM room_phone_prompts WHERE target=?')
      .get<{ token: string }>(action.id);
    await transport.receive(message(`/approve ${prompt?.token}`, 'approve-once'));
    await transport.receive(message(`/approve ${prompt?.token}`, 'approve-replay'));
    expect(decide).toHaveBeenCalledExactlyOnceWith('a', action.id, { decision: 'approve' });
    expect((await notes.action('a', action.id))?.state).toBe('done');
  });

  it('supports owner memory commands without a playbook and sends pause acknowledgements while holding room work', async () => {
    await bind();
    await transport.receive(message('/remember working-hours: 09:00–17:00', 'remember'));
    expect((await notes.memory(['room:a']))[0]).toMatchObject({ key: 'working-hours', text: '09:00–17:00' });
    await transport.receive(message('/forget working-hours', 'forget'));
    expect(await notes.memory(['room:a'])).toEqual([]);
    await transport.receive(message('/pause', 'pause'));
    expect((await rooms.get('a'))?.paused).toBe(true);
    await transport.receive(message('hold this', 'held'));
    await phone.flush();
    expect(post).not.toHaveBeenCalled();
    await transport.receive(message('/resume', 'resume'));
    await phone.flush();
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('downloads an admitted voice note once, transcribes it and preserves its room file', async () => {
    await bind();
    const incoming = {
      ...message('', 'voice'),
      files: [{ name: 'note.ogg', mime: 'audio/ogg', type: 'audio', size: 3 }],
      raw: 'serialized media',
    };
    await transport.receive({ ...incoming, sender: 'someone-else@lid' });
    await phone.flush();
    expect(transport.media).not.toHaveBeenCalled();
    await transport.receive(incoming);
    await transport.receive(incoming);
    await phone.flush();
    expect(transport.media).toHaveBeenCalledExactlyOnceWith('serialized media');
    expect(transcribe.transcribe).toHaveBeenCalledTimes(1);
    expect(workspace.upload).toHaveBeenCalledWith('a', expect.any(Number), 'note.ogg', new Uint8Array([1, 2, 3]));
    expect(post.mock.calls[0][1].text).toContain('Prepare the meeting');
    expect(post.mock.calls[0][1].text).toContain('inbox/');
    expect(
      (
        await db.db
          .prepare('SELECT raw_json,files_json FROM room_phone_inbox')
          .get<{ raw_json: string | null; files_json: string }>()
      )?.raw_json,
    ).toBeNull();
  });

  it('routes a quoted reply using only the current binding and preserves outgoing room links', async () => {
    await bind();
    await bind('b', 'baileys:group-b@g.us');
    await phone.config('a', { appUrl: 'https://host.example.test/phone#old-fragment' });
    await rooms.append('a', { kind: 'message', actor: 'lead', text: 'Meeting brief' });
    await phone.flush();
    const row = await db.db
      .prepare('SELECT provider_id FROM room_phone_deliveries WHERE room_id=?')
      .get<{ provider_id: string }>('a');
    expect(transport.send.mock.calls[0][1]).toContain('#room=a');
    await transport.receive({ ...message('Change the second item', 'reply'), quoteId: row?.provider_id });
    await phone.flush();
    expect(post.mock.calls[0][1].text).toContain('Reply to room update: Meeting brief');
    await transport.receive({ ...message('Other room', 'reply-b', 'baileys:group-b@g.us'), quoteId: row?.provider_id });
    await phone.flush();
    expect(post.mock.calls[1][1].text).toBe('Other room');
  });
  it('holds scheduled updates during quiet hours without blocking owner replies, then enforces the daily cap', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 10, 23, 23, 0));
    await bind();
    await policy.setPolicy('a', {
      enabled: true,
      timezone: 'UTC',
      quietStart: '22:00',
      quietEnd: '08:00',
      dailyLimit: 1,
    });
    const wake = await rooms.enqueueWake('a', 'scheduled check', { kind: 'schedule', title: 'Brief' }, 'scheduled');
    await rooms.append('a', { kind: 'message', actor: 'lead', text: 'Scheduled brief', workId: wake });
    await rooms.append('a', { kind: 'message', actor: 'lead', text: 'Direct reply' });
    await phone.flush();
    expect(transport.send.mock.calls.map((call) => call[1])).toEqual(['Direct reply']);
    await policy.setPolicy('a', { enabled: true, timezone: 'UTC', quietStart: null, quietEnd: null, dailyLimit: 1 });
    await phone.flush();
    expect(transport.send.mock.calls.map((call) => call[1])).toEqual(['Direct reply', 'Scheduled brief']);
    const next = await rooms.enqueueWake(
      'a',
      'another scheduled check',
      { kind: 'poll', title: 'Research' },
      'another',
    );
    await rooms.append('a', { kind: 'message', actor: 'lead', text: 'Another brief', workId: next });
    await phone.flush();
    expect(transport.send).toHaveBeenCalledTimes(2);
    expect((await phone.status('a')).pendingDeliveries).toBe(1);
  });

  it('suppresses obsolete reminder results both before capture and after a pending delivery exists', async () => {
    await bind();
    await policy.setPolicy('a', { enabled: true, timezone: 'UTC', quietStart: null, quietEnd: null, dailyLimit: 10 });
    const item = await policy.create('a', {
      title: 'Meeting',
      details: 'Prepare',
      dueAt: Date.now(),
      timezone: 'UTC',
      dailyAt: null,
      source: 'owner',
    });
    const wake = await rooms.enqueueWake('a', 'due', { kind: 'schedule', title: 'Meeting', trigger: item.id }, 'due');
    await db.db.prepare('UPDATE room_wakeups SET commitment_revision=0 WHERE id=?').run(wake);
    await rooms.append('a', { kind: 'message', actor: 'lead', text: 'This result was superseded', workId: wake });
    await policy.change('a', item.id, { dueAt: Date.now() + 3600000 });
    await phone.flush();
    expect(transport.send).not.toHaveBeenCalled();
    const current = await rooms.enqueueWake(
      'a',
      'due again',
      { kind: 'schedule', title: 'Meeting again', trigger: item.id },
      'due-2',
    );
    await db.db.prepare('UPDATE room_wakeups SET commitment_revision=1 WHERE id=?').run(current);
    await rooms.append('a', {
      kind: 'message',
      actor: 'lead',
      text: 'This pending result became obsolete',
      workId: current,
    });
    await store.capture('a');
    await policy.change('a', item.id, { state: 'done' });
    await phone.flush();
    expect(transport.send).not.toHaveBeenCalled();
    expect((await phone.status('a')).pendingDeliveries).toBe(0);
  });

  it('does not expose approvable tokens after their request expires or is answered in the app', async () => {
    await bind();
    await rooms.setLeadQuestions('a', [{ id: 'stale-question', method: 'confirm', title: 'Approve?' }]);
    await store.prompt('a', 'stale-question', 'question', presentPhonePrompt('question', 'Approve?'));
    await rooms.setLeadQuestions('a', []);
    await phone.flush();
    expect(transport.send).not.toHaveBeenCalled();
    await rooms.setLeadQuestions('a', [{ id: 'expired-question', method: 'confirm', title: 'Approve later?' }]);
    await store.prompt('a', 'expired-question', 'question', presentPhonePrompt('question', 'Approve later?'));
    await db.db.prepare("UPDATE room_phone_prompts SET expires_at=1 WHERE target='expired-question'").run();
    await phone.flush();
    await phone.flush();
    expect(transport.send).not.toHaveBeenCalled();
    await transport.receive(message('/pending', 'renew-pending'));
    await phone.flush();
    expect(transport.send).toHaveBeenCalledTimes(1);
  });
});
