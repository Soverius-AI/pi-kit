import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AsyncSqlite } from '../db/async-sqlite';
import type { DatabaseService } from '../db/database.service';
import { RoomsRepository } from '../db/rooms.repository';
import { RoomPhoneRepository } from '../db/room-phone.repository';

describe('messaging channel upgrade', () => {
  it('retains legacy WhatsApp binding, canonical input, prompts, stable retries and outgoing identities with foreign keys enabled', async () => {
    const db = await AsyncSqlite.open(':memory:');
    try {
      await db.pragma('foreign_keys = ON');
      const migrations = fileURLToPath(new URL('../db/migrations', import.meta.url));
      for (const name of readdirSync(migrations)
        .filter((name) => name.endsWith('.sql') && name < '0022')
        .sort())
        await db.exec(readFileSync(join(migrations, name), 'utf8'));
      const database = { db } as DatabaseService;
      const rooms = new RoomsRepository(database);
      await rooms.insert({
        id: 'old-room',
        title: 'Personal',
        summary: '',
        sourceThreadId: null,
        projectFolder: '/tmp/room',
        repository: '',
        baseCommit: '',
        createdAt: 1,
      });
      const source = 'phone:legacy-account:legacy-group:incoming';
      const { event } = await rooms.acceptMessage('old-room', { text: 'Retain this operation' }, source);
      const wake = await rooms.wakeBySource('old-room', source);
      await db
        .prepare(
          "INSERT INTO room_phone_links(room_id,group_id,account_id,sender_id,after_seq,binding_id,app_url,verified_at) VALUES ('old-room','legacy-group','legacy-account','owner',1,'binding','https://room.example/',123)",
        )
        .run();
      await db
        .prepare(
          "INSERT INTO room_phone_inbox(room_id,provider_id,text,state,created_at,event_seq,work_id,source_key,files_json) VALUES ('old-room','incoming','Retain this operation','accepted',1,?,?,?,'[]')",
        )
        .run(event.seq, wake?.id, source);
      await db
        .prepare(
          "INSERT INTO room_phone_prompts(token,room_id,target,kind,expires_at) VALUES ('legacy-token','old-room','question','question',?)",
        )
        .run(Date.now() + 60000);
      await db
        .prepare(
          "INSERT INTO room_phone_deliveries(room_id,seq,text,state,provider_id,tries,next_at,prompt_id) VALUES ('old-room',2,'Pending reply','pending','stable-id',1,5000,'legacy-token')",
        )
        .run();
      await db
        .prepare(
          "INSERT INTO room_phone_outgoing(account_id,group_id,provider_id,created_at) VALUES ('legacy-account','legacy-group','stable-id',1)",
        )
        .run();
      await db.exec(readFileSync(join(migrations, '0022_room_messaging_channels.sql'), 'utf8'));
      const whatsapp = new RoomPhoneRepository(database, 'whatsapp');
      expect(await whatsapp.get('old-room')).toMatchObject({
        group_id: 'legacy-group',
        account_id: 'legacy-account',
        app_url: 'https://room.example/',
        verified_at: 123,
        binding_id: 'binding',
      });
      expect(
        await db.prepare("SELECT work_id,source_key,state FROM room_channel_inbox WHERE channel='whatsapp'").get(),
      ).toEqual({ work_id: wake?.id, source_key: source, state: 'accepted' });
      expect(await whatsapp.delivery('old-room', true, 5001)).toMatchObject({
        provider_id: 'stable-id',
        tries: 1,
        prompt_id: 'legacy-token',
      });
      expect(await whatsapp.peekPrompt('old-room', 'legacy-token')).toEqual({ target: 'question', kind: 'question' });
      expect(await whatsapp.isOutgoing('legacy-group', 'legacy-account', 'stable-id')).toBe(true);
      const signal = new RoomPhoneRepository(database, 'signal');
      await signal.begin('old-room', 'code', Date.now() + 60000);
      await signal.candidate('code', 'legacy-group', 'owner', '', '', Date.now());
      expect(await signal.confirm('old-room', 'legacy-group', 'owner', 'signal-account', Date.now())).toBe(true);
      expect(await db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      await db.close();
    }
  });
  it('adds Telegram without losing any existing provider row, relationship, index or inbox high-water mark', async () => {
    const db = await AsyncSqlite.open(':memory:');
    try {
      await db.pragma('foreign_keys = ON');
      const migrations = fileURLToPath(new URL('../db/migrations', import.meta.url));
      for (const name of readdirSync(migrations)
        .filter((name) => name.endsWith('.sql') && name < '0023')
        .sort())
        await db.exec(readFileSync(join(migrations, name), 'utf8'));
      const database = { db } as DatabaseService;
      const rooms = new RoomsRepository(database);
      await rooms.insert({
        id: 'shared-room',
        title: 'Personal',
        summary: '',
        sourceThreadId: null,
        projectFolder: '/tmp/room',
        repository: '',
        baseCommit: '',
        createdAt: 1,
      });
      const providers = ['whatsapp', 'signal', 'slack'] as const;
      for (const channel of providers) {
        let serial = 0;
        const repository = new RoomPhoneRepository(database, channel, () => `${channel}-out-${++serial}`);
        await repository.begin('shared-room', 'challenge', Date.now() + 60000);
        await repository.candidate('challenge', 'same-group', 'owner', 'Owner', 'Conversation', Date.now());
        expect(await repository.confirm('shared-room', 'same-group', 'owner', `${channel}-account`, Date.now())).toBe(
          true,
        );
        await repository.config('shared-room', 'https://room.example/');
        await repository.verified('shared-room');
        await repository.receive('same-group', 'owner', `${channel}-account`, 'same-input', 'Keep this work', 123, {
          raw: '{"saved":true}',
          quoteId: 'quote-id',
          files: [{ name: 'note.txt', mime: 'text/plain', type: 'file', size: 3 }],
        });
        const input = await repository.pending('shared-room');
        if (!input) throw new Error('Fixture input was not stored.');
        const accepted = await rooms.acceptMessage('shared-room', { text: 'Keep this work' }, input.source_key);
        const wake = await rooms.wakeBySource('shared-room', input.source_key);
        if (!wake) throw new Error('Fixture work was not accepted.');
        await repository.accepted(input.id, wake.id, accepted.event.seq);
        await repository.prompt('shared-room', 'same-question', 'question', {
          token: 'same-token',
          text: 'Preserved preview',
          expiresAt: Date.now() + 60000,
          consumed: false,
        });
        await repository.claimCommand('shared-room', 'same-command');
        await repository.recordOutgoing('same-group', `${channel}-account`, 'same-outgoing');
        const delivery = await repository.delivery('shared-room');
        if (!delivery) throw new Error('Fixture delivery was not stored.');
        await repository.deliveryState('shared-room', delivery.seq, 'sending');
      }
      await db
        .prepare(
          "INSERT INTO room_channel_inbox(id,channel,room_id,provider_id,text,created_at) VALUES (10000,'whatsapp','shared-room','deleted-high-water','',1)",
        )
        .run();
      await db.prepare('DELETE FROM room_channel_inbox WHERE id=10000').run();
      const tables = ['links', 'prompts', 'inbox', 'deliveries', 'commands', 'outgoing'];
      const snapshot = async () =>
        Promise.all(
          tables.map((name) => db.prepare(`SELECT * FROM room_channel_${name} ORDER BY channel,rowid`).all()),
        );
      const before = await snapshot();
      expect(await db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      await db.transaction(() => db.exec(readFileSync(join(migrations, '0023_room_telegram_channel.sql'), 'utf8')))();
      expect(await snapshot()).toEqual(before);
      expect(await db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(await db.prepare("SELECT seq FROM sqlite_sequence WHERE name='room_channel_inbox'").get()).toEqual({
        seq: 10000,
      });
      expect(
        await db.prepare("SELECT name FROM sqlite_schema WHERE sql LIKE '%_0023%' AND name NOT LIKE 'sqlite_%'").all(),
      ).toEqual([]);
      expect(
        (
          await db
            .prepare(
              "SELECT name FROM sqlite_schema WHERE type='index' AND name IN('room_channel_inbox_work','room_channel_delivery_prompt') ORDER BY name",
            )
            .all<{ name: string }>()
        ).map((row) => row.name),
      ).toEqual(['room_channel_delivery_prompt', 'room_channel_inbox_work']);
      const telegram = new RoomPhoneRepository(database, 'telegram');
      await telegram.begin('shared-room', 'new-code', Date.now() + 60000);
      await telegram.candidate('new-code', 'same-group', 'owner', '', '', Date.now());
      expect(await telegram.confirm('shared-room', 'same-group', 'owner', 'telegram-bot', Date.now())).toBe(true);
      await telegram.receive('same-group', 'owner', 'telegram-bot', 'new-input', 'Telegram');
      expect((await telegram.pending('shared-room'))?.id).toBe(10001);
      await new RoomPhoneRepository(database, 'whatsapp').unlink('shared-room');
      expect(await new RoomPhoneRepository(database, 'signal').get('shared-room')).toBeDefined();
      expect(await new RoomPhoneRepository(database, 'slack').peekPrompt('shared-room', 'same-token')).toBeDefined();
      expect(await db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      await db.close();
    }
  });
});
