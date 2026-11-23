import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { RoomImage, RoomRun } from '@pi-kit/protocol';
import {
  type McpAppActivity,
  redact,
  redactValue,
  RoomSchema,
  type Room,
  type RoomDirectoryEntry,
  type RoomEvent,
  type RoomTask,
} from '@pi-kit/protocol';
import { DatabaseService } from './database.service';
import { defaultRoomAssistantPolicy } from './room-assistant-policy';

interface RoomRow {
  id: string;
  title: string;
  repository: string;
  base_commit: string;
  created_at: number;
  waiting?: number;
}

export interface NewRoom {
  id: string;
  title: string;
  repository: string;
  baseCommit: string;
  summary: string;
  sourceThreadId: string | null;
  projectFolder: string | null;
  playbook?: string | null;
  stage?: string | null;
  createdAt: number;
}

interface TaskRow {
  id: string;
  room_id: string;
  title: string;
  brief: string;
  acceptance: string;
  state: RoomTask['state'];
  environment_id: string;
  attempt: number;
  bundle_path: string | null;
  a2a_token: string | null;
  a2a_task_id: string | null;
  base: string;
  worker_thread_id: string | null;
  branch: string | null;
  head: string | null;
  report: string | null;
  files_json: string;
  questions_json: string;
  review: RoomTask['review'];
  review_rounds: number;
  lead_answers: number;
  feedback: string | null;
  created_at: number;
  updated_at: number;
}

export interface WorkerTaskRow {
  taskId: string;
  roomId: string;
  hostInstanceId: string;
  attempt: number;
  workerThreadId: string | null;
  folder: string;
  state: 'running' | 'submitted' | 'failed' | 'stopped';
  pushUrl: string | null;
  pushToken: string | null;
  a2aTaskId: string | null;
}

interface RawWorkerTask {
  task_id: string;
  room_id: string;
  host_instance_id: string;
  attempt: number;
  worker_thread_id: string | null;
  folder: string;
  state: WorkerTaskRow['state'];
  push_url: string | null;
  push_token: string | null;
  a2a_task_id: string | null;
}

export interface OutboxRow {
  id: number;
  taskId: string;
  hostInstanceId: string;
  path: string;
  body: unknown;
  token: string | null;
  tries: number;
  nextAt: number;
  createdAt: number;
}

const WAITING =
  "(SELECT COUNT(*) FROM room_tasks t WHERE t.room_id = rooms.id AND (t.state IN ('proposed', 'submitted') OR (t.state = 'running' AND t.questions_json <> '[]'))) + (rooms.lead_questions_json <> '[]') AS waiting";

@Injectable()
export class RoomsRepository {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  private toRoom(row: RoomRow): Room {
    return {
      id: row.id,
      title: row.title,
      repository: row.repository,
      hostInstanceId: this.database.instanceId,
      baseCommit: row.base_commit,
      waiting: Number(row.waiting ?? 0),
      createdAt: row.created_at,
    };
  }

  async insert(room: NewRoom): Promise<Room> {
    const row: RoomRow = {
      id: room.id,
      title: redact(room.title) as string,
      repository: room.repository,
      base_commit: room.baseCommit,
      created_at: room.createdAt,
    };
    await this.db.transaction(async () => {
      await this.db
        .prepare(
          'INSERT INTO rooms (id, title, repository, base_commit, summary, source_thread_id, project_folder, playbook, stage, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          row.id,
          row.title,
          row.repository,
          row.base_commit,
          redact(room.summary) as string,
          room.sourceThreadId,
          room.projectFolder,
          room.playbook ?? null,
          room.stage ?? null,
          row.created_at,
        );
      await this.db
        .prepare('INSERT INTO room_assistant_policy(room_id,policy) VALUES (?,?)')
        .run(room.id, JSON.stringify(defaultRoomAssistantPolicy()));
    })();
    return this.toRoom(row);
  }

