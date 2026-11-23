import { Inject, Injectable, Optional } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { redact, type ReviewRoomPhone, type RoomChannel } from '@pi-kit/protocol';
import { DatabaseService } from './database.service';
import {
  PhoneAttachmentsSchema,
  PhoneDeliveryKindSchema,
  type PhoneAttachment,
  type PhonePromptKind,
  type PhonePromptDraft,
  type PhoneDeliveryKind,
} from '../rooms/room-phone.types';

export interface PhoneLinkRow {
  room_id: string;
  binding_id: string | null;
  code_hash: string | null;
  expires_at: number | null;
  candidate_group: string | null;
  candidate_sender: string | null;
  candidate_name: string | null;
  candidate_group_name: string | null;
  group_id: string | null;
  group_name: string | null;
  account_id: string | null;
  sender_id: string | null;
  sender_name: string | null;
  after_seq: number;
  app_url: string | null;
  verified_at: number | null;
}

@Injectable()
export class RoomPhoneRepository {
  constructor(
    private readonly database: DatabaseService,
    @Optional() @Inject('ROOM_MESSAGING_CHANNEL') readonly channel: RoomChannel = 'whatsapp',
    @Optional()
    @Inject('ROOM_MESSAGING_MESSAGE_ID')
    private readonly messageId: () => string = () => '3EB0' + randomBytes(9).toString('hex').toUpperCase(),
  ) {}
  private get db() {
    return this.database.db;
  }
  async get(room: string): Promise<PhoneLinkRow | undefined> {
    return this.db.prepare('SELECT * FROM room_channel_links WHERE channel=? AND room_id=?').get(this.channel, room);
  }
  async active(): Promise<PhoneLinkRow[]> {
    return this.db
      .prepare(
        'SELECT p.* FROM room_channel_links p JOIN rooms r ON r.id=p.room_id WHERE p.channel=? AND p.group_id IS NOT NULL AND r.archived_at IS NULL',
      )
      .all(this.channel);
  }
  async begin(room: string, code: string, expires: number): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO room_channel_links(channel,room_id,code_hash,expires_at) VALUES (?,?,?,?) ON CONFLICT(channel,room_id) DO UPDATE SET code_hash=excluded.code_hash,expires_at=excluded.expires_at,candidate_group=NULL,candidate_sender=NULL,candidate_name=NULL,candidate_group_name=NULL`,
      )
      .run(this.channel, room, hash(code), expires);
  }
  async candidate(
    code: string,
    group: string,
    sender: string,
    name: string,
    groupName: string,
    now: number,
  ): Promise<boolean> {
    const result = await this.db
      .prepare(
        'UPDATE room_channel_links SET candidate_group=?,candidate_sender=?,candidate_name=?,candidate_group_name=? WHERE channel=? AND code_hash=? AND expires_at>? AND group_id IS NULL AND candidate_group IS NULL',
      )
      .run(group, sender, name.slice(0, 200), groupName.slice(0, 200), this.channel, hash(code), now);
    return Number(result.changes) === 1;
  }
  async confirm(room: string, group: string, sender: string, account: string, now: number): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE room_channel_links SET group_id=candidate_group,sender_id=candidate_sender,sender_name=candidate_name,group_name=candidate_group_name,account_id=?,binding_id=lower(hex(randomblob(16))),code_hash=NULL,expires_at=NULL,candidate_group=NULL,candidate_sender=NULL,candidate_name=NULL,after_seq=(SELECT COALESCE(MAX(seq),0) FROM room_events WHERE room_id=?) WHERE channel=? AND room_id=? AND group_id IS NULL AND candidate_group=? AND candidate_sender=? AND expires_at>? AND NOT EXISTS(SELECT 1 FROM room_channel_links p WHERE p.channel=? AND p.group_id=?)`,
      )
      .run(account, room, this.channel, room, group, sender, now, this.channel, group);
    return Number(result.changes) === 1;
  }
  async unlink(room: string): Promise<void> {
    await this.db.transaction(async () => {
      for (const table of [
        'room_channel_inbox',
        'room_channel_deliveries',
        'room_channel_prompts',
        'room_channel_commands',
        'room_channel_links',
      ])
        await this.db.prepare(`DELETE FROM ${table} WHERE channel=? AND room_id=?`).run(this.channel, room);
    })();
  }
  async receive(
    group: string,
    sender: string,
    account: string,
    id: string,
    text: string,
    now = Date.now(),
    extra?: { raw?: string; files?: PhoneAttachment[]; quoteId?: string },
  ): Promise<void> {
    const files = PhoneAttachmentsSchema.parse(extra?.files ?? []);
    const source =
      this.channel === 'whatsapp'
        ? `phone:${account}:${group}:${id}`
        : `channel:${this.channel}:${account}:${group}:${id}`;
    await this.db
      .prepare(
        `INSERT INTO room_channel_inbox(channel,room_id,provider_id,text,created_at,raw_json,files_json,quote_id,source_key) SELECT p.channel,p.room_id,?,?,?,?,?,?,? FROM room_channel_links p JOIN rooms r ON r.id=p.room_id WHERE p.channel=? AND p.group_id=? AND p.sender_id=? AND p.account_id=? AND r.archived_at IS NULL ON CONFLICT(channel,room_id,provider_id) DO NOTHING`,
      )
      .run(
        id,
        redact(text) as string,
        now,
        extra?.raw ?? null,
        JSON.stringify(files),
        extra?.quoteId ?? null,
        source,
        this.channel,
        group,
        sender,
        account,
      );
  }
  async authorized(group: string, sender: string, account: string): Promise<PhoneLinkRow | undefined> {
    return this.db
      .prepare(
        'SELECT p.* FROM room_channel_links p JOIN rooms r ON r.id=p.room_id WHERE p.channel=? AND p.group_id=? AND p.sender_id=? AND p.account_id=? AND r.archived_at IS NULL',
      )
      .get(this.channel, group, sender, account);
  }
  async isOutgoing(group: string, account: string, id: string): Promise<boolean> {
    return !!(await this.db
      .prepare('SELECT 1 FROM room_channel_outgoing WHERE channel=? AND account_id=? AND group_id=? AND provider_id=?')
      .get(this.channel, account, group, id));
  }
  async recordOutgoing(group: string, account: string, id: string): Promise<void> {
    await this.db
      .prepare(
        'INSERT INTO room_channel_outgoing(channel,account_id,group_id,provider_id,created_at) VALUES (?,?,?,?,?) ON CONFLICT DO NOTHING',
      )
      .run(this.channel, account, group, id, Date.now());
  }
  async valid(binding: PhoneLinkRow): Promise<boolean> {
    return !!(await this.db
      .prepare(
        'SELECT 1 FROM room_channel_links p JOIN rooms r ON r.id=p.room_id WHERE p.channel=? AND p.room_id=? AND p.binding_id=? AND r.archived_at IS NULL',
      )
      .get(this.channel, binding.room_id, binding.binding_id));
  }
  async pending(room: string): Promise<PhoneInput | undefined> {
    const row = await this.db
      .prepare("SELECT * FROM room_channel_inbox WHERE channel=? AND room_id=? AND state='pending' ORDER BY id LIMIT 1")
      .get<PhoneInput & { files_json: string }>(this.channel, room);
    if (!row) return;
    try {
      return { ...row, files: PhoneAttachmentsSchema.parse(JSON.parse(row.files_json)) };
    } catch {
      await this.inputState(row.id, 'review');
      return;
    }
  }
  async prepared(id: number, text: string, files: PhoneAttachment[]): Promise<void> {
    await this.db
      .prepare('UPDATE room_channel_inbox SET text=?,files_json=?,raw_json=NULL,prepared_at=? WHERE channel=? AND id=?')
      .run(redact(text) as string, JSON.stringify(PhoneAttachmentsSchema.parse(files)), Date.now(), this.channel, id);
  }
  async inputState(id: number, state: 'pending' | 'dispatching' | 'accepted' | 'review'): Promise<void> {
    await this.db
      .prepare('UPDATE room_channel_inbox SET state=? WHERE channel=? AND id=?')
      .run(state, this.channel, id);
  }
  async syncInputs(room?: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE room_channel_inbox SET work_id=COALESCE(work_id,(SELECT w.id FROM room_wakeups w WHERE w.room_id=room_channel_inbox.room_id AND w.source_key=room_channel_inbox.source_key)) WHERE channel=? AND (? IS NULL OR room_id=?)`,
      )
      .run(this.channel, room ?? null, room ?? null);
    await this.db
      .prepare(
        `UPDATE room_channel_inbox SET state=CASE (SELECT state FROM room_wakeups WHERE id=work_id) WHEN 'done' THEN 'done' WHEN 'failed' THEN 'review' WHEN 'review' THEN 'review' ELSE 'accepted' END WHERE channel=? AND work_id IS NOT NULL AND state IN ('pending','dispatching','accepted','review') AND (? IS NULL OR room_id=?)`,
      )
      .run(this.channel, room ?? null, room ?? null);
  }
  async releaseClaims(room?: string, retryStableSends = false): Promise<void> {
    await this.syncInputs(room);
    await this.db
      .prepare(
        "UPDATE room_channel_inbox SET state='pending' WHERE channel=? AND state='dispatching' AND (? IS NULL OR room_id=?)",
      )
      .run(this.channel, room ?? null, room ?? null);
    await this.db
      .prepare(
        "UPDATE room_channel_deliveries SET state=CASE WHEN ?=1 AND tries<3 THEN 'pending' ELSE 'review' END,next_at=? WHERE channel=? AND state='sending' AND (? IS NULL OR room_id=?)",
      )
      .run(retryStableSends ? 1 : 0, Date.now() + 5000, this.channel, room ?? null, room ?? null);
  }
  async capture(room: string): Promise<void> {
    await this.db.transaction(async () => {
      const rows = await this.db
        .prepare(
          `SELECT e.seq,e.text,e.work_id,i.provider_id AS quote_id,i.text AS quote_text,CASE WHEN json_extract(w.cause_json,'$.kind') IN ('schedule','poll') THEN 'proactive' ELSE 'reply' END AS kind FROM room_events e JOIN room_channel_links p ON p.room_id=e.room_id LEFT JOIN room_wakeups w ON w.id=e.work_id LEFT JOIN room_commitments c ON c.id=json_extract(w.cause_json,'$.trigger') AND c.room_id=e.room_id LEFT JOIN room_channel_inbox i ON i.channel=p.channel AND i.room_id=e.room_id AND i.event_seq=w.owner_seq WHERE p.channel=? AND e.room_id=? AND e.seq>p.after_seq AND e.actor='lead' AND e.kind='message' AND NOT(trim(e.text)='[NO_UPDATE]' AND COALESCE(json_extract(w.cause_json,'$.kind'),'owner') IN ('schedule','poll')) AND(c.id IS NULL OR(c.state='open' AND c.revision=w.commitment_revision))`,
        )
        .all<{
          seq: number;
          text: string;
          work_id: string | null;
          quote_id: string | null;
          quote_text: string | null;
          kind: PhoneDeliveryKind;
        }>(this.channel, room);
      for (const row of rows)
        await this.db
          .prepare(
            'INSERT INTO room_channel_deliveries(channel,room_id,seq,text,provider_id,kind,work_id,quote_id,quote_text) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING',
          )
          .run(
            this.channel,
            room,
            row.seq,
            row.text,
            this.messageId(),
            row.kind,
            row.work_id,
            row.quote_id,
            row.quote_text,
          );
      await this.db
        .prepare(
          'UPDATE room_channel_links SET after_seq=(SELECT COALESCE(MAX(seq),0) FROM room_events WHERE room_id=?) WHERE channel=? AND room_id=?',
        )
        .run(room, this.channel, room);
    })();
  }
  async delivery(room: string, proactive = true, now = Date.now(), paused = false): Promise<PhoneDelivery | undefined> {
    const row = await this.db
      .prepare(
        "SELECT * FROM room_channel_deliveries WHERE channel=? AND room_id=? AND state='pending' AND next_at<=? AND(kind<>'proactive' OR ?) AND(?=0 OR kind IN ('status','test')) ORDER BY CASE WHEN kind='proactive' THEN 1 ELSE 0 END,seq LIMIT 1",
      )
      .get<PhoneDelivery>(this.channel, room, now, proactive ? 1 : 0, paused ? 1 : 0);
    return row ? { ...row, kind: PhoneDeliveryKindSchema.parse(row.kind) } : undefined;
  }
  async canSend(room: string, seq: number): Promise<boolean> {
    const row = await this.db
      .prepare(
        `SELECT r.paused,d.kind FROM room_channel_deliveries d JOIN rooms r ON r.id=d.room_id LEFT JOIN room_channel_prompts p ON p.channel=d.channel AND p.token=d.prompt_id LEFT JOIN room_wakeups w ON w.id=d.work_id LEFT JOIN room_commitments c ON c.room_id=d.room_id AND c.id=json_extract(w.cause_json,'$.trigger') WHERE d.channel=? AND d.room_id=? AND d.seq=? AND d.state='sending' AND r.archived_at IS NULL AND(d.prompt_id IS NULL OR(p.expires_at>? AND p.consumed_at IS NULL)) AND(c.id IS NULL OR(c.state='open' AND c.revision=w.commitment_revision))`,
      )
      .get<{ paused: number; kind: PhoneDeliveryKind }>(this.channel, room, seq, Date.now());
    if (row?.paused && !['status', 'test'].includes(row.kind)) {
      await this.db
        .prepare(
          "UPDATE room_channel_deliveries SET state='pending',tries=MAX(tries-1,0) WHERE channel=? AND room_id=? AND seq=? AND state='sending'",
        )
        .run(this.channel, room, seq);
      return false;
    }
    if (!row)
      await this.db
        .prepare(
          "UPDATE room_channel_deliveries SET state='dismissed' WHERE channel=? AND room_id=? AND seq=? AND state='sending'",
        )
        .run(this.channel, room, seq);
    return !!row;
  }
  async deliveryState(
    room: string,
    seq: number,
    state: 'sending' | 'sent' | 'review',
    providerId: string | null = null,
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE room_channel_deliveries SET state=?,provider_id=COALESCE(?,provider_id),tries=tries+CASE WHEN ?='sending' THEN 1 ELSE 0 END,sent_at=CASE WHEN ?='sent' THEN COALESCE(sent_at,?) ELSE sent_at END WHERE channel=? AND room_id=? AND seq=? AND state NOT IN ('dismissed','sent')`,
      )
      .run(state, providerId, state, state, Date.now(), this.channel, room, seq);
  }
  async later(room: string, seq: number, nextAt: number, review: boolean): Promise<void> {
    await this.db
      .prepare(
        "UPDATE room_channel_deliveries SET state=?,next_at=? WHERE channel=? AND room_id=? AND seq=? AND state NOT IN ('sent','dismissed')",
      )
      .run(review ? 'review' : 'pending', nextAt, this.channel, room, seq);
  }
  async recover(retryStableSends = false): Promise<void> {
    await this.db
      .prepare("UPDATE room_channel_inbox SET state='pending' WHERE channel=? AND state='dispatching'")
      .run(this.channel);
    await this.syncInputs();
    await this.db
      .prepare(
        "UPDATE room_channel_deliveries SET state=CASE WHEN ?=1 AND tries<3 THEN 'pending' ELSE 'review' END WHERE channel=? AND state='sending'",
      )
      .run(retryStableSends ? 1 : 0, this.channel);
  }
  async accepted(id: number, work: string, seq: number | null): Promise<void> {
    await this.db
      .prepare("UPDATE room_channel_inbox SET work_id=?,event_seq=?,state='accepted' WHERE channel=? AND id=?")
      .run(work, seq, this.channel, id);
  }
  async receipt(id: string, status: number, group: string, account?: string): Promise<void> {
    if (status < 2) return;
    await this.db
      .prepare(
        `UPDATE room_channel_deliveries SET state='sent',sent_at=COALESCE(sent_at,?),delivered_at=CASE WHEN ?>=3 THEN COALESCE(delivered_at,?) ELSE delivered_at END,read_at=CASE WHEN ?>=4 THEN COALESCE(read_at,?) ELSE read_at END WHERE channel=? AND provider_id=? AND state<>'dismissed' AND room_id IN(SELECT room_id FROM room_channel_links WHERE channel=? AND group_id=? AND(? IS NULL OR account_id=?))`,
      )
      .run(
        Date.now(),
        status,
        Date.now(),
        status,
        Date.now(),
        this.channel,
        id,
        this.channel,
        group,
        account ?? null,
        account ?? null,
      );
  }
  async health(room: string) {
    const pending = await this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM room_channel_deliveries WHERE channel=? AND room_id=? AND state IN ('pending','sending')",
      )
      .get<{ n: number }>(this.channel, room);
    const last = await this.db
      .prepare(
        'SELECT sent_at AS sentAt,delivered_at AS deliveredAt,read_at AS readAt FROM room_channel_deliveries WHERE channel=? AND room_id=? ORDER BY seq DESC LIMIT 1',
      )
      .get<{ sentAt: number | null; deliveredAt: number | null; readAt: number | null }>(this.channel, room);
    return { pendingDeliveries: pending?.n ?? 0, lastDelivery: last ?? null };
  }
  async sent(room: string, since: number): Promise<number[]> {
    return (
      await this.db
        .prepare(
          "SELECT sent_at FROM room_channel_deliveries WHERE channel=? AND room_id=? AND kind='proactive' AND sent_at>=?",
        )
        .all<{ sent_at: number }>(this.channel, room, since)
    ).map((row) => row.sent_at);
  }
  async duplicate(room: string, text: string): Promise<boolean> {
    return !!(await this.db
      .prepare(
        "SELECT 1 FROM room_channel_deliveries WHERE channel=? AND room_id=? AND text=? AND state='sent' AND kind='proactive' AND sent_at>? LIMIT 1",
      )
      .get(this.channel, room, text, Date.now() - 86400000));
  }
  async quoted(room: string, id: string): Promise<{ text: string; work_id: string | null } | undefined> {
    return this.db
      .prepare('SELECT text,work_id FROM room_channel_deliveries WHERE channel=? AND room_id=? AND provider_id=?')
      .get(this.channel, room, id);
  }
  async config(room: string, url: string): Promise<void> {
    await this.db
      .prepare('UPDATE room_channel_links SET app_url=? WHERE channel=? AND room_id=?')
      .run(url || null, this.channel, room);
  }
  async notify(
    room: string,
    text: string,
    kind: PhoneDeliveryKind = 'status',
    promptId: string | null = null,
  ): Promise<void> {
    await this.db.transaction(async () => {
      const row = await this.db
        .prepare('SELECT COALESCE(MAX(seq),0)+1 AS seq FROM room_events WHERE room_id=?')
        .get<{ seq: number }>(room);
      if (!row) throw new Error('No room.');
      await this.db
        .prepare(
          "INSERT INTO room_events(room_id,seq,kind,actor,text,created_at) VALUES (?,?,'note','coordinator',?,?)",
        )
        .run(room, row.seq, redact(text) as string, Date.now());
      await this.db
        .prepare(
          'INSERT INTO room_channel_deliveries(channel,room_id,seq,text,kind,provider_id,prompt_id) VALUES (?,?,?,?,?,?,?)',
        )
        .run(this.channel, room, row.seq, redact(text) as string, kind, this.messageId(), promptId);
    })();
  }
  async prompt(
    room: string,
    target: string,
    kind: PhonePromptKind,
    draft: PhonePromptDraft,
  ): Promise<string | undefined> {
    return this.db.transaction(async () => {
      const inserted = await this.db
        .prepare(
          'INSERT INTO room_channel_prompts(channel,token,room_id,target,kind,expires_at,consumed_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(channel,room_id,target,kind) DO NOTHING',
        )
        .run(this.channel, draft.token, room, target, kind, draft.expiresAt, draft.consumed ? Date.now() : null);
      if (!Number(inserted.changes)) return;
      await this.notify(room, draft.text, kind, draft.consumed ? null : draft.token);
      return draft.consumed ? undefined : draft.token;
    })();
  }
  async peekPrompt(room: string, token: string): Promise<{ target: string; kind: PhonePromptKind } | undefined> {
    return this.db
      .prepare(
        'SELECT target,kind FROM room_channel_prompts WHERE channel=? AND room_id=? AND token=? AND consumed_at IS NULL AND expires_at>?',
      )
      .get(this.channel, room, token, Date.now());
  }
  async takePrompt(room: string, token: string): Promise<{ target: string; kind: PhonePromptKind } | undefined> {
    return this.db.transaction(async () => {
      const row = await this.peekPrompt(room, token);
      if (!row) return;
      await this.db
        .prepare('UPDATE room_channel_prompts SET consumed_at=? WHERE channel=? AND token=?')
        .run(Date.now(), this.channel, token);
      return row;
    })();
  }
  async clearExpired(room: string): Promise<void> {
    await this.expirePrompts(room);
    await this.db
      .prepare(
        'UPDATE room_channel_deliveries SET prompt_id=NULL WHERE channel=? AND room_id=? AND prompt_id IN(SELECT token FROM room_channel_prompts WHERE channel=? AND room_id=? AND expires_at<=?)',
      )
      .run(this.channel, room, this.channel, room, Date.now());
    await this.db
      .prepare('DELETE FROM room_channel_prompts WHERE channel=? AND room_id=? AND expires_at<=?')
      .run(this.channel, room, Date.now());
  }
  private async expirePrompts(room: string): Promise<void> {
    await this.db
      .prepare(
        "UPDATE room_channel_deliveries SET state='dismissed' WHERE channel=? AND room_id=? AND state='pending' AND prompt_id IN(SELECT token FROM room_channel_prompts WHERE channel=? AND room_id=? AND expires_at<=?)",
      )
      .run(this.channel, room, this.channel, room, Date.now());
    await this.db
      .prepare(
        'UPDATE room_channel_prompts SET consumed_at=COALESCE(consumed_at,?) WHERE channel=? AND room_id=? AND expires_at<=?',
      )
      .run(Date.now(), this.channel, room, Date.now());
  }
  async reconcilePrompts(room: string, questions: readonly string[], actions: readonly string[]): Promise<void> {
    await this.expirePrompts(room);
    const rows = await this.db
      .prepare(
        "SELECT token,target,kind FROM room_channel_prompts WHERE channel=? AND room_id=? AND consumed_at IS NULL AND kind<>'test'",
      )
      .all<{ token: string; target: string; kind: PhonePromptKind }>(this.channel, room);
    for (const row of rows)
      if (!(row.kind === 'question' ? questions : actions).includes(row.target)) {
        await this.db
          .prepare('UPDATE room_channel_prompts SET consumed_at=? WHERE channel=? AND token=?')
          .run(Date.now(), this.channel, row.token);
        await this.db
          .prepare(
            "UPDATE room_channel_deliveries SET state='dismissed' WHERE channel=? AND room_id=? AND state='pending' AND prompt_id=?",
          )
          .run(this.channel, room, row.token);
      }
  }
  async discardStale(room: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE room_channel_deliveries SET state='dismissed' WHERE channel=? AND room_id=? AND state='pending' AND work_id IN(SELECT w.id FROM room_wakeups w JOIN room_commitments c ON c.id=json_extract(w.cause_json,'$.trigger') AND c.room_id=w.room_id WHERE c.state<>'open' OR c.revision<>w.commitment_revision)`,
      )
      .run(this.channel, room);
  }
  async verified(room: string): Promise<void> {
    await this.db
      .prepare('UPDATE room_channel_links SET verified_at=? WHERE channel=? AND room_id=?')
      .run(Date.now(), this.channel, room);
  }
  async claimCommand(room: string, id: string): Promise<boolean> {
    return (
      Number(
        (
          await this.db
            .prepare(
              'INSERT INTO room_channel_commands(channel,room_id,provider_id) VALUES (?,?,?) ON CONFLICT DO NOTHING',
            )
            .run(this.channel, room, id)
        ).changes,
      ) === 1
    );
  }
  async counts(room: string): Promise<{ queued: number; needsReview: number }> {
    return (
      (await this.db
        .prepare(
          `SELECT(SELECT COUNT(*) FROM room_channel_inbox WHERE channel=? AND room_id=? AND state='pending') AS queued,(SELECT COUNT(*) FROM room_channel_inbox WHERE channel=? AND room_id=? AND state='review')+(SELECT COUNT(*) FROM room_channel_deliveries WHERE channel=? AND room_id=? AND state='review') AS needsReview`,
        )
        .get<{ queued: number; needsReview: number }>(this.channel, room, this.channel, room, this.channel, room)) ?? {
        queued: 0,
        needsReview: 0,
      }
    );
  }
  async review(room: string): Promise<(ReviewRoomPhone & { text: string })[]> {
    return this.db
      .prepare(
        "SELECT id,'input' AS direction,text FROM room_channel_inbox WHERE channel=? AND room_id=? AND state='review' UNION ALL SELECT seq AS id,'delivery' AS direction,text FROM room_channel_deliveries WHERE channel=? AND room_id=? AND state='review' LIMIT 20",
      )
      .all(this.channel, room, this.channel, room);
  }
  async dismiss(room: string, item: ReviewRoomPhone): Promise<void> {
    if (item.direction === 'input')
      await this.db
        .prepare("UPDATE room_channel_inbox SET state='done' WHERE channel=? AND room_id=? AND id=? AND state='review'")
        .run(this.channel, room, item.id);
    else
      await this.db
        .prepare(
          "UPDATE room_channel_deliveries SET state='dismissed' WHERE channel=? AND room_id=? AND seq=? AND state='review'",
        )
        .run(this.channel, room, item.id);
  }
}
function hash(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

export interface PhoneInput {
  id: number;
  text: string;
  provider_id: string;
  raw_json: string | null;
  files: PhoneAttachment[];
  work_id: string | null;
  source_key: string;
  quote_id: string | null;
  prepared_at: number | null;
}
export interface PhoneDelivery {
  seq: number;
  text: string;
  provider_id: string;
  tries: number;
  kind: PhoneDeliveryKind;
  work_id: string | null;
  quote_id: string | null;
  quote_text: string | null;
}
