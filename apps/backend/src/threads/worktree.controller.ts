import { Body, Controller, Get, HttpCode, NotFoundException, Param, Post } from '@nestjs/common';
import { ApiNoContentResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import {
  WorktreeBranchRequestSchema,
  type WorktreeBranchResult,
  WorktreeBranchResultSchema,
  WorktreeHandoffRequestSchema,
  type WorktreeHandoffResult,
  WorktreeHandoffResultSchema,
  WorktreeMergeRequestSchema,
  type WorktreeMergeResult,
  WorktreeMergeResultSchema,
  type WorktreeMessage,
  WorktreeMessageSchema,
  WorktreeRemoveRequestSchema,
  type WorktreeRemoveResult,
  WorktreeRemoveResultSchema,
  type WorktreeStatus,
  WorktreeStatusSchema,
  WorktreeSyncRequestSchema,
  type WorktreeSyncResult,
  WorktreeSyncResultSchema,
} from '@pi-kit/protocol';
import type { z } from 'zod';
import { Fails, Responds, Remote } from '../contract';
import { ThreadsRepository } from '../db/threads.repository';
import { WorktreeService } from '../worktree/worktree.service';

const NO_WORKTREE = 'There is no such thread, or it does not run in a worktree.';

/** A thread's worktree: where it stands, Sync with base, Merge back, Remove. Each call that changes files waits for the run to be idle. */
@ApiTags('worktrees')
@ApiParam({ name: 'id', description: 'The thread id (the pi session id).', schema: { type: 'string' } })
@Controller('threads/:id/worktree')
export class WorktreeController {
  constructor(
    private readonly worktrees: WorktreeService,
    private readonly threads: ThreadsRepository,
  ) {}

  private async row(id: string) {
    const row = await this.threads.get(id);
    if (!row) throw new NotFoundException(`Thread ${id} not found.`);
    return row;
  }

  /** Branch, base, uncommitted changes, commits ahead and behind, conflicts, and what a merge back would need. */
  @Remote()
  @Get()
  @ApiOperation({
    summary: "Get a worktree's status",
    description:
      'Returns the branch, the base, the uncommitted changes, the commits ahead and behind, the conflicts and what a merge back would need.',
  })
  @Responds(WorktreeStatusSchema)
  @Fails({ 404: NO_WORKTREE })
  async state(@Param('id') id: string): Promise<WorktreeStatus> {
    return await this.worktrees.state(await this.row(id));
  }

  /** The commit message pi-kit proposes for the uncommitted changes. */
  @Remote()
  @Get('message')
  @ApiOperation({
    summary: 'Propose a commit message',
    description: 'Returns the commit message pi-kit proposes for the uncommitted changes of the worktree.',
  })
  @Responds(WorktreeMessageSchema)
  @Fails({ 404: NO_WORKTREE })
  async message(@Param('id') id: string): Promise<WorktreeMessage> {
    return await this.worktrees.message(await this.row(id));
  }

  /** Fetches and brings the base into the branch. A conflict is left in progress in the worktree. */
  @Post('sync')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Sync with the base',
    description:
      'Fetches the remote and brings the base branch into the worktree by merge or rebase. A conflict is left in progress in the worktree.',
  })
  @Responds(WorktreeSyncResultSchema)
  @Fails({
    404: NO_WORKTREE,
    409: 'A run holds the thread, a merge or rebase is waiting, or git could not bring the base in.',
  })
  async sync(
    @Param('id') id: string,
    @Body({ schema: WorktreeSyncRequestSchema }) body: z.infer<typeof WorktreeSyncRequestSchema>,
  ): Promise<WorktreeSyncResult> {
    return await this.worktrees.sync(await this.row(id), body.strategy);
  }

  /** Gives up the merge or rebase that waits in the worktree. */
  @Post('abort')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Abort a merge or rebase',
    description: 'Gives up the merge or rebase that waits in the worktree.',
  })
  @ApiNoContentResponse({ description: 'The merge or rebase is aborted.' })
  @Fails({ 404: NO_WORKTREE, 409: 'A run holds the thread.' })
  async abort(@Param('id') id: string): Promise<void> {
    await this.worktrees.abort(await this.row(id));
  }

  /** Commits the uncommitted changes, then merges into the base or opens a pull request; optionally removes the worktree. */
  @Post('merge')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Merge the worktree back',
    description:
      'Commits the uncommitted changes, then merges the branch into the base or opens a pull request, and optionally removes the worktree.',
  })
  @Responds(WorktreeMergeResultSchema)
  @Fails({
    404: NO_WORKTREE,
    409: 'A run holds the thread, the main checkout is not on the base or has changes, or git could not merge or push.',
  })
  async merge(
    @Param('id') id: string,
    @Body({ schema: WorktreeMergeRequestSchema }) body: z.infer<typeof WorktreeMergeRequestSchema>,
  ): Promise<WorktreeMergeResult> {
    return await this.worktrees.merge(await this.row(id), body);
  }

  /** Removes the worktree folder. A worktree with uncommitted changes needs `force`. */
  @Post('remove')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Remove the worktree',
    description: 'Removes the worktree folder. A worktree with uncommitted changes needs `force`.',
  })
  @Responds(WorktreeRemoveResultSchema)
  @Fails({
    404: NO_WORKTREE,
    409: 'The worktree holds uncommitted changes, another thread runs in it, or git could not remove it.',
  })
  async remove(
    @Param('id') id: string,
    @Body({ schema: WorktreeRemoveRequestSchema }) body: z.infer<typeof WorktreeRemoveRequestSchema>,
  ): Promise<WorktreeRemoveResult> {
    return await this.worktrees.remove(await this.row(id), body);
  }

  /** Moves the thread between the folder and a worktree: `to: local` for a worktree thread, `to: worktree` for a Local one. */
  @Post('handoff')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Hand a thread off',
    description:
      "`to: local` moves a worktree thread's branch and uncommitted changes into the project folder (which must be clean), removes the worktree folder as asked, and the session goes on there. `to: worktree` moves a Local thread into a new worktree cut from the folder's branch, carrying the folder's uncommitted changes.",
  })
  @Responds(WorktreeHandoffResultSchema)
  @Fails({
    400: 'A worktree cannot be made from the folder (no git repository, no commits, a detached HEAD, a bad branch name).',
    404: 'There is no such thread.',
    409: 'A run holds the thread, the folder has uncommitted files (commit or stash them), a merge or rebase is waiting, or the thread is not where the hand off starts.',
  })
  async handoff(
    @Param('id') id: string,
    @Body({ schema: WorktreeHandoffRequestSchema }) body: z.infer<typeof WorktreeHandoffRequestSchema>,
  ): Promise<WorktreeHandoffResult> {
    return await this.worktrees.handoff(await this.row(id), body);
  }

  /** Gives a detached worktree a branch. */
  @Post('branch')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Create a branch in a worktree',
    description: 'Gives a detached worktree a branch ("Create branch here").',
  })
  @Responds(WorktreeBranchResultSchema)
  @Fails({
    400: 'The name is not a branch name.',
    404: NO_WORKTREE,
    409: 'A run holds the thread, the worktree has a branch already, or the name is taken.',
  })
  async branch(
    @Param('id') id: string,
    @Body({ schema: WorktreeBranchRequestSchema }) body: z.infer<typeof WorktreeBranchRequestSchema>,
  ): Promise<WorktreeBranchResult> {
    return await this.worktrees.createBranch(await this.row(id), body.name);
  }
}