  async get(id: string): Promise<
    | {
        room: Room;
        summary: string;
        leadThreadId: string | null;
        sourceThreadId: string | null;
        projectFolder: string | null;
        leadQuestions: RoomTask['questions'];
        mode: 'supervised' | 'assisted';
        paused: boolean;
        rehearsal: boolean;
        agentTurns: number;
        playbook: string | null;
        stage: string | null;
      }
    | undefined
  > {
    const row = (await this.db
      .prepare(
        `SELECT id, title, repository, base_commit, created_at, summary, lead_thread_id, source_thread_id, project_folder, lead_questions_json, mode, paused, rehearsal, agent_turns, playbook, stage, ${WAITING} FROM rooms WHERE id = ? AND archived_at IS NULL`,
      )
      .get(id)) as
      | (RoomRow & {
          summary: string;
          lead_thread_id: string | null;
          source_thread_id: string | null;
          project_folder: string | null;
          lead_questions_json: string;
          mode: 'supervised' | 'assisted';
          paused: number;
          rehearsal: number;
          agent_turns: number;
          playbook: string | null;
          stage: string | null;
        })
      | undefined;
    return row
      ? {
          room: this.toRoom(row),
          summary: row.summary,
          leadThreadId: row.lead_thread_id,
          sourceThreadId: row.source_thread_id,
          projectFolder: row.project_folder,
          leadQuestions: JSON.parse(row.lead_questions_json) as RoomTask['questions'],
          mode: row.mode ?? 'supervised',
          paused: !!Number(row.paused ?? 0),
          rehearsal: !!Number(row.rehearsal ?? 0),
          agentTurns: Number(row.agent_turns ?? 0),
          playbook: row.playbook ?? null,
          stage: row.stage ?? null,
        }
      : undefined;
  }

  async setTitle(id: string, title: string): Promise<void> {
    await this.db.prepare('UPDATE rooms SET title = ? WHERE id = ?').run(redact(title) as string, id);
  }

  async archive(id: string, at: number): Promise<void> {
    await this.db.prepare('UPDATE rooms SET archived_at = ? WHERE id = ? AND archived_at IS NULL').run(at, id);
  }

  async setMode(id: string, mode: 'supervised' | 'assisted'): Promise<void> {
    await this.db.prepare('UPDATE rooms SET mode = ? WHERE id = ?').run(mode, id);
  }

  async setPlaybook(id: string, playbook: string | null, stage: string | null): Promise<void> {
    await this.db.prepare('UPDATE rooms SET playbook = ?, stage = ? WHERE id = ?').run(playbook, stage, id);
  }

  async setStage(id: string, stage: string | null): Promise<void> {
    await this.db.prepare('UPDATE rooms SET stage = ? WHERE id = ?').run(stage, id);
  }

  async playbookRooms(): Promise<string[]> {
    const rows = (await this.db
      .prepare('SELECT id FROM rooms WHERE playbook IS NOT NULL AND archived_at IS NULL AND paused = 0')
      .all()) as { id: string }[];
    return rows.map((row) => row.id);
  }

  async setPaused(id: string, paused: boolean): Promise<void> {
    await this.db.prepare('UPDATE rooms SET paused = ? WHERE id = ?').run(paused ? 1 : 0, id);
  }

  async setRehearsal(id: string, rehearsal: boolean): Promise<void> {
    await this.db.prepare('UPDATE rooms SET rehearsal = ? WHERE id = ?').run(rehearsal ? 1 : 0, id);
  }

  async setAgentTurns(id: string, turns: number): Promise<void> {
    await this.db.prepare('UPDATE rooms SET agent_turns = ? WHERE id = ?').run(turns, id);
  }

  async setLeadQuestions(id: string, questions: RoomTask['questions']): Promise<void> {
    await this.db.prepare('UPDATE rooms SET lead_questions_json = ? WHERE id = ?').run(JSON.stringify(questions), id);
  }

  async clearLeadQuestions(): Promise<void> {
    await this.db.prepare("UPDATE rooms SET lead_questions_json = '[]' WHERE lead_questions_json <> '[]'").run();
  }

  async setLead(id: string, threadId: string): Promise<void> {
    await this.db.prepare('UPDATE rooms SET lead_thread_id = ? WHERE id = ?').run(threadId, id);
  }

  async roomOfLead(threadId: string): Promise<string | undefined> {
    const row = (await this.db
      .prepare('SELECT id FROM rooms WHERE lead_thread_id = ? AND archived_at IS NULL')
      .get(threadId)) as { id: string } | undefined;
    return row?.id;
  }

