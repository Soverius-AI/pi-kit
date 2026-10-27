import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { type Health, HealthSchema } from '@pi-kit/protocol';
import { BgAgentsService } from '../bg-agents/bg-agents.service';
import { Responds } from '../contract';
import { BOOT_ID, STARTED_AT } from './boot';

/** `GET /api/health`: the backend is up, its boot id and start time, and whether it runs background agents. */
@ApiTags('app')
@Controller('health')
export class HealthController {
  constructor(private readonly agents: BgAgentsService) {}

  @Get()
  @ApiOperation({ summary: 'Check the backend', description: 'Answers that the backend is up, with the id of this process and when it started, and whether this backend runs background agents (a second backend on the same data folder does not). A client that sees the boot id change knows the backend restarted.' })
  @Responds(HealthSchema)
  health(): Health {
    return { status: 'ok', bootId: BOOT_ID, startedAt: STARTED_AT, pid: process.pid, backgroundAgents: this.agents.state() };
  }
}
