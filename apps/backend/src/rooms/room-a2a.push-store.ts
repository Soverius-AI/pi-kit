import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { TaskPushNotificationConfig } from '@a2a-js/sdk';
import { RequestMalformedError } from '@a2a-js/sdk/errors';
import {
  resolveUserScope,
  type PushNotificationStore,
  type ServerCallContext,
  type StoredPushNotificationConfig,
} from '@a2a-js/sdk/server';
import { A2aTasksRepository } from '../db/a2a-tasks.repository';
import { RoomA2a } from './room-a2a';

export const PUSH_ONLY_TO_CALLER =
  'This agent sends push notifications only to the paired pi-kit that asks for them (pi-kit-peer://<its instance id>/api/…).';

@Injectable()
export class RoomA2aPushStore implements PushNotificationStore {
  constructor(private readonly tasks: A2aTasksRepository) {}

  async save(taskId: string, context: ServerCallContext, config: TaskPushNotificationConfig): Promise<void> {
    const owner = resolveUserScope(context);
    if (!context.user?.isAuthenticated || RoomA2a.parsePeerUrl(config.url)?.instanceId !== owner)
      throw new RequestMalformedError(PUSH_ONLY_TO_CALLER);
    if (!config.id) config.id = randomUUID();
    await this.tasks.savePush({
      owner,
      taskId,
      id: config.id,
      config: TaskPushNotificationConfig.toJSON({ ...config, taskId }),
      wireVersion: context.requestedVersion || '1.0',
    });
  }

  async load(taskId: string, context: ServerCallContext): Promise<TaskPushNotificationConfig[]> {
    return await this.loadFor(resolveUserScope(context), taskId);
  }

  async loadWithMetadata(taskId: string, context: ServerCallContext): Promise<StoredPushNotificationConfig[]> {
    return (await this.tasks.pushes(resolveUserScope(context), taskId)).map((row) => ({
      config: TaskPushNotificationConfig.fromJSON(row.config),
      wireVersion: row.wireVersion,
    }));
  }

  async loadFor(owner: string, taskId: string): Promise<TaskPushNotificationConfig[]> {
    return (await this.tasks.pushes(owner, taskId)).map((row) => TaskPushNotificationConfig.fromJSON(row.config));
  }

  async delete(taskId: string, context: ServerCallContext, configId?: string): Promise<void> {
    await this.tasks.deletePush(resolveUserScope(context), taskId, configId ?? taskId);
  }
}
