import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  redact,
  RoomAssistantPolicySchema,
  type RoomAssistantPolicy,
  type RoomCommitment,
  type RoomCommitmentInput,
  type ChangeRoomCommitment,
  type RoomFolder,
  type RoomAssistantStatus,
} from '@pi-kit/protocol';
import { DatabaseService } from './database.service';

@Injectable()
export class RoomAssistantRepository {
  constructor(private readonly database: DatabaseService) {}
  private get db() {
    return this.database.db;
  }
  async roomsEnabled(): Promise<boolean> {
    const row = await this.db
      .prepare("SELECT value_json FROM settings WHERE key='collaboration.rooms'")
      .get<{ value_json: string }>();
    return row?.value_json === 'true';
  }
  async policy(roomId: string): Promise<RoomAssistantPolicy> {
    const row = await this.db
      .prepare('SELECT policy FROM room_assistant_policy WHERE room_id = ?')
      .get<{ policy: string }>(roomId);
    const legacy = await this.db
      .prepare('SELECT playbook FROM rooms WHERE id=?')
      .get<{ playbook: string | null }>(roomId);
    return row
      ? RoomAssistantPolicySchema.parse(JSON.parse(row.policy))
      : {
          enabled: !!legacy?.playbook,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          quietStart: '22:00',
          quietEnd: '08:00',
          dailyLimit: 10,
          dailyRunLimit: 20,
        };
  }
  async setPolicy(roomId: string, policy: RoomAssistantPolicy): Promise<void> {
    await this.db
      .prepare(
        'INSERT INTO room_assistant_policy(room_id,policy) VALUES (?,?) ON CONFLICT(room_id) DO UPDATE SET policy=excluded.policy',
      )
      .run(roomId, JSON.stringify(policy));
  }
  async commitments(roomId: string): Promise<RoomCommitment[]> {
    return (
      await this.db
        .prepare('SELECT * FROM room_commitments WHERE room_id = ? ORDER BY state, due_at')
        .all<CommitmentRow>(roomId)
    ).map(commitment);
  }
  async create(roomId: string, input: RoomCommitmentInput): Promise<RoomCommitment> {
    const id = randomUUID();
    await this.db
      .prepare(
        'INSERT INTO room_commitments(id,room_id,title,details,due_at,timezone,daily_at,source) VALUES (?,?,?,?,?,?,?,?)',
      )
      .run(
        id,
        roomId,
        redact(input.title) as string,
        redact(input.details) as string,
        input.dueAt,
        input.timezone,
        input.dailyAt,
        redact(input.source) as string,
      );
    const created = (await this.commitments(roomId)).find((item) => item.id === id);
    if (!created) throw new Error('The saved commitment is missing.');
    return created;
  }
  async change(roomId: string, id: string, change: ChangeRoomCommitment): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE room_commitments SET state=COALESCE(?,state),due_at=COALESCE(?,due_at),
      revision=revision+1,last_fired_at=CASE WHEN ? IS NOT NULL OR (?='open' AND state<>'open') THEN NULL ELSE last_fired_at END
      WHERE room_id=? AND id=?`,
      )
      .run(change.state ?? null, change.dueAt ?? null, change.dueAt ?? null, change.state ?? null, roomId, id);
    return Number(result.changes) === 1;
  }
  async commitment(roomId: string, id: string): Promise<{ item: RoomCommitment; revision: number } | undefined> {
    const row = await this.db
      .prepare('SELECT * FROM room_commitments WHERE room_id=? AND id=?')
      .get<CommitmentRow>(roomId, id);
    return row ? { item: commitment(row), revision: row.revision } : undefined;
  }
  async invalidateCommitment(roomId: string, id: string): Promise<void> {
    await this.db
      .prepare(
        "UPDATE room_wakeups SET state='done',updated_at=? WHERE room_id=? AND state='queued' AND json_extract(cause_json,'$.trigger')=?",
      )
      .run(Date.now(), roomId, id);
    await this.db
      .prepare(
        "UPDATE room_phone_deliveries SET state='dismissed' WHERE room_id=? AND state IN ('pending','sending') AND work_id IN (SELECT id FROM room_wakeups WHERE room_id=? AND json_extract(cause_json,'$.trigger')=?)",
      )
      .run(roomId, roomId, id);
  }
  async startedRuns(roomId: string, since: number): Promise<number[]> {
    return (
      await this.db
        .prepare(
          "SELECT started_at FROM room_wakeups WHERE room_id=? AND started_at>=? AND json_extract(cause_json,'$.kind') IN ('schedule','poll')",
        )
        .all<{ started_at: number }>(roomId, since)
    ).map((row) => row.started_at);
  }

  async due(now: number): Promise<{ roomId: string; item: RoomCommitment }[]> {
    return (
      await this.db
        .prepare(
          "SELECT c.* FROM room_commitments c JOIN rooms r ON r.id=c.room_id WHERE c.state='open' AND c.due_at<=? AND (c.last_fired_at IS NULL OR c.last_fired_at<c.due_at) AND r.archived_at IS NULL AND r.paused=0 ORDER BY c.due_at LIMIT 100",
        )
        .all<CommitmentRow>(now)
    ).map((row) => ({ roomId: row.room_id, item: commitment(row) }));
  }
  async fired(id: string, at: number, next: number | null): Promise<void> {
    await this.db
      .prepare('UPDATE room_commitments SET last_fired_at=?,due_at=COALESCE(?,due_at) WHERE id=?')
      .run(at, next, id);
  }
  async folders(roomId: string): Promise<RoomFolder[]> {
    return (
      await this.db
        .prepare('SELECT * FROM room_folders WHERE room_id=? ORDER BY alias')
        .all<{ id: string; alias: string; target: string; canonical: string; environment_id: string }>(roomId)
    ).map((row) => ({
      id: row.id,
      alias: row.alias,
      target: row.target,
      canonical: row.canonical,
      environmentId: row.environment_id,
      access: 'read',
      available: true,
      reason: null,
    }));
  }
  async addFolder(roomId: string, alias: string, target: string, canonical: string): Promise<void> {
    await this.db
      .prepare('INSERT INTO room_folders(id,room_id,alias,target,canonical,environment_id) VALUES (?,?,?,?,?,?)')
      .run(randomUUID(), roomId, alias, target, canonical, this.database.instanceId);
  }
  async removeFolder(roomId: string, id: string): Promise<void> {
    await this.db.prepare('DELETE FROM room_folders WHERE room_id=? AND id=?').run(roomId, id);
  }
  async threadRoom(threadId: string): Promise<string | undefined> {
    return (
      await this.db
        .prepare(
          'SELECT id FROM rooms WHERE lead_thread_id=? AND archived_at IS NULL UNION ALL SELECT c.room_id AS id FROM room_consult_threads c JOIN rooms r ON r.id=c.room_id WHERE c.thread_id=? AND r.archived_at IS NULL LIMIT 1',
        )
        .get<{ id: string }>(threadId, threadId)
    )?.id;
  }
  async threads(roomId: string): Promise<string[]> {
    return (
      await this.db
        .prepare(
          'SELECT lead_thread_id AS id FROM rooms WHERE id=? AND lead_thread_id IS NOT NULL UNION SELECT thread_id AS id FROM room_consult_threads WHERE room_id=?',
        )
        .all<{ id: string }>(roomId, roomId)
    ).map((row) => row.id);
  }
  async workspaceVersion(roomId: string): Promise<number> {
    return (
      (await this.db.prepare('SELECT workspace_version AS v FROM rooms WHERE id=?').get<{ v: number }>(roomId))?.v ?? 0
    );
  }
  async markWorkspace(roomId: string): Promise<void> {
    await this.db.prepare('UPDATE rooms SET workspace_version=1 WHERE id=?').run(roomId);
  }
  async moveThread(id: string, workspace: string): Promise<void> {
    await this.db
      .prepare('UPDATE threads SET project_cwd=?,worktree_path=NULL,branch=NULL,base_branch=NULL WHERE id=?')
      .run(workspace, id);
  }
  async work(roomId: string): Promise<RoomAssistantStatus['work']> {
    return this.db
      .prepare(
        "SELECT id,title,state,json_extract(cause_json,'$.kind') AS kind,created_at AS createdAt FROM room_wakeups WHERE room_id=? ORDER BY created_at DESC,rowid DESC LIMIT 100",
      )
      .all<RoomAssistantStatus['work'][number]>(roomId);
  }
  async retry(roomId: string, id: string): Promise<boolean> {
    const result = await this.db
      .prepare(
        "UPDATE room_wakeups SET state='queued', updated_at=? WHERE room_id=? AND id=? AND state IN ('review','failed') AND NOT EXISTS (SELECT 1 FROM room_commitments c WHERE c.room_id=room_wakeups.room_id AND c.id=json_extract(room_wakeups.cause_json,'$.trigger') AND (c.state<>'open' OR c.revision<>room_wakeups.commitment_revision))",
      )
      .run(Date.now(), roomId, id);
    return Number(result.changes) === 1;
  }
  async dismiss(roomId: string, id: string): Promise<void> {
    await this.db
      .prepare(
        "UPDATE room_wakeups SET state='done', updated_at=? WHERE room_id=? AND id=? AND state IN ('review','failed','queued')",
      )
      .run(Date.now(), roomId, id);
  }
}
interface CommitmentRow {
  id: string;
  room_id: string;
  title: string;
  details: string;
  due_at: number;
  timezone: string;
  daily_at: string | null;
  source: string;
  state: RoomCommitment['state'];
  last_fired_at: number | null;
  revision: number;
}
function commitment(row: CommitmentRow): RoomCommitment {
  return {
    id: row.id,
    title: row.title,
    details: row.details,
    dueAt: row.due_at,
    timezone: row.timezone,
    dailyAt: row.daily_at,
    source: row.source,
    state: row.state,
    lastFiredAt: row.last_fired_at,
  };
}