  async isLead(threadId: string): Promise<boolean> {
    return !!(await this.db.prepare('SELECT 1 FROM rooms WHERE lead_thread_id = ?').get(threadId));
  }

  append(
    roomId: string,
    event: Pick<RoomEvent, 'kind' | 'actor' | 'text'> & {
      images?: number;
      taskId?: string | null;
      environmentId?: string | null;
      role?: string | null;
      app?: McpAppActivity | null;
      workId?: string | null;
    },
    createdAt = Date.now(),
  ): Promise<RoomEvent> {
    const text = redact(event.text) as string;
    const app = event.app ? redactValue(event.app) : null;
    return this.db.transaction(async () => {
      const last = (await this.db
        .prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM room_events WHERE room_id = ?')
        .get(roomId)) as { seq: number };
      const seq = Number(last.seq) + 1;
      await this.db
        .prepare(
          'INSERT INTO room_events (room_id, seq, kind, actor, text, images, task_id, environment_id, role, app, created_at, work_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          roomId,
          seq,
          event.kind,
          event.actor,
          text,
          event.images ?? 0,
          event.taskId ?? null,
          event.environmentId ?? null,
          event.role ?? null,
          app ? JSON.stringify(app) : null,
          createdAt,
          event.workId ?? null,
        );
      return {
        roomId,
        seq,
        kind: event.kind,
        actor: event.actor,
        text,
        images: event.images ?? 0,
        taskId: event.taskId ?? null,
        environmentId: event.environmentId ?? null,
        role: event.role ?? null,
        ...(app ? { app } : {}),
        createdAt,
        ...(event.workId ? { workId: event.workId } : {}),
      };
    })();
  }

  async events(roomId: string, afterSeq = 0): Promise<RoomEvent[]> {
    const rows = (await this.db
      .prepare(
        'SELECT room_id, seq, kind, actor, text, images, task_id, environment_id, role, app, created_at, work_id FROM room_events WHERE room_id = ? AND seq > ? ORDER BY seq',
      )
      .all(roomId, afterSeq)) as {
      room_id: string;
      work_id: string | null;
      seq: number;
      kind: RoomEvent['kind'];
      actor: RoomEvent['actor'];
      text: string;
      images: number;
      task_id: string | null;
      environment_id: string | null;
      role: string | null;
      app: string | null;
      created_at: number;
    }[];
    return rows.map((row) => ({
      roomId: row.room_id,
      ...(row.work_id ? { workId: row.work_id } : {}),
      seq: Number(row.seq),
      kind: row.kind,
      actor: row.actor,
      text: row.text,
      images: Number(row.images),
      taskId: row.task_id,
      environmentId: row.environment_id,
      role: row.role,
      ...(row.app ? { app: JSON.parse(row.app) as McpAppActivity } : {}),
      createdAt: row.created_at,
    }));
  }

  async active(): Promise<Room[]> {
    const rows = (await this.db
      .prepare(
        `SELECT id, title, repository, base_commit, created_at, ${WAITING} FROM rooms WHERE archived_at IS NULL ORDER BY created_at DESC`,
      )
      .all()) as RoomRow[];
    return rows.map((row) => this.toRoom(row));
  }

  async insertTask(
    task: Omit<RoomTask, 'branch' | 'head' | 'report' | 'files' | 'attempt' | 'questions' | 'review' | 'reviewRounds'>,
  ): Promise<RoomTask> {
    await this.db
      .prepare(
        'INSERT INTO room_tasks (id, room_id, title, brief, acceptance, state, environment_id, base, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        task.id,
        task.roomId,
        redact(task.title) as string,
        redact(task.brief) as string,
        redact(task.acceptance) as string,
        task.state,
        task.environmentId,
        task.base,
        task.createdAt,
        task.updatedAt,
      );
    return (await this.task(task.id)) as RoomTask;
  }

