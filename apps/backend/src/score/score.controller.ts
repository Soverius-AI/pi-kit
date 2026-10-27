import { Body, Controller, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import {
  type OutcomeScoreView,
  OutcomeScoreViewSchema,
  type RelabelHunk,
  RelabelHunkSchema,
  type RequestScore,
  RequestScoreSchema,
  type ScoreOverview,
  ScoreOverviewSchema,
  type ScoreRequestResult,
  ScoreRequestResultSchema,
} from '@pi-kit/protocol';
import type { Request } from 'express';
import { Fails, Responds } from '../contract';
import { ScoreService } from './score.service';

const THREAD_ID = { name: 'id', description: 'The thread id (the pi session id).', schema: { type: 'string' } } as const;

/**
 * The Meat Proxy Score and the Vibe Score: the score of a thread's outcome with the label of every hunk, scoring now, the person's relabelling of a hunk, and the
 * per-project distribution. Nothing is answered while the `@pi-kit/meat-proxy` package is not installed in pi.
 */
@ApiTags('score')
@Controller()
export class ScoreController {
  constructor(private readonly score: ScoreService) {}

  @Get('threads/:id/score')
  @ApiParam(THREAD_ID)
  @ApiOperation({
    summary: "Get a thread's score",
    description:
      'Returns the Meat Proxy Score and the Vibe Score of the thread’s outcome with their inputs, and the label of every hunk of the outcome diff (specified, corrected, autonomous or manual) with what it traces to, ' +
      'as they stand now (the person’s corrections included). `stale` says the outcome moved on since the hunks were labelled.',
  })
  @Responds(OutcomeScoreViewSchema)
  @Fails({ 404: 'There is no such thread, it has not been scored, or the meat-proxy package is not installed.' })
  get(@Param('id') id: string): OutcomeScoreView {
    return this.score.view(id);
  }

  @Post('threads/:id/score')
  @HttpCode(200)
  @ApiParam(THREAD_ID)
  @ApiOperation({
    summary: 'Score a thread now',
    description:
      'Labels every hunk of the thread’s outcome with the attendant’s model and computes the scores. While the attendant is off, the first request for a thread answers `consent` with the sentence to show and the model’s name; ' +
      'send it again with `consent: true` once the person agreed. Scoring again replaces the model’s labels and keeps the person’s corrections.',
  })
  @Responds(ScoreRequestResultSchema)
  @Fails({ 404: 'There is no such thread.', 409: 'No score could be made: the package is not installed, the thread has no outcome, no model is available, the daily cap is reached, or the model’s answer did not label every requested hunk.' })
  async request(@Param('id') id: string, @Body({ schema: RequestScoreSchema }) body: RequestScore, @Req() req: Request): Promise<ScoreRequestResult> {
    // The scoring lives as long as the client waits for it: a connection that closes first (the app went away, the person quit) aborts the model call, and nothing is stored.
    // Watched on the connection, not the request: Node destroys the request stream as soon as its JSON body is consumed, so `req`'s own `close` has fired before this runs.
    // The listener is gone before the answer is written, so the close that follows every finished response cancels nothing.
    const cancelled = new AbortController();
    const cancel = (): void => cancelled.abort();
    const { socket } = req;
    if (socket.destroyed) cancel();
    else socket.once('close', cancel);
    try {
      return await this.score.request(id, body, cancelled.signal);
    } finally {
      socket.off('close', cancel);
    }
  }

  @Post('threads/:id/score/relabel')
  @HttpCode(200)
  @ApiParam(THREAD_ID)
  @ApiOperation({
    summary: 'Relabel a hunk',
    description:
      'The person says what a hunk of the outcome is. The score is computed again from the labels as they stand; the correction is kept and shown to the model as an example the next time the thread is scored. ' +
      '`label: null` takes a correction back.',
  })
  @Responds(OutcomeScoreViewSchema)
  @Fails({ 400: 'The outcome has no changed lines to weigh.', 404: 'There is no such thread, it has not been scored, or its outcome has no such hunk.', 409: 'The meat-proxy package is not installed.' })
  relabel(@Param('id') id: string, @Body({ schema: RelabelHunkSchema }) body: RelabelHunk): Promise<OutcomeScoreView> {
    return this.score.relabel(id, body.hunk, body.label);
  }

  @Get('scores')
  @ApiOperation({
    summary: 'Get the score distribution of every project',
    description: 'Returns, per project, how many scored threads fall in each tenth of the steered share, their average and the newest ones. Empty while the meat-proxy package is not installed.',
  })
  @Responds(ScoreOverviewSchema)
  overview(): ScoreOverview {
    return this.score.overview();
  }
}
