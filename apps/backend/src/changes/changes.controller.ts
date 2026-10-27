import { Body, Controller, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { ApiNoContentResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import {
  type ChangesList,
  ChangesListSchema,
  ChangesQuerySchema,
  type DiffModel,
  DiffModelSchema,
  PutReviewCommentsSchema,
  RevertRequestSchema,
  type ReviewComment,
  ReviewCommentSchema,
  StageRequestSchema,
  type StageResult,
  StageResultSchema,
} from '@pi-kit/protocol';
import type { z } from 'zod';
import { Fails, Responds, ThreadIdParam } from '../contract';
import { ChangesService } from './changes.service';

const NO_THREAD = 'There is no such thread.';
const NOT_IDLE = 'A run holds the thread: stop it first.';

/**
 * Review mode's REST: the changed files of a thread from one of three sources, the diff model of a
 * file, the pending comment batch, and the file actions. `:file` is the URL-encoded relative path.
 */
@ApiTags('changes')
@ThreadIdParam()
@Controller('threads/:id')
export class ChangesController {
  constructor(private readonly changes: ChangesService) {}

  @Get('changes')
  @ApiOperation({ summary: 'List changed files', description: 'Lists the files pi changed in the thread, or with `source=worktree` the files git reports changed in its folder, or with `source=outcome` the files of the thread outcome (`git diff base..head`).' })
  @Responds(ChangesListSchema)
  @Fails({ 404: NO_THREAD })
  list(@Param('id') id: string, @Query({ schema: ChangesQuerySchema }) query: z.infer<typeof ChangesQuerySchema>): Promise<ChangesList> {
    return this.changes.list(id, query.source);
  }

  @Get('changes/:file')
  @ApiOperation({ summary: 'Get the diff of a file', description: 'Returns the diff of one changed file as hunks with the lines numbered and paired for a split view.' })
  @ApiParam({ name: 'file', description: 'The path of the file relative to the thread folder, URL-encoded.', schema: { type: 'string' } })
  @Responds(DiffModelSchema)
  @Fails({ 404: 'There is no such thread, or pi has not edited the file in it.' })
  file(@Param('id') id: string, @Param('file') file: string, @Query({ schema: ChangesQuerySchema }) query: z.infer<typeof ChangesQuerySchema>): Promise<DiffModel> {
    return this.changes.file(id, query.source, file);
  }

  /** Asks for `confirm: true`: this overwrites the file on disk. */
  @Post('revert')
  @HttpCode(204)
  @ApiOperation({ summary: 'Revert a file', description: 'Restores a file to how it was before pi edited it, or to git HEAD. The body must say `confirm: true`, because this overwrites the file on disk.' })
  @ApiNoContentResponse({ description: 'The file is restored.' })
  @Fails({ 404: 'There is no such thread, or pi has not edited the file in it.', 409: NOT_IDLE + ' Or there is no earlier copy and no git to restore it from.' })
  revert(@Param('id') id: string, @Body({ schema: RevertRequestSchema }) body: z.infer<typeof RevertRequestSchema>): Promise<void> {
    return this.changes.revert(id, body.source, body.file);
  }

  @Post('stage')
  @HttpCode(200)
  @ApiOperation({ summary: 'Stage files', description: "Stages changed files in git's index, or every changed file without `files` for the working tree, and answers with how many were staged." })
  @Responds(StageResultSchema)
  @Fails({ 400: 'The thread source needs the files to stage named.', 404: NO_THREAD, 409: 'The folder is not a git repository.' })
  stage(@Param('id') id: string, @Body({ schema: StageRequestSchema }) body: z.infer<typeof StageRequestSchema>): Promise<StageResult> {
    return this.changes.stage(id, body.source, body.files);
  }

  @Get('review-comments')
  @ApiOperation({ summary: 'List review comments', description: "Lists the pending review comments of the thread, the batch that goes with the next prompt." })
  @Responds(ReviewCommentSchema, { array: true })
  @Fails({ 404: NO_THREAD })
  comments(@Param('id') id: string): ReviewComment[] {
    return this.changes.comments(id);
  }

  @Put('review-comments')
  @HttpCode(204)
  @ApiOperation({ summary: 'Store review comments', description: 'Replaces the pending review comments of the thread with the batch the client holds.' })
  @ApiNoContentResponse({ description: 'The batch is stored.' })
  @Fails({ 404: NO_THREAD })
  putComments(@Param('id') id: string, @Body({ schema: PutReviewCommentsSchema }) body: z.infer<typeof PutReviewCommentsSchema>): void {
    this.changes.putComments(id, body.comments);
  }
}
