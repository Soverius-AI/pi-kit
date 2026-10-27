import { Body, ConflictException, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { type QueueSnapshot, QueueSnapshotSchema, QueueTargetSchema } from '@pi-kit/protocol';
import type { z } from 'zod';
import { Fails, Responds, ThreadIdParam } from '../contract';
import { PiSessionService, QueueStaleError } from '../pi/pi-session.service';

const STALE = 'The queue changed since the client read it: the message is no longer where it was.';

/**
 * The queue of messages that wait for the running turn. Queuing itself is a run request (`streamingBehavior`);
 * these endpoints read pi's queue and edit it. pi has no edit call, so each action is `clearQueue()` followed by queuing
 * what stays (`SessionQueue`). Every answer is pi's queue as it is after the action, read back from the session.
 * A thread whose session is not open has an empty queue: nothing can be waiting in a session that is not running.
 */
@ApiTags('session')
@ThreadIdParam()
@Controller()
export class QueueController {
  constructor(private readonly sessions: PiSessionService) {}

  @Get('threads/:id/queue')
  @ApiOperation({ summary: 'Get the message queue', description: "Returns the messages that wait for the running turn: steering messages first, then follow-ups. A thread that is not running has an empty queue." })
  @Responds(QueueSnapshotSchema)
  queue(@Param('id') id: string): QueueSnapshot {
    return this.sessions.queue(id);
  }

  /** Steer now: a follow-up moves to the steering queue (after the others waiting there). */
  @Post('threads/:id/queue/promote')
  @HttpCode(200)
  @ApiOperation({ summary: 'Steer with a queued message', description: 'Moves a follow-up to the steering queue, after the others waiting there, and answers with the queue.' })
  @Responds(QueueSnapshotSchema)
  @Fails({ 409: STALE })
  promote(@Param('id') id: string, @Body({ schema: QueueTargetSchema }) body: z.infer<typeof QueueTargetSchema>): Promise<QueueSnapshot> {
    return this.guard(() => this.sessions.promoteQueued(id, body));
  }

  @Post('threads/:id/queue/remove')
  @HttpCode(200)
  @ApiOperation({ summary: 'Remove a queued message', description: 'Removes one message from the queue, and answers with the queue.' })
  @Responds(QueueSnapshotSchema)
  @Fails({ 409: STALE })
  remove(@Param('id') id: string, @Body({ schema: QueueTargetSchema }) body: z.infer<typeof QueueTargetSchema>): Promise<QueueSnapshot> {
    return this.guard(() => this.sessions.removeQueued(id, body));
  }

  /** Every queued text in one message, joined by blank lines, in delivery order. */
  @Post('threads/:id/queue/merge')
  @HttpCode(200)
  @ApiOperation({ summary: 'Merge the queued messages', description: 'Joins every queued text into one message, separated by blank lines in delivery order, and answers with the queue.' })
  @Responds(QueueSnapshotSchema)
  merge(@Param('id') id: string): Promise<QueueSnapshot> {
    return this.guard(() => this.sessions.mergeQueued(id));
  }

  @Post('threads/:id/queue/clear')
  @HttpCode(200)
  @ApiOperation({ summary: 'Clear the message queue', description: 'Drops every queued message, and answers with the empty queue.' })
  @Responds(QueueSnapshotSchema)
  clear(@Param('id') id: string): Promise<QueueSnapshot> {
    return this.guard(() => this.sessions.clearQueued(id));
  }

  private async guard<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof QueueStaleError) throw new ConflictException(error.message);
      throw error;
    }
  }
}
