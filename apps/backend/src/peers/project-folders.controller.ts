import { Controller, Get, Inject, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { readdir, realpath, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { InstanceIdSchema } from '@pi-kit/protocol';
import type { BackendConfig } from '../app/config';
import { CONFIG } from '../app/config.token';
import { Responds, Remote } from '../contract';
import { InstanceRepository } from '../db/instance.repository';

const QuerySchema = z.object({ directory: z.string().min(1).max(4096).optional() }).strict();
export const ProjectFoldersSchema = z
  .object({
    instanceId: InstanceIdSchema,
    directory: z.string(),
    parent: z.string().nullable(),
    folders: z.array(z.object({ name: z.string(), path: z.string() })),
  })
  .meta({ id: 'ProjectFolders' });

/** Directory names only, evaluated on the chosen execution owner. Opening/trusting a project is separate. */
@ApiTags('instances')
@Controller('project-folders')
export class ProjectFoldersController {
  constructor(
    private readonly instance: InstanceRepository,
    @Inject(CONFIG) private readonly config: BackendConfig,
  ) {}
  @Remote()
  @Get()
  @ApiOperation({
    summary: 'Browse project folders on this instance',
    description:
      'Lists directory names on the authenticated execution owner; never interprets a remote path on the controller machine or loads project resources.',
  })
  @Responds(ProjectFoldersSchema)
  async list(
    @Query({ schema: QuerySchema }) query: z.infer<typeof QuerySchema>,
  ): Promise<z.infer<typeof ProjectFoldersSchema>> {
    const directory = await realpath(resolve(this.config.defaultCwd, query.directory ?? this.config.defaultCwd));
    if (!(await stat(directory)).isDirectory()) throw new Error('Choose a directory.');
    const parent = dirname(directory);
    const folders = (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 500)
      .map((entry) => ({ name: entry.name, path: join(directory, entry.name) }));
    return { instanceId: this.instance.instanceId, directory, parent: parent === directory ? null : parent, folders };
  }
}
