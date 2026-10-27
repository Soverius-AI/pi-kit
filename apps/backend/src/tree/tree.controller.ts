import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import {
  type EntryText,
  EntryTextSchema,
  flagOn,
  LabelRequestSchema,
  type NavigateResult,
  NavigateRequestSchema,
  NavigateResultSchema,
  RawSessionTreeSchema,
  SessionTreeSchema,
  type RawSessionTree,
  type SessionTree,
  SummarizeBranchRequestSchema,
  TreeQuerySchema,
} from '@pi-kit/protocol';
import type { z } from 'zod';
import { Fails, Responds, ThreadIdParam } from '../contract';
import { TreeService } from './tree.service';

const NO_THREAD = 'There is no such thread.';
const NO_ENTRY = 'There is no such thread or entry.';
const NOT_IDLE = 'A run holds the thread: stop it first.';

/** The session graph over REST. The transcript of a branch is AG-UI, as everything conversational. */
@ApiTags('tree')
@ThreadIdParam()
@Controller('threads/:id')
export class TreeController {
  constructor(private readonly tree: TreeService) {}

  @Get('tree')
  @ApiOperation({
    summary: 'Get the session tree',
    description: "Returns the thread's turns in display order with the lane of each already assigned. With `raw=1` it returns pi's entries as they are in the session file instead.",
  })
  @Responds(SessionTreeSchema.or(RawSessionTreeSchema))
  @Fails({ 404: NO_THREAD })
  get(@Param('id') id: string, @Query({ schema: TreeQuerySchema }) query: z.infer<typeof TreeQuerySchema>): Promise<SessionTree | RawSessionTree> {
    return flagOn(query.raw) ? this.tree.raw(id) : this.tree.tree(id);
  }

  @Get('entries/:entryId')
  @ApiOperation({ summary: 'Get an entry', description: 'Returns the role and text of one entry of the session, for "Edit and branch".' })
  @ApiParam({ name: 'entryId', description: 'The pi entry id.', schema: { type: 'string' } })
  @Responds(EntryTextSchema)
  @Fails({ 404: NO_ENTRY })
  entry(@Param('id') id: string, @Param('entryId') entryId: string): Promise<EntryText> {
    return this.tree.entryText(id, entryId);
  }

  /** Moves the leaf, resets the transcript to the branch (a snapshot in the replay log) and announces `pi.tree`. */
  @Post('navigate')
  @ApiOperation({ summary: 'Go to an entry', description: 'Moves the leaf of the session to an entry, optionally with a summary of the branch being left, and resets the transcript to that branch.' })
  @Responds(NavigateResultSchema, { status: 201 })
  @Fails({ 404: NO_ENTRY, 409: NOT_IDLE })
  navigate(@Param('id') id: string, @Body({ schema: NavigateRequestSchema }) body: z.infer<typeof NavigateRequestSchema>): Promise<NavigateResult> {
    const { targetId, summarize, instructions } = body;
    return this.tree.navigate(id, targetId, { summarize, instructions });
  }

  /** "Summarize branch": `navigate` with a model-written summary of the branch being left, attached at the target. */
  @Post('summarize-branch')
  @ApiOperation({ summary: 'Summarize a branch', description: 'Moves the leaf to an entry like `navigate`, with a model-written summary of the branch being left attached at the target.' })
  @Responds(NavigateResultSchema, { status: 201 })
  @Fails({ 404: NO_ENTRY, 409: NOT_IDLE })
  summarize(@Param('id') id: string, @Body({ schema: SummarizeBranchRequestSchema }) body: z.infer<typeof SummarizeBranchRequestSchema>): Promise<NavigateResult> {
    return this.tree.navigate(id, body.targetId, { summarize: true, instructions: body.instructions });
  }

  @Post('label')
  @ApiOperation({ summary: 'Label an entry', description: 'Sets or, with an empty label, clears the label of an entry, and answers with the tree.' })
  @Responds(SessionTreeSchema, { status: 201 })
  @Fails({ 404: NO_ENTRY })
  label(@Param('id') id: string, @Body({ schema: LabelRequestSchema }) body: z.infer<typeof LabelRequestSchema>): Promise<SessionTree> {
    return this.tree.label(id, body.targetId, body.label);
  }
}
