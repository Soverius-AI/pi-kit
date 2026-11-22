import { Injectable, type OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { RoomRun, RoomRunStep } from '@pi-kit/protocol';
import { RoomRunsRepository } from '../db/room-runs.repository';
import { RoomBus } from './room-bus';

export interface RunCause {
  kind: RoomRun['cause'];
  title: string;
  trigger?: string;
}

@Injectable()
export class RoomRuns implements OnModuleInit {
  static readonly TITLE = 160;
  static readonly OUTPUT = 6000;
  private readonly current = new Map<string, string>();

  constructor(
    private readonly store: RoomRunsRepository,
    private readonly bus: RoomBus,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.store.closeOpen();
  }

  list(roomId: string): Promise<RoomRun[]> {
    return this.store.list(roomId);
  }

  async start(
    roomId: string,
    cause: RunCause,
    room: { playbook: string | null; stage: string | null },
  ): Promise<string> {
    const id = randomUUID();
    const line = cause.title.trim().split('\n')[0] ?? '';
    await this.store.insert({
      id,
      roomId,
      cause: cause.kind,
      trigger: cause.trigger ?? null,
      title: line.length > RoomRuns.TITLE ? `${line.slice(0, RoomRuns.TITLE)}…` : line || cause.kind,
      playbook: room.playbook,
      stage: room.stage,
    });
    this.current.set(roomId, id);
    await this.publish(roomId, id);
    return id;
  }

  async waiting(roomId: string, waiting: boolean): Promise<void> {
    const id = this.current.get(roomId);
    if (!id) return;
    await this.store.setState(id, waiting ? 'waiting' : 'running');
    await this.publish(roomId, id);
  }

  async end(
    roomId: string,
    id: string,
    state: 'done' | 'failed' | 'stopped',
    summary: string | null,
    stage: string | null,
  ): Promise<void> {
    if (this.current.get(roomId) === id) this.current.delete(roomId);
    await this.store.end(id, state, summary === null ? null : this.cut(summary), stage);
    await this.publish(roomId, id);
  }

  async step(
    roomId: string,
    step: Pick<RoomRunStep, 'kind' | 'name' | 'detail'> & { state?: RoomRunStep['state']; actionId?: string },
  ): Promise<number | undefined> {
    const id = this.current.get(roomId);
    if (!id) return undefined;
    const seq = await this.store.addStep(id, { ...step, state: step.state ?? 'running' });
    await this.publish(roomId, id);
    return seq;
  }

  async settle(
    roomId: string,
    seq: number | undefined,
    state: RoomRunStep['state'],
    output: string | null,
  ): Promise<void> {
    const id = this.current.get(roomId);
    if (!id || seq === undefined) return;
    await this.store.settleStep(id, seq, state, output === null ? null : this.cut(output));
    await this.publish(roomId, id);
  }

  async settleAction(
    roomId: string,
    actionId: string,
    state: RoomRunStep['state'],
    output: string | null,
  ): Promise<void> {
    const step = await this.store.stepOfAction(actionId);
    if (!step) return;
    await this.store.settleStep(step.runId, step.seq, state, output === null ? null : this.cut(output));
    await this.publish(roomId, step.runId);
  }

  private cut(text: string): string {
    return text.length > RoomRuns.OUTPUT ? `${text.slice(0, RoomRuns.OUTPUT)}\n…` : text;
  }

  private async publish(roomId: string, id: string): Promise<void> {
    const run = await this.store.get(id);
    if (run) this.bus.emit(roomId, { type: 'run', run });
  }
}