  async task(id: string): Promise<
    | (RoomTask & {
        workerThreadId: string | null;
        bundlePath: string | null;
        a2aToken: string | null;
        a2aTaskId: string | null;
        leadAnswers: number;
        feedback: string | null;
      })
    | undefined
  > {
    const row = (await this.db.prepare('SELECT * FROM room_tasks WHERE id = ?').get(id)) as TaskRow | undefined;
    return row
      ? {
          ...this.toTask(row),
          workerThreadId: row.worker_thread_id,
          bundlePath: row.bundle_path,
          a2aToken: row.a2a_token,
          a2aTaskId: row.a2a_task_id,
          leadAnswers: Number(row.lead_answers ?? 0),
          feedback: row.feedback,
        }
      : undefined;
  }

  async runningTaskIds(): Promise<string[]> {
    const rows = (await this.db.prepare("SELECT id FROM room_tasks WHERE state = 'running'").all()) as { id: string }[];
    return rows.map((row) => row.id);
  }

  async tasks(roomId: string): Promise<RoomTask[]> {
    const rows = (await this.db
      .prepare('SELECT * FROM room_tasks WHERE room_id = ? ORDER BY created_at')
      .all(roomId)) as TaskRow[];
    return rows.map((row) => this.toTask(row));
  }

  async updateTask(
    id: string,
    patch: Partial<
      Pick<RoomTask, 'state' | 'branch' | 'head' | 'report' | 'files' | 'environmentId' | 'attempt' | 'questions'>
    > & {
      workerThreadId?: string | null;
      bundlePath?: string | null;
      a2aToken?: string | null;
      a2aTaskId?: string | null;
      review?: RoomTask['review'];
      reviewRounds?: number;
      leadAnswers?: number;
      feedback?: string | null;
    },
    updatedAt = Date.now(),
  ): Promise<void> {
    const columns: [string, unknown][] = [['updated_at', updatedAt]];
    if (patch.state !== undefined) columns.push(['state', patch.state]);
    if (patch.branch !== undefined) columns.push(['branch', patch.branch]);
    if (patch.head !== undefined) columns.push(['head', patch.head]);
    if (patch.report !== undefined)
      columns.push(['report', patch.report === null ? null : (redact(patch.report) as string)]);
    if (patch.files !== undefined) columns.push(['files_json', JSON.stringify(patch.files)]);
    if (patch.questions !== undefined) columns.push(['questions_json', JSON.stringify(patch.questions)]);
    if (patch.workerThreadId !== undefined) columns.push(['worker_thread_id', patch.workerThreadId]);
    if (patch.bundlePath !== undefined) columns.push(['bundle_path', patch.bundlePath]);
    if (patch.a2aToken !== undefined) columns.push(['a2a_token', patch.a2aToken]);
    if (patch.a2aTaskId !== undefined) columns.push(['a2a_task_id', patch.a2aTaskId]);
    if (patch.review !== undefined) columns.push(['review', patch.review]);
    if (patch.reviewRounds !== undefined) columns.push(['review_rounds', patch.reviewRounds]);
    if (patch.leadAnswers !== undefined) columns.push(['lead_answers', patch.leadAnswers]);
    if (patch.feedback !== undefined) columns.push(['feedback', patch.feedback]);
    if (patch.environmentId !== undefined) columns.push(['environment_id', patch.environmentId]);
    if (patch.attempt !== undefined) columns.push(['attempt', patch.attempt]);
    const sets = columns.map(([column]) => `${column} = ?`);
    const args = columns.map(([, value]) => value);
    await this.db.prepare(`UPDATE room_tasks SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
  }

  private toTask(row: TaskRow): RoomTask {
    return {
      id: row.id,
      roomId: row.room_id,
      title: row.title,
      brief: row.brief,
      acceptance: row.acceptance,
      state: row.state,
      environmentId: row.environment_id,
      attempt: Number(row.attempt),
      base: row.base,
      branch: row.branch,
      head: row.head,
      report: row.report,
      files: JSON.parse(row.files_json) as RoomTask['files'],
      questions: JSON.parse(row.questions_json) as RoomTask['questions'],
      review: row.review ?? 'none',
      reviewRounds: Number(row.review_rounds ?? 0),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async insertWorkerTask(task: {
    taskId: string;
    roomId: string;
    hostInstanceId: string;
    attempt: number;
    folder: string;
    pushUrl: string | null;
    pushToken: string | null;
    a2aTaskId: string;
  }): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO room_worker_tasks (task_id, room_id, host_instance_id, attempt, folder, state, push_url, push_token, a2a_task_id, created_at) VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, ?)
         ON CONFLICT (task_id) DO UPDATE SET attempt = excluded.attempt, folder = excluded.folder, state = 'running', worker_thread_id = NULL, push_url = excluded.push_url, push_token = excluded.push_token, a2a_task_id = excluded.a2a_task_id`,
      )
      .run(
        task.taskId,
        task.roomId,
        task.hostInstanceId,
        task.attempt,
        task.folder,
        task.pushUrl,
        task.pushToken,
        task.a2aTaskId,
        Date.now(),
      );
  }

