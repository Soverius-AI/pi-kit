import { Injectable } from '@nestjs/common';
import { redact, type RoomRun, type RoomRunStep } from '@pi-kit/protocol';
import { DatabaseService } from './database.service';

interface RunRow {
  id: string;
  room_id: string;
  number: number;
  cause: RoomRun['cause'];
  trigger_id: string | null;
  title: string;
  playbook: string | null;
  stage: string | null;
  state: RoomRun['state'];
  summary: string | null;
  started_at: number;
  ended_at: number | null;
}

interface StepRow {
  run_id: string;
  seq: number;
  kind: RoomRunStep['kind'];
  name: string;
  detail: string;
  state: RoomRunStep['state'];
  output: string | null;
  started_at: number;
  ended_at: number | null;
}

@Injectable()
export class RoomRunsRepository {
  static readonly KEPT = 50;

  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  async insert(
    run: Pick<RoomRun, 'id' | 'roomId' | 'cause' | 'trigger' | 'title' | 'playbook' | 'stage'>,
    now = Date.now(),
  ): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO room_runs (id, room_id, number, cause, trigger_id, title, playbook, stage, state, started_at)
         VALUES (?, ?, (SELECT COALESCE(MAX(number), 0) + 1 FROM room_runs WHERE room_id = ?), ?, ?, ?, ?, ?, 'running', ?)`,
      )
      .run(
        run.id,
        run.roomId,
        run.roomId,
        run.cause,
        run.trigger,
        redact(run.title) as string,
        run.playbook,
        run.stage,
        now,
      );
  }

  async setState(id: string, state: RoomRun['state']): Promise<void> {
    await this.db.prepare('UPDATE room_runs SET state = ? WHERE id = ? AND ended_at IS NULL').run(state, id);
  }

  async end(
    id: string,
    state: RoomRun['state'],
    summary: string | null,
    stage: string | null,
    now = Date.now(),
  ): Promise<void> {
    await this.db
      .prepare('UPDATE room_runs SET state = ?, summary = ?, stage = ?, ended_at = ? WHERE id = ?')
      .run(state, summary === null ? null : (redact(summary) as string), stage, now, id);
    await this.db
      .prepare("UPDATE room_run_steps SET state = 'failed', ended_at = ? WHERE run_id = ? AND state = 'running'")
      .run(now, id);
  }

  async closeOpen(now = Date.now()): Promise<void> {
    await this.db.prepare("UPDATE room_run_steps SET state = 'failed', ended_at = ? WHERE state = 'running'").run(now);
    await this.db.prepare("UPDATE room_runs SET state = 'stopped', ended_at = ? WHERE ended_at IS NULL").run(now);
  }

  async addStep(
    runId: string,
    step: Pick<RoomRunStep, 'kind' | 'name' | 'detail' | 'state'> & { actionId?: string },
    now = Date.now(),
  ): Promise<number> {
    const row = (await this.db
      .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM room_run_steps WHERE run_id = ?')
      .get(runId)) as { seq: number };
    const seq = Number(row.seq);
    await this.db
      .prepare(
        'INSERT INTO room_run_steps (run_id, seq, kind, name, detail, state, action_id, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        runId,
        seq,
        step.kind,
        step.name,
        redact(step.detail) as string,
        step.state,
        step.actionId ?? null,
        now,
        step.state === 'running' || step.state === 'waiting' ? null : now,
      );
    return seq;
  }

  async settleStep(
    runId: string,
    seq: number,
    state: RoomRunStep['state'],
    output: string | null,
    now = Date.now(),
  ): Promise<void> {
    await this.db
      .prepare('UPDATE room_run_steps SET state = ?, output = ?, ended_at = ? WHERE run_id = ? AND seq = ?')
      .run(state, output === null ? null : (redact(output) as string), now, runId, seq);
  }

  async stepOfAction(actionId: string): Promise<{ runId: string; seq: number } | undefined> {
    const row = (await this.db.prepare('SELECT run_id, seq FROM room_run_steps WHERE action_id = ?').get(actionId)) as
      { run_id: string; seq: number } | undefined;
    return row ? { runId: row.run_id, seq: Number(row.seq) } : undefined;
  }

  async get(id: string): Promise<RoomRun | undefined> {
    const row = (await this.db.prepare('SELECT * FROM room_runs WHERE id = ?').get(id)) as RunRow | undefined;
    return row ? (await this.withSteps([row]))[0] : undefined;
  }

  async list(roomId: string): Promise<RoomRun[]> {
    const rows = (await this.db
      .prepare('SELECT * FROM room_runs WHERE room_id = ? ORDER BY number DESC LIMIT ?')
      .all(roomId, RoomRunsRepository.KEPT)) as RunRow[];
    return await this.withSteps(rows);
  }

  private async withSteps(rows: RunRow[]): Promise<RoomRun[]> {
    if (!rows.length) return [];
    const steps = (await this.db
      .prepare(
        `SELECT run_id, seq, kind, name, detail, state, output, started_at, ended_at FROM room_run_steps WHERE run_id IN (${rows.map(() => '?').join(', ')}) ORDER BY seq`,
      )
      .all(...rows.map((row) => row.id))) as StepRow[];
    return rows.map((row) => ({
      id: row.id,
      roomId: row.room_id,
      number: Number(row.number),
      cause: row.cause,
      trigger: row.trigger_id,
      title: row.title,
      playbook: row.playbook,
      stage: row.stage,
      state: row.state,
      summary: row.summary,
      startedAt: Number(row.started_at),
      endedAt: row.ended_at === null ? null : Number(row.ended_at),
      steps: steps
        .filter((step) => step.run_id === row.id)
        .map((step) => ({
          seq: Number(step.seq),
          kind: step.kind,
          name: step.name,
          detail: step.detail,
          state: step.state,
          output: step.output,
          startedAt: Number(step.started_at),
          endedAt: step.ended_at === null ? null : Number(step.ended_at),
        })),
    }));
  }
}
