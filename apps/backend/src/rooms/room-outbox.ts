import { Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { A2A_TOKEN_HEADER, A2A_VERSION, A2A_VERSION_HEADER } from '@pi-kit/protocol';
import { RoomsRepository } from '../db/rooms.repository';
import { PeerProxy } from '../peers/peer-proxy';

@Injectable()
export class RoomOutbox implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(RoomOutbox.name);
  private readonly delays = [5_000, 15_000, 30_000, 60_000, 120_000, 300_000];
  private readonly giveUpAfter = 24 * 60 * 60 * 1000;
  private timer: ReturnType<typeof setInterval> | undefined;
  private flushing: Promise<void> | undefined;

  constructor(
    private readonly rooms: RoomsRepository,
    private readonly proxy: PeerProxy,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(
      () =>
        void this.flush().catch((error: unknown) =>
          this.logger.warn(`Delivering room pushes failed: ${error instanceof Error ? error.message : String(error)}`),
        ),
      15_000,
    );
    this.timer.unref?.();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async enqueue(item: { taskId: string; hostInstanceId: string; path: string; body: unknown; token: string | null }) {
    await this.rooms.enqueue(item);
  }

  async flush(now = Date.now()): Promise<void> {
    while (this.flushing) await this.flushing;
    this.flushing = this.deliver(now).finally(() => (this.flushing = undefined));
    await this.flushing;
  }

  private async deliver(now: number): Promise<void> {
    const waiting = new Set<string>();
    for (const item of await this.rooms.outbox()) {
      if (waiting.has(item.hostInstanceId)) continue;
      if (item.nextAt > now) {
        waiting.add(item.hostInstanceId);
        continue;
      }
      try {
        const answer = await this.proxy.call(item.hostInstanceId, item.path, 'POST', item.body, {
          signal: AbortSignal.timeout(30_000),
          headers: { [A2A_VERSION_HEADER]: A2A_VERSION, ...(item.token ? { [A2A_TOKEN_HEADER]: item.token } : {}) },
        });
        if (answer.status >= 200 && answer.status < 300) {
          await this.rooms.delivered(item.id);
          continue;
        }
        if (answer.status === 409 || answer.status === 404 || answer.status === 403) {
          this.logger.warn(`The host refused the push for task ${item.taskId} (${answer.status}).`);
          await this.rooms.delivered(item.id);
          continue;
        }
      } catch (error) {
        this.logger.warn(
          `The host of task ${item.taskId} is unreachable: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      waiting.add(item.hostInstanceId);
      if (now - item.createdAt > this.giveUpAfter) {
        this.logger.warn(`Gave up pushing task ${item.taskId} after a day without its host.`);
        await this.rooms.delivered(item.id);
        continue;
      }
      await this.rooms.retryLater(item.id, now + (this.delays[item.tries] ?? this.delays[this.delays.length - 1]));
    }
  }
}
