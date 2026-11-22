import { Injectable } from '@nestjs/common';
import { Task, TaskState, taskStateToJSON, type ListTasksRequest, type ListTasksResponse } from '@a2a-js/sdk';
import { resolveUserScope, type ServerCallContext, type TaskStore } from '@a2a-js/sdk/server';
import { A2aTasksRepository } from '../db/a2a-tasks.repository';
import { RoomA2a } from './room-a2a';

@Injectable()
export class RoomA2aTaskStore implements TaskStore {
  private readonly kept = new Map<string, string>();

  constructor(private readonly tasks: A2aTasksRepository) {}

  async save(task: Task, context: ServerCallContext): Promise<void> {
    await this.saveFor(resolveUserScope(context), task);
  }

  async saveFor(owner: string, task: Task): Promise<void> {
    const stored = Task.toJSON({
      ...task,
      artifacts: task.artifacts.filter((artifact) => artifact.artifactId !== RoomA2a.LIVE),
    });
    const state = taskStateToJSON(task.status?.state ?? TaskState.TASK_STATE_UNSPECIFIED);
    const key = `${owner}\0${task.id}`;
    const text = JSON.stringify(stored);
    if (this.kept.get(key) === text) return;
    await this.tasks.save({ owner, id: task.id, contextId: task.contextId, state, task: stored });
    this.kept.delete(key);
    if (task.status?.state === TaskState.TASK_STATE_WORKING) this.kept.set(key, text);
    while (this.kept.size > 64) this.kept.delete(this.kept.keys().next().value as string);
  }

  async load(taskId: string, context: ServerCallContext): Promise<Task | undefined> {
    return await this.loadFor(resolveUserScope(context), taskId);
  }

  async loadFor(owner: string, taskId: string): Promise<Task | undefined> {
    const row = await this.tasks.load(owner, taskId);
    return row ? Task.fromJSON(row.task) : undefined;
  }

  async list(params: ListTasksRequest, context: ServerCallContext): Promise<ListTasksResponse> {
    const pageSize = Math.min(Math.max(params.pageSize ?? 50, 1), 100);
    const offset = Number.parseInt(params.pageToken || '0', 10) || 0;
    const after = params.statusTimestampAfter ? Date.parse(params.statusTimestampAfter) : undefined;
    const { rows, total } = await this.tasks.list(
      resolveUserScope(context),
      {
        contextId: params.contextId || undefined,
        state: params.status ? taskStateToJSON(params.status) : undefined,
        after: after !== undefined && !Number.isNaN(after) ? after : undefined,
      },
      pageSize,
      offset,
    );
    const tasks = rows.map((row) => {
      const task = Task.fromJSON(row.task);
      return params.historyLength === 0 ? { ...task, history: [] } : task;
    });
    return {
      tasks,
      nextPageToken: offset + rows.length < total ? String(offset + rows.length) : '',
      pageSize,
      totalSize: total,
    };
  }
}