  async workerTask(taskId: string): Promise<WorkerTaskRow | undefined> {
    const row = (await this.db.prepare('SELECT * FROM room_worker_tasks WHERE task_id = ?').get(taskId)) as
      RawWorkerTask | undefined;
    return row
      ? {
          taskId: row.task_id,
          roomId: row.room_id,
          hostInstanceId: row.host_instance_id,
          attempt: Number(row.attempt),
          workerThreadId: row.worker_thread_id,
          folder: row.folder,
          state: row.state,
          pushUrl: row.push_url,
          pushToken: row.push_token,
          a2aTaskId: row.a2a_task_id,
        }
      : undefined;
  }

  async workerTaskByA2a(a2aTaskId: string): Promise<WorkerTaskRow | undefined> {
    const row = (await this.db
      .prepare('SELECT task_id FROM room_worker_tasks WHERE a2a_task_id = ?')
      .get(a2aTaskId)) as { task_id: string } | undefined;
    return row ? await this.workerTask(row.task_id) : undefined;
  }

  async updateWorkerTask(
    taskId: string,
    patch: { workerThreadId?: string; state?: WorkerTaskRow['state'] },
  ): Promise<void> {
    if (patch.workerThreadId !== undefined)
      await this.db
        .prepare('UPDATE room_worker_tasks SET worker_thread_id = ? WHERE task_id = ?')
        .run(patch.workerThreadId, taskId);
    if (patch.state !== undefined)
      await this.db.prepare('UPDATE room_worker_tasks SET state = ? WHERE task_id = ?').run(patch.state, taskId);
  }

  async runningWorkerTasks(): Promise<WorkerTaskRow[]> {
    const rows = (await this.db.prepare("SELECT task_id FROM room_worker_tasks WHERE state = 'running'").all()) as {
      task_id: string;
    }[];
    const tasks = await Promise.all(rows.map(async (row) => await this.workerTask(row.task_id)));
    return tasks.filter((task): task is WorkerTaskRow => !!task);
  }

