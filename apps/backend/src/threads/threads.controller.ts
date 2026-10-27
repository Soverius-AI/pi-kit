import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, Res } from '@nestjs/common';
import { ApiNoContentResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import {
  CloneThreadSchema,
  CreateThreadSchema,
  DeleteThreadQuerySchema,
  type FeedbackEntry,
  FeedbackEntrySchema,
  ForkThreadSchema,
  ListThreadsQuerySchema,
  PatchThreadSchema,
  ThreadPlacementSchema,
  PutFeedbackSchema,
  type ThreadDetail,
  ThreadDetailSchema,
  type ThreadsEvent,
  ThreadsEventSchema,
  type ThreadSummary,
  ThreadSummarySchema,
} from '@pi-kit/protocol';
import type { z } from 'zod';
import { Fails, Responds, Streams } from '../contract';
import { FeedbackRepository } from '../db/feedback.repository';
import { ThreadStatusService } from './thread-status.service';
import { ThreadsService } from './threads.service';

/** A `ping` line on the status stream keeps idle connections open through proxies and tells a dead one apart. */
const STATUS_PING_MS = 20_000;

const NO_THREAD = 'There is no such thread.';
const THREAD_ID = { name: 'id', description: 'The thread id (the pi session id).', schema: { type: 'string' } } as const;

/**
 * The threads of the sidebar: list, create, fork and clone, placement, patch and delete, the seen mark, the thumbs
 * up / down feedback on messages, and `threads/events`, the status stream every client keeps open.
 */
@ApiTags('threads')
@Controller()
export class ThreadsController {
  constructor(
    private readonly threads: ThreadsService,
    private readonly feedback: FeedbackRepository,
    private readonly status: ThreadStatusService,
  ) {}

  @Get('threads')
  @ApiOperation({ summary: 'List threads', description: 'Lists the threads of one project folder, or of every project without `workspace`. Archived threads come with `archived=1`.' })
  @Responds(ThreadSummarySchema, { array: true })
  list(@Query({ schema: ListThreadsQuerySchema }) query: z.infer<typeof ListThreadsQuerySchema>): ThreadSummary[] {
    return this.threads.list({ workspace: query.workspace || undefined, includeArchived: query.archived === '1' || query.archived === 'true' });
  }

  /**
   * The status channel: newline-delimited JSON. A `snapshot` of every thread's state first, then a `state` line whenever one
   * changes (a run starts or ends, a question opens or is answered, the attendant writes a summary), `gone` for a deleted thread, `list` when
   * threads or projects were added, removed, renamed or reordered, and a `ping` every 20 s. It must be declared before `threads/:id`.
   */
  @Get('threads/events')
  @ApiOperation({
    summary: 'Stream thread status',
    description:
      "Keeps the connection open and sends newline-delimited JSON: a `snapshot` of every thread's state first, then a `state` line whenever one changes, `gone` for a deleted thread, " +
      '`list` when threads or projects were added, removed, renamed or reordered, and a `ping` every 20 seconds.',
  })
  @Streams(ThreadsEventSchema, 'The stream stays open until the client closes it.')
  events(@Res() res: Response): void {
    res.status(200).set({ 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders();
    const send = (event: ThreadsEvent): void => {
      if (!res.writableEnded) res.write(`${JSON.stringify(event)}\n`);
    };
    // Subscribe before the snapshot is read: a change in between is sent twice rather than lost.
    const leave = this.status.subscribe(send);
    send({ type: 'snapshot', states: this.status.snapshot() });
    const ping = setInterval(() => send({ type: 'ping' }), STATUS_PING_MS);
    res.on('close', () => {
      clearInterval(ping);
      leave();
    });
  }

  @Post('threads')
  @ApiOperation({
    summary: 'Create a thread',
    description:
      'Starts a thread in a project folder; with `local` the folder is switched to another branch first (only with a clean tree), with `worktree` it runs in a new git worktree of the project (a base, carried changes, a branch or none, a setup script).',
  })
  @Responds(ThreadDetailSchema, { status: 201 })
  @Fails({
    400: 'The folder is not an existing absolute path, or a worktree cannot be made from it (no git repository, no commits, no base branch), or a branch name is not one.',
    409: 'git could not create the worktree, or the folder cannot switch branch (uncommitted files, a branch a worktree holds, switching turned off).',
  })
  create(@Body({ schema: CreateThreadSchema }) body: z.infer<typeof CreateThreadSchema>): Promise<ThreadDetail> {
    return this.threads.create(body.cwd, body.title, body.worktree, body.local);
  }

  /** Says where a thread without a message runs: the folder on another branch, or a new worktree (the Where row of the new-thread page). */
  @Post('threads/:id/placement')
  @HttpCode(200)
  @ApiOperation({ summary: 'Place a new thread', description: 'Applies the Where row to a thread that has no message yet: switches the folder to a branch, or makes a worktree and moves the thread into it.' })
  @ApiParam(THREAD_ID)
  @Responds(ThreadDetailSchema)
  @Fails({ 400: 'A branch name is not one, or a worktree cannot be made.', 404: NO_THREAD, 409: 'The thread has begun, or the folder cannot switch branch, or git could not make the worktree.' })
  place(@Param('id') id: string, @Body({ schema: ThreadPlacementSchema }) body: z.infer<typeof ThreadPlacementSchema>): Promise<ThreadDetail> {
    return this.threads.place(id, body);
  }

  @Get('threads/:id')
  @ApiOperation({ summary: 'Get a thread', description: 'Returns one thread with the path of its session file.' })
  @ApiParam(THREAD_ID)
  @Responds(ThreadDetailSchema)
  @Fails({ 404: NO_THREAD })
  get(@Param('id') id: string): ThreadDetail {
    return this.threads.open(id);
  }

  /** The user looked at the thread: clears its unread dot and "cli" badge. */
  @Post('threads/:id/seen')
  @HttpCode(204)
  @ApiOperation({ summary: 'Mark a thread as seen', description: 'Clears the thread\'s unread dot and its "cli" badge.' })
  @ApiParam(THREAD_ID)
  @ApiNoContentResponse({ description: 'The thread is marked as seen.' })
  @Fails({ 404: NO_THREAD })
  seen(@Param('id') id: string): void {
    this.threads.markSeen(id);
  }

  @Patch('threads/:id')
  @ApiOperation({ summary: 'Change a thread', description: "Renames, pins or archives a thread. Archiving can also remove the thread's worktree when it is clean." })
  @ApiParam(THREAD_ID)
  @Responds(ThreadDetailSchema)
  @Fails({ 404: NO_THREAD, 409: 'Archiving cannot remove the worktree while it holds uncommitted changes.' })
  patch(@Param('id') id: string, @Body({ schema: PatchThreadSchema }) body: z.infer<typeof PatchThreadSchema>): Promise<ThreadDetail> {
    return this.threads.patch(id, body);
  }

  /** Deletes the thread. `?worktree=remove` also removes its worktree (409 while it holds uncommitted changes), `?worktree=force` whatever it holds; the default keeps it. */
  @Delete('threads/:id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete a thread', description: 'Deletes the thread. Its worktree stays unless `worktree` says `remove` (409 while it holds uncommitted changes) or `force`.' })
  @ApiParam(THREAD_ID)
  @ApiNoContentResponse({ description: 'The thread is deleted.' })
  @Fails({ 404: NO_THREAD, 409: 'A run holds the thread, or its worktree holds uncommitted changes and `worktree` is `remove`.' })
  async remove(@Param('id') id: string, @Query({ schema: DeleteThreadQuerySchema }) query: z.infer<typeof DeleteThreadQuerySchema>): Promise<void> {
    await this.threads.remove(id, query.worktree);
  }

  @Post('threads/:id/fork')
  @ApiOperation({ summary: 'Fork a thread', description: 'Copies the thread into a new one, or only the path from the root to `entryId`, optionally in another folder.' })
  @ApiParam(THREAD_ID)
  @Responds(ThreadDetailSchema, { status: 201 })
  @Fails({ 404: NO_THREAD, 409: 'The thread has no messages to fork yet.' })
  fork(@Param('id') id: string, @Body({ schema: ForkThreadSchema }) body: z.infer<typeof ForkThreadSchema>): Promise<ThreadDetail> {
    return this.threads.fork(id, body);
  }

  @Post('threads/:id/clone')
  @ApiOperation({ summary: 'Clone a thread', description: 'Copies the thread up to `entryId` (the whole thread without it) into a new thread.' })
  @ApiParam(THREAD_ID)
  @Responds(ThreadDetailSchema, { status: 201 })
  @Fails({ 404: 'There is no such thread or entry.', 409: 'The thread has no messages to clone yet.' })
  clone(@Param('id') id: string, @Body({ schema: CloneThreadSchema }) body: z.infer<typeof CloneThreadSchema>): Promise<ThreadDetail> {
    return this.threads.clone(id, body.entryId);
  }

  /** The thumbs up / down the user gave to assistant messages of the thread. */
  @Get('threads/:id/feedback')
  @ApiOperation({ summary: 'List message ratings', description: 'Lists the thumbs up and down given to the assistant messages of the thread.' })
  @ApiParam(THREAD_ID)
  @Responds(FeedbackEntrySchema, { array: true })
  @Fails({ 404: NO_THREAD })
  listFeedback(@Param('id') id: string): FeedbackEntry[] {
    this.threads.assertExists(id);
    return this.feedback.list(id);
  }

  /** Sets, changes or (`rating: null`) clears one message's rating; answers with the thread's ratings. */
  @Put('threads/:id/feedback')
  @ApiOperation({ summary: 'Rate a message', description: "Sets, changes or (with `rating: null`) clears the rating of one message, and answers with the thread's ratings." })
  @ApiParam(THREAD_ID)
  @Responds(FeedbackEntrySchema, { array: true })
  @Fails({ 404: NO_THREAD })
  putFeedback(@Param('id') id: string, @Body({ schema: PutFeedbackSchema }) body: z.infer<typeof PutFeedbackSchema>): FeedbackEntry[] {
    this.threads.assertExists(id);
    this.feedback.set(id, body.messageId, body.rating);
    return this.feedback.list(id);
  }
}
