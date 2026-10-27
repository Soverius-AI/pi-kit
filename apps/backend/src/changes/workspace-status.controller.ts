import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { type WorkspaceStatus, WorkspaceStatusQuerySchema, WorkspaceStatusSchema } from '@pi-kit/protocol';
import type { z } from 'zod';
import { Fails, Responds, WorkspaceIdParam } from '../contract';
import { MetaRepository } from '../db/meta.repository';
import { ChangesService } from './changes.service';

/** The Files panel's decoration. `:id` is the workspace's folder, URL-encoded, as for the rest of `workspaces/:id`. */
@ApiTags('files')
@WorkspaceIdParam()
@Controller('workspaces/:id')
export class WorkspaceStatusController {
  constructor(
    private readonly changes: ChangesService,
    private readonly meta: MetaRepository,
  ) {}

  /** git's badge per changed file, plus (with `thread`) the files pi changed in that thread. */
  @Get('status')
  @ApiOperation({ summary: "Get a folder's git status", description: "Returns git's badge for each changed file of the project, and with `thread` the files pi changed in that thread." })
  @Responds(WorkspaceStatusSchema)
  @Fails({ 404: 'The folder is not a known project.' })
  status(@Param('id') id: string, @Query({ schema: WorkspaceStatusQuerySchema }) query: z.infer<typeof WorkspaceStatusQuerySchema>): Promise<WorkspaceStatus> {
    return this.changes.fileStatus(this.meta.requireWorkspace(id), query.thread || undefined);
  }
}
