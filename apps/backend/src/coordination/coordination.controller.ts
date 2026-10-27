import { Controller, Get, NotFoundException, Param } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { type Coordination, CoordinationSchema } from '@pi-kit/protocol';
import { Fails, Responds, ThreadIdParam } from '../contract';
import { ThreadsRepository } from '../db/threads.repository';
import { CoordinationService } from './coordination.service';

/** What a thread knows about the agents next to it: the leases other threads hold on files of its folder, and who else is working there. */
@ApiTags('worktrees')
@ThreadIdParam()
@Controller('threads/:id/coordination')
export class CoordinationController {
  constructor(
    private readonly coordination: CoordinationService,
    private readonly threads: ThreadsRepository,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Get what runs next to a thread', description: "Returns the leases other threads hold on files of the thread's folder, and the other agents working there." })
  @Responds(CoordinationSchema)
  @Fails({ 404: 'There is no such thread.' })
  get(@Param('id') id: string): Coordination {
    if (!this.threads.get(id)) throw new NotFoundException(`Thread ${id} not found.`);
    return { leases: this.coordination.leasesFor(id), others: this.coordination.othersInfo(id) };
  }
}
