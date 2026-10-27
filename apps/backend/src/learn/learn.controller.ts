import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import {
  ThreadDetailSchema,
  type ThreadDetail,
  type ApproveSkillDraft,
  ApproveSkillDraftSchema,
  type ApprovedSkillDraft,
  ApprovedSkillDraftSchema,
  type RequestSkillDraft,
  RequestSkillDraftSchema,
  type SkillDraft,
  SkillDraftRequestResultSchema,
  type SkillDraftRequestResult,
  SkillDraftSchema,
  type StartVerify,
  StartVerifySchema,
  type VerifyPlan,
  VerifyPlanSchema,
} from '@pi-kit/protocol';
import { Fails, Responds } from '../contract';
import { LearningThreadsService } from './learning-threads.service';
import { LearnService } from './learn.service';
import { VerifyService } from './verify.service';

const DRAFT_ID = { name: 'id', description: 'The draft id, from `draft.id` of a thread state.', schema: { type: 'string' } } as const;

/** Skills learned from finished threads: the draft of a thread, and the person's decision on it. Only `approve` writes a skills folder. */
@ApiTags('learn')
@Controller()
export class LearnController {
  constructor(
    private readonly learn: LearnService,
    private readonly verify: VerifyService,
    private readonly learningThreads: LearningThreadsService,
  ) {}

  @Post('threads/:id/learning-thread')
  @HttpCode(200)
  @ApiParam({ name: 'id', description: 'The source chat to learn from.', schema: { type: 'string' } })
  @ApiOperation({ summary: 'Open a learning chat', description: 'Creates or reopens the persistent learning workspace for a source chat. Drafting, consent and review stay attached to the source; the workspace can be left and reopened from the sidebar.' })
  @Responds(ThreadDetailSchema)
  @Fails({ 404: 'The source chat is gone.', 409: 'Choose an original chat, not a learning or verification workspace.' })
  workspace(@Param('id') id: string): Promise<ThreadDetail> { return this.learningThreads.open(id); }

  @Get('threads/:id/skill-draft')
  @ApiParam({ name: 'id', description: 'The thread id (the pi session id).', schema: { type: 'string' } })
  @ApiOperation({ summary: "Get a thread's skill draft", description: 'Returns the skill drafted from the thread, in whatever state it is in: pending, approved or discarded.' })
  @Responds(SkillDraftSchema)
  @Fails({ 404: 'There is no such thread, or no draft was made for it.' })
  forThread(@Param('id') id: string): SkillDraft {
    return this.learn.forThread(id);
  }

  @Post('threads/:id/skill-draft')
  @HttpCode(200)
  @ApiParam({ name: 'id', description: 'The thread id (the pi session id).', schema: { type: 'string' } })
  @ApiOperation({
    summary: 'Ask for a skill draft',
    description:
      'Drafts a skill from the thread with the attendant’s model and keeps it as pending. A thread has one draft: when it already has one, that one is returned. ' +
      'While the attendant is off, the first request for a thread answers `consent` with the sentence to show and the model’s name; send it again with `consent: true` once the person agreed.',
  })
  @Responds(SkillDraftRequestResultSchema)
  @Fails({ 404: 'There is no such thread.', 409: 'No draft could be made: the learn package is not installed, no model is available, the daily cap is reached, or the model’s answer was not a skill.' })
  request(@Param('id') id: string, @Body({ schema: RequestSkillDraftSchema }) body: RequestSkillDraft): Promise<SkillDraftRequestResult> {
    return this.learn.request(id, body);
  }

  @Get('skill-drafts')
  @ApiOperation({ summary: 'List the pending skill drafts', description: 'Returns every draft that waits for the person to approve or discard it, newest first.' })
  @Responds(SkillDraftSchema, { array: true })
  pending(): SkillDraft[] {
    return this.learn.pending();
  }

