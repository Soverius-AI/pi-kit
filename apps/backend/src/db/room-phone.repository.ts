import { Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { redact, type ReviewRoomPhone } from '@pi-kit/protocol';
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
  constructor(private readonly database: DatabaseService) {}
  private get db() {
    return this.database.db;
  }

  get(roomId: string): Promise<PhoneLinkRow | undefined> {
    return this.db.prepare('SELECT * FROM room_phone_links WHERE room_id = ?').get<PhoneLinkRow>(roomId);
  }

  async active(): Promise<PhoneLinkRow[]> {
    return this.db
      .prepare(
        'SELECT p.* FROM room_phone_links p JOIN rooms r ON r.id = p.room_id WHERE p.group_id IS NOT NULL AND r.archived_at IS NULL',
      )
      .all<PhoneLinkRow>();
  }

  async begin(roomId: string, code: string, expiresAt: number): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO room_phone_links(room_id, code_hash, expires_at) VALUES (?, ?, ?)
      ON CONFLICT(room_id) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at,
      candidate_group = NULL, candidate_sender = NULL, candidate_name = NULL`,
      )
      .run(roomId, hash(code), expiresAt);
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
        `UPDATE room_phone_links SET candidate_group = ?, candidate_sender = ?, candidate_name = ?, candidate_group_name = ?
      WHERE code_hash = ? AND expires_at > ? AND group_id IS NULL AND candidate_group IS NULL`,
      )
      .run(group, sender, name.slice(0, 200), groupName.slice(0, 200), hash(code), now);
    return Number(result.changes) === 1;
  }

  async confirm(roomId: string, group: string, sender: string, account: string, now: number): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE room_phone_links SET group_id = candidate_group, sender_id = candidate_sender,
      sender_name = candidate_name, group_name = candidate_group_name, account_id = ?, binding_id=lower(hex(randomblob(16))), code_hash = NULL, expires_at = NULL, candidate_group = NULL, candidate_sender = NULL,
      candidate_name = NULL, after_seq = (SELECT COALESCE(MAX(seq), 0) FROM room_events WHERE room_id = ?)
      WHERE room_id = ? AND group_id IS NULL AND candidate_group = ? AND candidate_sender = ? AND expires_at > ?
      AND NOT EXISTS (SELECT 1 FROM room_phone_links WHERE group_id = ?)`,
      )
      .run(account, roomId, roomId, group, sender, now, group);
    return Number(result.changes) === 1;
  }

  async unlink(roomId: string): Promise<void> {
    // Foreign key enforcement is not assumed on legacy connections.
    await this.db.transaction(async () => {
      await this.db.prepare('DELETE FROM room_phone_inbox WHERE room_id = ?').run(roomId);
      await this.db.prepare('DELETE FROM room_phone_deliveries WHERE room_id = ?').run(roomId);
      await this.db.prepare('DELETE FROM room_phone_prompts WHERE room_id = ?').run(roomId);
      await this.db.prepare('DELETE FROM room_phone_commands WHERE room_id = ?').run(roomId);
      await this.db.prepare('DELETE FROM room_phone_links WHERE room_id = ?').run(roomId);
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
    await this.db
      .prepare(
        `INSERT INTO room_phone_inbox(room_id, provider_id, text, created_at, raw_json, files_json, quote_id, source_key)
      SELECT p.room_id, ?, ?, ?, ?, ?, ?, 'phone:'||p.account_id||':'||p.group_id||':'||? FROM room_phone_links p JOIN rooms r ON r.id = p.room_id
      WHERE p.group_id = ? AND p.sender_id = ? AND p.account_id = ? AND r.archived_at IS NULL
      ON CONFLICT(room_id, provider_id) DO NOTHING`,
      )
      .run(
        id,
        redact(text) as string,
        now,
        extra?.raw ?? null,
        JSON.stringify(files),
        extra?.quoteId ?? null,
        id,
        group,
        sender,
        account,
      );
  }

  async authorized(group: string, sender: string, account: string): Promise<PhoneLinkRow | undefined> {
    return this.db
      .prepare(
        'SELECT p.* FROM room_phone_links p JOIN rooms r ON r.id=p.room_id WHERE p.group_id=? AND p.sender_id=? AND p.account_id=? AND r.archived_at IS NULL',
      )
      .get<PhoneLinkRow>(group, sender, account);
  }
  async isOutgoing(group: string, account: string, id: string): Promise<boolean> {
    return !!(await this.db
      .prepare('SELECT 1 FROM room_phone_outgoing WHERE account_id=? AND group_id=? AND provider_id=?')
      .get(account, group, id));
  }
  async recordOutgoing(group: string, account: string, id: string): Promise<void> {
    await this.db
      .prepare(
        'INSERT INTO room_phone_outgoing(account_id,group_id,provider_id,created_at) VALUES (?,?,?,?) ON CONFLICT DO NOTHING',
      )
      .run(account, group, id, Date.now());
  }
  async valid(binding: PhoneLinkRow): Promise<boolean> {
    return !!(await this.db
      .prepare(
        'SELECT 1 FROM room_phone_links p JOIN rooms r ON r.id=p.room_id WHERE p.room_id=? AND p.binding_id=? AND r.archived_at IS NULL',
      )
      .get(binding.room_id, binding.binding_id));
  }
  async pending(roomId: string): Promise<PhoneInput | undefined> {
    const row = await this.db
      .prepare("SELECT * FROM room_phone_inbox WHERE room_id=? AND state='pending' ORDER BY id LIMIT 1")
      .get<PhoneInput & { files_json: string }>(roomId);
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
      .prepare('UPDATE room_phone_inbox SET text=?,files_json=?,raw_json=NULL,prepared_at=? WHERE id=?')
      .run(redact(text) as string, JSON.stringify(PhoneAttachmentsSchema.parse(files)), Date.now(), id);
  }
  async inputState(id: number, state: 'pending' | 'dispatching' | 'accepted' | 'review'): Promise<void> {
    await this.db.prepare('UPDATE room_phone_inbox SET state=? WHERE id=?').run(state, id);
  }
  async syncInputs(roomId?: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE room_phone_inbox SET work_id=COALESCE(work_id,(SELECT w.id FROM room_wakeups w WHERE w.room_id=room_phone_inbox.room_id AND w.source_key=room_phone_inbox.source_key)) WHERE (? IS NULL OR room_id=?)`,
      )
      .run(roomId ?? null, roomId ?? null);
    await this.db
      .prepare(
        `UPDATE room_phone_inbox SET state=CASE (SELECT state FROM room_wakeups WHERE id=work_id) WHEN 'done' THEN 'done' WHEN 'failed' THEN 'review' WHEN 'review' THEN 'review' ELSE 'accepted' END WHERE work_id IS NOT NULL AND state IN ('pending','dispatching','accepted','review') AND (? IS NULL OR room_id=?)`,
      )
      .run(roomId ?? null, roomId ?? null);
  }

  async releaseClaims(roomId?: string): Promise<void> {
    await this.syncInputs(roomId);
    await this.db
      .prepare("UPDATE room_phone_inbox SET state='pending' WHERE state='dispatching' AND (? IS NULL OR room_id=?)")
      .run(roomId ?? null, roomId ?? null);
    await this.db
      .prepare(
        "UPDATE room_phone_deliveries SET state=CASE WHEN tries<3 THEN 'pending' ELSE 'review' END,next_at=? WHERE state='sending' AND (? IS NULL OR room_id=?)",
      )
      .run(Date.now() + 5000, roomId ?? null, roomId ?? null);
  }
  async capture(roomId: string): Promise<void> {
    await this.db.transaction(async () => {
      await this.db
        .prepare(
          `INSERT INTO room_phone_deliveries(room_id,seq,text,provider_id,kind,work_id,quote_id,quote_text)
        SELECT e.room_id,e.seq,e.text,'3EB0'||upper(hex(randomblob(9))),
          CASE WHEN json_extract(w.cause_json,'$.kind') IN ('schedule','poll') THEN 'proactive' ELSE 'reply' END,
          e.work_id,i.provider_id,i.text
        FROM room_events e JOIN room_phone_links p ON p.room_id=e.room_id
        LEFT JOIN room_wakeups w ON w.id=e.work_id
        LEFT JOIN room_commitments c ON c.id=json_extract(w.cause_json,'$.trigger') AND c.room_id=e.room_id
        LEFT JOIN room_phone_inbox i ON i.room_id=e.room_id AND i.event_seq=w.owner_seq
        WHERE e.room_id=? AND e.seq>p.after_seq AND e.actor='lead' AND e.kind='message'
          AND NOT (trim(e.text)='[NO_UPDATE]' AND COALESCE(json_extract(w.cause_json,'$.kind'),'owner') IN ('schedule','poll'))
          AND (c.id IS NULL OR (c.state='open' AND c.revision=w.commitment_revision))
        ON CONFLICT(room_id,seq) DO NOTHING`,
        )
        .run(roomId);
      await this.db
        .prepare(
          'UPDATE room_phone_links SET after_seq=(SELECT COALESCE(MAX(seq),0) FROM room_events WHERE room_id=?) WHERE room_id=?',
        )
        .run(roomId, roomId);
    })();
  }
  async delivery(
    roomId: string,
    proactive = true,
    now = Date.now(),
    paused = false,
  ): Promise<PhoneDelivery | undefined> {
    const row = await this.db
      .prepare(
        "SELECT * FROM room_phone_deliveries WHERE room_id=? AND state='pending' AND next_at<=? AND (kind<>'proactive' OR ?) AND (?=0 OR kind IN ('status','test')) ORDER BY CASE WHEN kind='proactive' THEN 1 ELSE 0 END,seq LIMIT 1",
      )
      .get<PhoneDelivery>(roomId, now, proactive ? 1 : 0, paused ? 1 : 0);
    return row ? { ...row, kind: PhoneDeliveryKindSchema.parse(row.kind) } : undefined;
  }
  async canSend(roomId: string, seq: number): Promise<boolean> {
    const valid = !!(await this.db
      .prepare(
        `SELECT 1 FROM room_phone_deliveries d
      LEFT JOIN room_phone_prompts p ON p.token=d.prompt_id
      LEFT JOIN room_wakeups w ON w.id=d.work_id
      LEFT JOIN room_commitments c ON c.room_id=d.room_id AND c.id=json_extract(w.cause_json,'$.trigger')
      WHERE d.room_id=? AND d.seq=? AND d.state='sending'
      AND (d.prompt_id IS NULL OR (p.expires_at>? AND p.consumed_at IS NULL))
      AND (c.id IS NULL OR (c.state='open' AND c.revision=w.commitment_revision))`,
      )
      .get(roomId, seq, Date.now()));
    if (!valid)
      await this.db
        .prepare("UPDATE room_phone_deliveries SET state='dismissed' WHERE room_id=? AND seq=? AND state='sending'")
        .run(roomId, seq);
    return valid;
  }
  async deliveryState(
    roomId: string,
    seq: number,
    state: 'sending' | 'sent' | 'review',
    providerId: string | null = null,
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE room_phone_deliveries SET state=?,provider_id=COALESCE(?,provider_id),
      tries=tries+CASE WHEN ?='sending' THEN 1 ELSE 0 END,sent_at=CASE WHEN ?='sent' THEN COALESCE(sent_at,?) ELSE sent_at END
      WHERE room_id=? AND seq=? AND state NOT IN ('dismissed','sent')`,
      )
      .run(state, providerId, state, state, Date.now(), roomId, seq);
  }
  async later(roomId: string, seq: number, nextAt: number, review: boolean): Promise<void> {
    await this.db
      .prepare(
        "UPDATE room_phone_deliveries SET state=?,next_at=? WHERE room_id=? AND seq=? AND state NOT IN ('sent','dismissed')",
      )
      .run(review ? 'review' : 'pending', nextAt, roomId, seq);
  }
  async recover(): Promise<void> {
    // Canonical room wakeups deduplicate replay of a dispatch interrupted around acceptance.
    await this.db.prepare("UPDATE room_phone_inbox SET state='pending' WHERE state='dispatching'").run();
    await this.syncInputs();
    await this.db
      .prepare(
        "UPDATE room_phone_deliveries SET state=CASE WHEN tries<3 THEN 'pending' ELSE 'review' END WHERE state='sending'",
      )
      .run();
  }
  async accepted(id: number, workId: string, seq: number | null): Promise<void> {
    await this.db
      .prepare("UPDATE room_phone_inbox SET work_id=?,event_seq=?,state='accepted' WHERE id=?")
      .run(workId, seq, id);
  }
  async receipt(id: string, status: number, group: string, account?: string): Promise<void> {
    if (status < 2) return;
    await this.db
      .prepare(
        `UPDATE room_phone_deliveries SET state='sent',sent_at=COALESCE(sent_at,?),
      delivered_at=CASE WHEN ?>=3 THEN COALESCE(delivered_at,?) ELSE delivered_at END,
      read_at=CASE WHEN ?>=4 THEN COALESCE(read_at,?) ELSE read_at END
      WHERE provider_id=? AND state<>'dismissed' AND room_id IN (SELECT room_id FROM room_phone_links WHERE group_id=? AND (? IS NULL OR account_id=?))`,
      )
      .run(Date.now(), status, Date.now(), status, Date.now(), id, group, account ?? null, account ?? null);
  }
  async health(roomId: string) {
    const pending = await this.db
      .prepare("SELECT COUNT(*) AS n FROM room_phone_deliveries WHERE room_id=? AND state IN ('pending','sending')")
      .get<{ n: number }>(roomId);
    const last = await this.db
      .prepare(
        'SELECT sent_at AS sentAt,delivered_at AS deliveredAt,read_at AS readAt FROM room_phone_deliveries WHERE room_id=? ORDER BY seq DESC LIMIT 1',
      )
      .get<{ sentAt: number | null; deliveredAt: number | null; readAt: number | null }>(roomId);
    return { pendingDeliveries: pending?.n ?? 0, lastDelivery: last ?? null };
  }
  async sent(roomId: string, since: number): Promise<number[]> {
    return (
      await this.db
        .prepare("SELECT sent_at FROM room_phone_deliveries WHERE room_id=? AND kind='proactive' AND sent_at>=?")
        .all<{ sent_at: number }>(roomId, since)
    ).map((row) => row.sent_at);
  }
  async duplicate(roomId: string, text: string): Promise<boolean> {
    return !!(await this.db
      .prepare(
        "SELECT 1 FROM room_phone_deliveries WHERE room_id=? AND text=? AND state='sent' AND kind='proactive' AND sent_at>? LIMIT 1",
      )
      .get(roomId, text, Date.now() - 86400000));
  }
  async quoted(roomId: string, id: string): Promise<{ text: string; work_id: string | null } | undefined> {
    return this.db
      .prepare('SELECT text,work_id FROM room_phone_deliveries WHERE room_id=? AND provider_id=?')
      .get<{ text: string; work_id: string | null }>(roomId, id);
  }
  async config(roomId: string, url: string): Promise<void> {
    await this.db.prepare('UPDATE room_phone_links SET app_url=? WHERE room_id=?').run(url || null, roomId);
  }
  async notify(
    roomId: string,
    text: string,
    kind: PhoneDeliveryKind = 'status',
    promptId: string | null = null,
  ): Promise<void> {
    await this.db.transaction(async () => {
      const row = await this.db
        .prepare('SELECT COALESCE(MAX(seq),0)+1 AS seq FROM room_events WHERE room_id=?')
        .get<{ seq: number }>(roomId);
      if (!row) throw new Error('No room.');
      await this.db
        .prepare(
          "INSERT INTO room_events(room_id,seq,kind,actor,text,created_at) VALUES (?,?,'note','coordinator',?,?)",
        )
        .run(roomId, row.seq, redact(text) as string, Date.now());
      await this.db
        .prepare('INSERT INTO room_phone_deliveries(room_id,seq,text,kind,provider_id,prompt_id) VALUES (?,?,?,?,?,?)')
        .run(
          roomId,
          row.seq,
          redact(text) as string,
          kind,
          '3EB0' + randomBytes(9).toString('hex').toUpperCase(),
          promptId,
        );
    })();
  }
  async prompt(
    roomId: string,
    target: string,
    kind: PhonePromptKind,
    draft: PhonePromptDraft,
  ): Promise<string | undefined> {
    return this.db.transaction(async () => {
      const inserted = await this.db
        .prepare(
          'INSERT INTO room_phone_prompts(token,room_id,target,kind,expires_at,consumed_at) VALUES (?,?,?,?,?,?) ON CONFLICT(room_id,target,kind) DO NOTHING',
        )
        .run(draft.token, roomId, target, kind, draft.expiresAt, draft.consumed ? Date.now() : null);
      if (!Number(inserted.changes)) return;
      await this.notify(roomId, draft.text, kind, draft.consumed ? null : draft.token);
      return draft.consumed ? undefined : draft.token;
    })();
  }

  async takePrompt(roomId: string, token: string): Promise<{ target: string; kind: PhonePromptKind } | undefined> {
    return this.db.transaction(async () => {
      const row = await this.db
        .prepare(
          'SELECT target,kind FROM room_phone_prompts WHERE room_id=? AND token=? AND consumed_at IS NULL AND expires_at>?',
        )
        .get<{ target: string; kind: PhonePromptKind }>(roomId, token, Date.now());
      if (!row) return;
      await this.db.prepare('UPDATE room_phone_prompts SET consumed_at=? WHERE token=?').run(Date.now(), token);
      return row;
    })();
  }
  async peekPrompt(roomId: string, token: string): Promise<{ target: string; kind: PhonePromptKind } | undefined> {
    return this.db
      .prepare(
        'SELECT target,kind FROM room_phone_prompts WHERE room_id=? AND token=? AND consumed_at IS NULL AND expires_at>?',
      )
      .get<{ target: string; kind: PhonePromptKind }>(roomId, token, Date.now());
  }
  async clearExpired(roomId: string): Promise<void> {
    await this.expirePrompts(roomId);
    await this.db.prepare('DELETE FROM room_phone_prompts WHERE room_id=? AND expires_at<=?').run(roomId, Date.now());
  }
  private async expirePrompts(roomId: string): Promise<void> {
    await this.db
      .prepare(
        "UPDATE room_phone_deliveries SET state='dismissed' WHERE room_id=? AND state='pending' AND EXISTS(SELECT 1 FROM room_phone_prompts p WHERE p.room_id=? AND p.expires_at<=? AND room_phone_deliveries.prompt_id=p.token)",
      )
      .run(roomId, roomId, Date.now());
    await this.db
      .prepare('UPDATE room_phone_prompts SET consumed_at=COALESCE(consumed_at,?) WHERE room_id=? AND expires_at<=?')
      .run(Date.now(), roomId, Date.now());
  }
  async reconcilePrompts(roomId: string, questions: readonly string[], actions: readonly string[]): Promise<void> {
    await this.expirePrompts(roomId);
    const prompts = await this.db
      .prepare(
        "SELECT token,target,kind FROM room_phone_prompts WHERE room_id=? AND consumed_at IS NULL AND kind<>'test'",
      )
      .all<{ token: string; target: string; kind: string }>(roomId);
    for (const prompt of prompts)
      if (!(prompt.kind === 'question' ? questions : actions).includes(prompt.target)) {
        await this.db
          .prepare('UPDATE room_phone_prompts SET consumed_at=? WHERE token=?')
          .run(Date.now(), prompt.token);
        await this.db
          .prepare(
            "UPDATE room_phone_deliveries SET state='dismissed' WHERE room_id=? AND state='pending' AND prompt_id=?",
          )
          .run(roomId, prompt.token);
      }
  }
  async discardStale(roomId: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE room_phone_deliveries SET state='dismissed' WHERE room_id=? AND state='pending'
      AND work_id IN (SELECT w.id FROM room_wakeups w JOIN room_commitments c ON c.id=json_extract(w.cause_json,'$.trigger') AND c.room_id=w.room_id
      WHERE c.state<>'open' OR c.revision<>w.commitment_revision)`,
      )
      .run(roomId);
  }
  async verified(roomId: string): Promise<void> {
    await this.db.prepare('UPDATE room_phone_links SET verified_at=? WHERE room_id=?').run(Date.now(), roomId);
  }
  async claimCommand(roomId: string, providerId: string): Promise<boolean> {
    return (
      Number(
        (
          await this.db
            .prepare('INSERT INTO room_phone_commands(room_id,provider_id) VALUES (?,?) ON CONFLICT DO NOTHING')
            .run(roomId, providerId)
        ).changes,
      ) === 1
    );
  }

  async counts(roomId: string): Promise<{ queued: number; needsReview: number }> {
    const row = await this.db
      .prepare(
        `SELECT
      (SELECT COUNT(*) FROM room_phone_inbox WHERE room_id = ? AND state = 'pending') AS queued,
      (SELECT COUNT(*) FROM room_phone_inbox WHERE room_id = ? AND state = 'review') +
      (SELECT COUNT(*) FROM room_phone_deliveries WHERE room_id = ? AND state = 'review') AS needsReview`,
      )
      .get<{ queued: number; needsReview: number }>(roomId, roomId, roomId);
    return row ?? { queued: 0, needsReview: 0 };
  }

  async review(roomId: string): Promise<(ReviewRoomPhone & { text: string })[]> {
    return this.db
      .prepare(
        `SELECT id, 'input' AS direction, text FROM room_phone_inbox WHERE room_id = ? AND state = 'review'
      UNION ALL SELECT seq AS id, 'delivery' AS direction, text FROM room_phone_deliveries WHERE room_id = ? AND state = 'review' LIMIT 20`,
      )
      .all<ReviewRoomPhone & { text: string }>(roomId, roomId);
  }

  async dismiss(roomId: string, item: ReviewRoomPhone): Promise<void> {
    if (item.direction === 'input')
      await this.db
        .prepare("UPDATE room_phone_inbox SET state = 'done' WHERE room_id = ? AND id = ? AND state = 'review'")
        .run(roomId, item.id);
    else
      await this.db
        .prepare(
          "UPDATE room_phone_deliveries SET state = 'dismissed' WHERE room_id = ? AND seq = ? AND state = 'review'",
        )
        .run(roomId, item.id);
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
