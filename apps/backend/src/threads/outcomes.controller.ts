import { Controller, Get, NotFoundException, Param } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { type ThreadOutcome, ThreadOutcomeSchema } from '@pi-kit/protocol';
import { Fails, Responds, ThreadIdParam } from '../contract';
import { OutcomesService } from './outcomes.service';
import { ThreadsService } from './threads.service';

/** How a thread ended. The Outcome diff itself is `GET /api/threads/:id/changes?source=outcome`. */
@ApiTags('threads')
@ThreadIdParam()
@Controller('threads/:id/outcome')
export class OutcomesController {
  constructor(
    private readonly outcomes: OutcomesService,
    private readonly threads: ThreadsService,
  ) {}

  @Get()
  @ApiOperation({
    summary: "Get a thread's outcome",
    description:
      'Returns how the thread ended: merged back from its worktree, a pull request opened for its branch, or commits made in its folder that contain files it changed. ' +
      'It carries the base and head commits (the Outcome source of review mode is `git diff base..head`), the files and, for a merge or a pull request, the merge commit or the address.',
  })
  @Responds(ThreadOutcomeSchema)
  @Fails({ 404: 'There is no such thread, or it has no outcome yet.' })
  get(@Param('id') id: string): ThreadOutcome {
    this.threads.assertExists(id);
    const outcome = this.outcomes.get(id);
    if (!outcome) throw new NotFoundException('This thread has no outcome yet.');
    return outcome;
  }
}
