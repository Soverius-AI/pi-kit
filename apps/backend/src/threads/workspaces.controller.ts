import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put } from '@nestjs/common';
import { ApiNoContentResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { OpenWorkspaceSchema, PatchWorkspaceSchema, PatchWorktreeDefaultsSchema, type ProjectGit, ProjectGitSchema, type Workspace, WorkspaceOrderSchema, WorkspaceSchema, type WorktreeDefaults, WorktreeDefaultsSchema } from '@pi-kit/protocol';
import type { z } from 'zod';
import { Fails, Responds, WorkspaceIdParam } from '../contract';
import { MetaRepository } from '../db/meta.repository';
import { WorktreeService } from '../worktree/worktree.service';
import { ThreadsService } from './threads.service';

/** The projects of the sidebar: the folders pi-kit knows, their flags and their order. */
@ApiTags('workspaces')
@Controller('workspaces')
export class WorkspacesController {
  constructor(
    private readonly threads: ThreadsService,
    private readonly worktrees: WorktreeService,
    private readonly meta: MetaRepository,
  ) {}

  /** What the Where row of the new-thread page shows about the project's folder: the checked-out branch, the changed files, the branches and who holds them. */
  @Get(':id/git')
  @WorkspaceIdParam()
  @ApiOperation({ summary: "Get a project's branches", description: 'Returns the checked-out branch, the number of changed files, the local branches with the worktree that holds each, and the remote branches. `git: false` for a folder that is not a repository.' })
  @Responds(ProjectGitSchema)
  @Fails({ 404: 'The folder is not a known project.' })
  git(@Param('id') id: string): Promise<ProjectGit> {
    return this.worktrees.projectGit(this.meta.requireWorkspace(id));
  }

  /** The defaults for every project: where worktrees go and where a new thread starts. */
  @Get('defaults')
  @ApiOperation({ summary: 'Get the defaults for every project', description: 'Returns where worktrees are made and where a new thread starts for every project that does not say otherwise.' })
  @Responds(WorktreeDefaultsSchema)
  defaults(): WorktreeDefaults {
    return this.worktrees.defaults();
  }

  @Patch('defaults')
  @ApiOperation({ summary: 'Change the defaults for every project', description: 'Changes the worktree folder and the start mode that projects without their own setting use, and answers with the defaults.' })
  @Responds(WorktreeDefaultsSchema)
  patchDefaults(@Body({ schema: PatchWorktreeDefaultsSchema }) body: z.infer<typeof PatchWorktreeDefaultsSchema>): WorktreeDefaults {
    return this.worktrees.patchDefaults(body);
  }

  @Get()
  @ApiOperation({ summary: 'List projects', description: 'Lists the known project folders with their sidebar flags and thread counts.' })
  @Responds(WorkspaceSchema, { array: true })
  workspaces(): Workspace[] {
    return this.threads.workspaces();
  }

  /** One project's sidebar flags (folded, hidden, the attendant's and the background agents' opt-outs) or its worktree settings; answers with the projects. */
  @Patch()
  @ApiOperation({ summary: 'Change a project', description: "Changes one project's sidebar flags (folded, hidden, the attendant's and the background agents' opt-outs) or its worktree settings, and answers with the projects." })
  @Responds(WorkspaceSchema, { array: true })
  @Fails({ 404: 'The folder is not a known project.' })
  patchWorkspace(@Body({ schema: PatchWorkspaceSchema }) body: z.infer<typeof PatchWorkspaceSchema>): Workspace[] {
    return this.threads.patchWorkspace(body);
  }

  /** The order of the sidebar's project groups; answers with the projects. */
  @Put('order')
  @ApiOperation({ summary: 'Reorder projects', description: "Sets the order of the sidebar's project groups, and answers with the projects." })
  @Responds(WorkspaceSchema, { array: true })
  orderWorkspaces(@Body({ schema: WorkspaceOrderSchema }) body: z.infer<typeof WorkspaceOrderSchema>): Workspace[] {
    return this.threads.orderWorkspaces(body.order);
  }

  /** Takes a project off the sidebar and the list of projects; its threads and files stay (Settings › Projects › Forget). */
  @Delete(':id')
  @WorkspaceIdParam()
  @ApiOperation({ summary: 'Forget a project', description: "Removes a project from the sidebar and the list of projects. Its threads, session files and folder are not touched, and its settings are kept for when the folder is opened again. Answers with the remaining projects." })
  @Responds(WorkspaceSchema, { array: true })
  @Fails({ 404: 'The folder is not a known project.', 409: 'A run is going in the project.' })
  forgetWorkspace(@Param('id') id: string): Workspace[] {
    return this.threads.forgetWorkspace(id);
  }

  /** Opens a folder as a project (the sidebar's "Add project", Settings › Projects, onboarding). */
  @Post()
  @HttpCode(204)
  @ApiOperation({ summary: 'Open a project', description: 'Adds a folder to the known projects.' })
  @ApiNoContentResponse({ description: 'The folder is a known project.' })
  @Fails({ 400: 'The folder is not an existing absolute path.' })
  addWorkspace(@Body({ schema: OpenWorkspaceSchema }) body: z.infer<typeof OpenWorkspaceSchema>): void {
    this.threads.addWorkspace(body.cwd);
  }
}
