import { Injectable } from '@nestjs/common';
import { StreamResponse, TaskState, type Task } from '@a2a-js/sdk';
import type { PushNotificationSender, ServerCallContext } from '@a2a-js/sdk/server';
import { RoomsRepository } from '../db/rooms.repository';
import { RoomA2a } from './room-a2a';
import { RoomA2aPushStore } from './room-a2a.push-store';
import { RoomOutbox } from './room-outbox';

@Injectable()
export class RoomA2aPushSender implements PushNotificationSender {
  private static readonly TERMINAL = new Set<TaskState>([
    TaskState.TASK_STATE_COMPLETED,
    TaskState.TASK_STATE_FAILED,
    TaskState.TASK_STATE_CANCELED,
    TaskState.TASK_STATE_REJECTED,
  ]);

  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly rooms: RoomsRepository,
    private readonly outbox: RoomOutbox,
    private readonly pushes: RoomA2aPushStore,
  ) {}

  send(response: StreamResponse, _context: ServerCallContext | undefined, task?: Task): Promise<void> {
    const queued = this.chain.then(async () => await this.queue(response, task));
    this.chain = queued.catch(() => undefined);
    return queued;
  }

  private async queue(response: StreamResponse, task: Task | undefined): Promise<void> {
    const payload = response.payload;
    const id =
      task?.id ??
      (payload?.$case === 'task'
        ? payload.value.id
        : payload?.$case === 'statusUpdate' || payload?.$case === 'artifactUpdate'
          ? payload.value.taskId
          : payload?.value.taskId);
    const row = id ? await this.rooms.workerTaskByA2a(id) : undefined;
    if (!id || !row || payload?.$case === 'artifactUpdate') return;
    const configs = await this.pushes.loadFor(row.hostInstanceId, id);
    if (!configs.length) return;
    const final =
      payload?.$case === 'statusUpdate' &&
      task &&
      payload.value.status &&
      RoomA2aPushSender.TERMINAL.has(payload.value.status.state)
        ? StreamResponse.toJSON({
            payload: {
              $case: 'task',
              value: {
                ...task,
                artifacts: task.artifacts.filter((artifact) => artifact.artifactId !== RoomA2a.LIVE),
                status: payload.value.status,
                metadata: { ...task.metadata, ...payload.value.metadata },
              },
            },
          })
        : StreamResponse.toJSON(response);
    for (const config of configs) {
      const target = RoomA2a.parsePeerUrl(config.url);
      if (!target) continue;
      await this.outbox.enqueue({
        taskId: row.taskId,
        hostInstanceId: target.instanceId,
        path: target.path,
        body: final,
        token: config.token || null,
      });
    }
    void this.outbox.flush().catch(() => undefined);
  }
}