  @Post('skill-drafts/:id/approve')
  @HttpCode(200)
  @ApiParam(DRAFT_ID)
  @ApiOperation({
    summary: 'Approve a skill draft',
    description:
      'Writes the skill into `.pi/skills/<name>/` of the project or `skills/<name>/` of the user’s pi folder, with the name, scope and text the person chose, and makes the draft approved. ' +
      'This is the only route that writes a skills folder. It refuses a name that is not a skill name, a text pi would not load, and a name that is taken.',
  })
  @Responds(ApprovedSkillDraftSchema)
  @Fails({ 400: 'The name is not a skill name, or the text is not a skill pi would load.', 404: 'There is no such draft.', 409: 'The draft is not pending, or the name is taken: choose another.' })
  approve(@Param('id') id: string, @Body({ schema: ApproveSkillDraftSchema }) body: ApproveSkillDraft): Promise<ApprovedSkillDraft> {
    return this.learn.approve(id, body);
  }

  @Get('skill-drafts/:id/verify')
  @ApiParam(DRAFT_ID)
  @ApiOperation({
    summary: 'Plan a verification',
    description:
      'Says what a verification of the draft would do: the thread’s first prompt (the one it will send, which the person may edit), the commit it starts from, the files of the outcome it is compared with, ' +
      'the checks of the original thread it runs again, the model, and whether it can start now and, if not, why. The record of the last verification is `verification` of the draft.',
  })
  @Responds(VerifyPlanSchema)
  @Fails({ 404: 'There is no such draft.' })
  plan(@Param('id') id: string): Promise<VerifyPlan> {
    return this.verify.plan(id);
  }

  @Post('skill-drafts/:id/verify')
  @HttpCode(200)
  @ApiParam(DRAFT_ID)
  @ApiOperation({
    summary: 'Verify a skill draft by replaying it',
    description:
      'Makes a scratch worktree at the outcome’s base commit, starts a thread there with the draft pinned as a skill and the thread’s first prompt, and, when it is done, compares the result with the outcome ' +
      '(files and hunks, a similarity score) and runs the original thread’s checks again. Answers at once with the draft, whose `verification` is `running`; read it again (or the thread state) for the report. ' +
      '`text` and `name` are the person’s edits in the dialog (a pending draft only); `prompt` replaces the first prompt. Nothing is pushed or merged, the main checkout is not touched, and the scratch worktree is removed afterwards.',
  })
  @Responds(SkillDraftSchema)
  @Fails({ 400: 'The edited text is not a skill pi would load.', 404: 'There is no such draft.', 409: 'The draft cannot be verified now: no outcome, discarded, another verification is running, or the commits are gone.' })
  start(@Param('id') id: string, @Body({ schema: StartVerifySchema }) body: StartVerify): Promise<SkillDraft> {
    return this.verify.start(id, body);
  }

  @Post('skill-drafts/:id/verify/stop')
  @HttpCode(200)
  @ApiParam(DRAFT_ID)
  @ApiOperation({ summary: 'Stop a verification', description: 'Aborts the replay’s run; the verification ends as `stopped` and the scratch worktree is removed. The verification thread can also be stopped like any thread.' })
  @Responds(SkillDraftSchema)
  @Fails({ 404: 'There is no such draft.', 409: 'The draft is not being verified.' })
  stop(@Param('id') id: string): SkillDraft {
    return this.verify.stop(id);
  }

  @Post('skill-drafts/:id/discard')
  @HttpCode(200)
  @ApiParam(DRAFT_ID)
  @ApiOperation({ summary: 'Discard a skill draft', description: 'Records the decision and writes nothing. The thread is not drafted again; the draft can be reopened.' })
  @Responds(SkillDraftSchema)
  @Fails({ 404: 'There is no such draft.', 409: 'The draft is not pending.' })
  discard(@Param('id') id: string): SkillDraft {
    return this.learn.discard(id);
  }

  @Post('skill-drafts/:id/reopen')
  @HttpCode(200)
  @ApiParam(DRAFT_ID)
  @ApiOperation({ summary: 'Reopen a discarded skill draft', description: 'Makes a discarded draft pending again, so it can be read and approved.' })
  @Responds(SkillDraftSchema)
  @Fails({ 404: 'There is no such draft.', 409: 'The draft is not discarded.' })
  reopen(@Param('id') id: string): SkillDraft {
    return this.learn.reopen(id);
  }
}