  async enqueue(
    item: { taskId: string; hostInstanceId: string; path: string; body: unknown; token?: string | null },
    now = Date.now(),
  ) {
    await this.db
      .prepare(
        'INSERT INTO room_outbox (task_id, host_instance_id, path, body_json, token, next_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(item.taskId, item.hostInstanceId, item.path, JSON.stringify(item.body), item.token ?? null, now, now);
  }

  async outbox(): Promise<OutboxRow[]> {
    const rows = (await this.db
      .prepare(
        'SELECT id, task_id, host_instance_id, path, body_json, token, tries, next_at, created_at FROM room_outbox ORDER BY id',
      )
      .all()) as {
      id: number;
      task_id: string;
      host_instance_id: string;
      path: string;
      body_json: string;
      token: string | null;
      tries: number;
      next_at: number;
      created_at: number;
    }[];
    return rows.map((row) => ({
      id: Number(row.id),
      taskId: row.task_id,
      hostInstanceId: row.host_instance_id,
      path: row.path,
      body: JSON.parse(row.body_json) as unknown,
      token: row.token,
      tries: Number(row.tries),
      nextAt: Number(row.next_at),
      createdAt: Number(row.created_at),
    }));
  }

  async delivered(id: number): Promise<void> {
    await this.db.prepare('DELETE FROM room_outbox WHERE id = ?').run(id);
  }

  async retryLater(id: number, nextAt: number): Promise<void> {
    await this.db.prepare('UPDATE room_outbox SET tries = tries + 1, next_at = ? WHERE id = ?').run(nextAt, id);
  }

  async rememberHost(
    hostInstanceId: string,
    hostName: string,
    rooms: readonly Room[],
    seenAt = Date.now(),
  ): Promise<void> {
    await this.db.transaction(async () => {
      await this.db
        .prepare(
          `DELETE FROM room_directory WHERE host_instance_id = ? AND room_id NOT IN (${rooms.map(() => '?').join(', ') || "''"})`,
        )
        .run(hostInstanceId, ...rooms.map((room) => room.id));
      for (const room of rooms)
        await this.db
          .prepare(
            `INSERT INTO room_directory (room_id, host_instance_id, host_name, room_json, last_seen_at, reachable) VALUES (?, ?, ?, ?, ?, 1)
             ON CONFLICT (room_id) DO UPDATE SET host_instance_id = excluded.host_instance_id, host_name = excluded.host_name, room_json = excluded.room_json, last_seen_at = excluded.last_seen_at, reachable = 1`,
          )
          .run(room.id, hostInstanceId, hostName, JSON.stringify(room), seenAt);
    })();
  }

  async hostUnreachable(hostInstanceId: string, hostName: string): Promise<void> {
    await this.db
      .prepare('UPDATE room_directory SET reachable = 0, host_name = ? WHERE host_instance_id = ?')
      .run(hostName, hostInstanceId);
  }

  async forgetHostsExcept(hostInstanceIds: readonly string[]): Promise<void> {
    await this.db
      .prepare(
        `DELETE FROM room_directory WHERE host_instance_id NOT IN (${hostInstanceIds.map(() => '?').join(', ') || "''"})`,
      )
      .run(...hostInstanceIds);
  }

  async enqueueWake(
    roomId: string,
    text: string,
    cause: WakeCause,
    sourceKey: string = randomUUID(),
    images: readonly RoomImage[] = [],
    ownerSeq: number | null = null,
    commitmentRevision: number | null = null,
  ): Promise<string> {
    const id = randomUUID();
    await this.db
      .prepare(
        `INSERT INTO room_wakeups(id, room_id, source_key, title, text, cause_json, images_json, owner_seq, created_at, updated_at, commitment_revision)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(room_id, source_key) DO NOTHING`,
      )
      .run(
        id,
        roomId,
        sourceKey,
        redact(cause.title) as string,
        redact(text) as string,
        JSON.stringify(cause),
        JSON.stringify(images),
        ownerSeq,
        Date.now(),
        Date.now(),
        commitmentRevision,
      );
    const saved = await this.db
      .prepare('SELECT id FROM room_wakeups WHERE room_id=? AND source_key=?')
      .get<{ id: string }>(roomId, sourceKey);
    if (!saved) throw new Error('The durable room message is missing.');
    return saved.id;
  }

  async acceptMessage(
    roomId: string,
    message: { text: string; images?: RoomImage[] },
    sourceKey: string,
  ): Promise<{ event: RoomEvent; fresh: boolean }> {
    return this.db.transaction(async () => {
      const existing = await this.db
        .prepare('SELECT owner_seq FROM room_wakeups WHERE room_id = ? AND source_key = ?')
        .get<{ owner_seq: number }>(roomId, sourceKey);
      if (existing) {
        const event = (await this.events(roomId, existing.owner_seq - 1))[0];
        if (!event) throw new Error('The accepted message is missing.');
        return { event, fresh: false };
      }
      const event = await this.append(roomId, {
        kind: 'message',
        actor: 'owner',
        text: message.text,
        images: message.images?.length ?? 0,
      });
      await this.enqueueWake(
        roomId,
        message.text,
        { kind: 'owner', title: message.text },
        sourceKey,
        message.images ?? [],
        event.seq,
      );
      return { event, fresh: true };
    })();
  }

  async wakeBySource(
    roomId: string,
    sourceKey: string,
  ): Promise<
    { id: string; ownerSeq: number | null; state: 'queued' | 'running' | 'done' | 'failed' | 'review' } | undefined
  > {
    return this.db
      .prepare('SELECT id,owner_seq AS ownerSeq,state FROM room_wakeups WHERE room_id=? AND source_key=?')
      .get(roomId, sourceKey);
  }

  async nextWake(roomId: string): Promise<RoomWake | undefined> {
    const row = await this.db
      .prepare(
        "SELECT * FROM room_wakeups WHERE room_id = ? AND state = 'queued' ORDER BY CASE WHEN json_extract(cause_json,'$.kind') IN ('owner','approval') THEN 0 WHEN json_extract(cause_json,'$.kind') IN ('schedule','poll') THEN 2 ELSE 1 END, created_at, rowid LIMIT 1",
      )
      .get<{ id: string; text: string; cause_json: string; images_json: string }>(roomId);
    return row
      ? { id: row.id, text: row.text, cause: JSON.parse(row.cause_json), images: JSON.parse(row.images_json) }
      : undefined;
  }
  async pendingWakes(roomId: string): Promise<number> {
    return (
      (
        await this.db
          .prepare("SELECT count(*) AS n FROM room_wakeups WHERE room_id=? AND state='queued'")
          .get<{ n: number }>(roomId)
      )?.n ?? 0
    );
  }
  async claimWake(id: string): Promise<boolean> {
    const result = await this.db
      .prepare(
        "UPDATE room_wakeups SET state = 'running', updated_at = ?, started_at = ? WHERE id = ? AND state = 'queued'",
      )
      .run(Date.now(), Date.now(), id);
    return Number(result.changes) === 1;
  }
  async requeueWake(id: string): Promise<void> {
    await this.db
      .prepare("UPDATE room_wakeups SET state='queued',updated_at=? WHERE id=? AND state='running'")
      .run(Date.now(), id);
  }
  async wakeCurrent(id: string): Promise<boolean> {
    return !!(await this.db
      .prepare(
        `SELECT 1 FROM room_wakeups w WHERE w.id=? AND w.state='running'
      AND NOT EXISTS (SELECT 1 FROM room_commitments c WHERE c.room_id=w.room_id AND c.id=json_extract(w.cause_json,'$.trigger')
        AND (c.state<>'open' OR c.revision<>w.commitment_revision))`,
      )
      .get(id));
  }
  async finishWake(id: string, state: 'done' | 'failed' | 'review', resultSeq?: number): Promise<void> {
    await this.db
      .prepare(
        "UPDATE room_wakeups SET state = ?, result_seq = ?, images_json = CASE WHEN ? = 'done' THEN '[]' ELSE images_json END, updated_at = ? WHERE id = ?",
      )
      .run(state, resultSeq ?? null, state, Date.now(), id);
  }
  async recoverWakes(): Promise<void> {
    await this.db
      .prepare("UPDATE room_wakeups SET state = 'review', updated_at = ? WHERE state = 'running'")
      .run(Date.now());
  }
  async queuedRooms(): Promise<string[]> {
    return (
      await this.db
        .prepare(
          "SELECT DISTINCT w.room_id FROM room_wakeups w JOIN rooms r ON r.id = w.room_id WHERE w.state = 'queued' AND r.archived_at IS NULL AND r.paused = 0",
        )
        .all<{ room_id: string }>()
    ).map((r) => r.room_id);
  }
  async inTransaction<T>(action: () => Promise<T>): Promise<T> {
    return this.db.transaction(action)();
  }

  async directory(): Promise<Omit<RoomDirectoryEntry, 'local'>[]> {
    const rows = (await this.db
      .prepare('SELECT host_name, room_json, last_seen_at, reachable FROM room_directory ORDER BY last_seen_at DESC')
      .all()) as { host_name: string; room_json: string; last_seen_at: number; reachable: number }[];
    return rows.flatMap((row) => {
      const parsed = RoomSchema.safeParse(JSON.parse(row.room_json));
      return parsed.success
        ? [
            {
              room: parsed.data,
              hostName: row.host_name,
              hostReachable: row.reachable === 1,
              lastSeenAt: row.last_seen_at,
            },
          ]
        : [];
    });
  }
}

export type FoundRoom = NonNullable<Awaited<ReturnType<RoomsRepository['get']>>>;
export interface WakeCause {
  kind: RoomRun['cause'];
  title: string;
  trigger?: string;
}
export interface RoomWake {
  id: string;
  text: string;
  cause: WakeCause;
  images: RoomImage[];
}
