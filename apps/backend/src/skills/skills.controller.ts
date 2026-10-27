import { existsSync } from 'node:fs';
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  CwdQuerySchema,
  DeleteSkillSchema,
  InstallSkillSchema,
  type InstallSkill,
  SkillActionResultSchema,
  type SkillActionResult,
  SkillDetailQuerySchema,
  SkillDetailSchema,
  type SkillDetail,
  SkillSearchQuerySchema,
  SkillSearchResponseSchema,
  type SkillSearchResponse,
  type SkillFile,
  SkillFileQuerySchema,
  SkillFileSchema,
} from '@pi-kit/protocol';
import type { z } from 'zod';
import { DEFAULT_SKILLS_CONFIG, type BackendConfig } from '../app/config';
import { CONFIG } from '../app/config.token';
import { Fails, Responds } from '../contract';
import { PiSessionService } from '../pi/pi-session.service';
import { TrustService } from '../pi/trust.service';
import { ChangedError, ManagedSkillConflict, deleteSkill, locateSkill, readSkill } from './managed-skills';
import { installSkill, previewSkill, SkillInstallConflict } from './skill-installer';
import { SkillCatalog } from './skills-search';

@ApiTags('skills')
@Controller('skills')
export class SkillsController {
  constructor(
    private readonly sessions: PiSessionService,
    private readonly trust: TrustService,
    @Inject(CONFIG) private readonly backend: BackendConfig,
    private readonly catalog: SkillCatalog,
  ) {}

  private cwdOf(cwd: string | undefined): string {
    return cwd && existsSync(cwd) ? cwd : this.backend.defaultCwd;
  }

  @Get('search')
  @ApiOperation({
    summary: 'Search installable skills',
    description:
      'Searches the skills.sh catalog for public GitHub skills. Queries are sent to the third-party catalog; no install telemetry is emitted.',
  })
  @Responds(SkillSearchResponseSchema)
  async search(
    @Query({ schema: SkillSearchQuerySchema }) query: z.infer<typeof SkillSearchQuerySchema>,
  ): Promise<SkillSearchResponse> {
    return this.catalog.search(query.q);
  }

  @Get('detail')
  @ApiOperation({
    summary: 'Preview a skill from GitHub',
    description:
      'Reads the selected skill’s real description, instructions, metadata, and file summary from a bounded temporary checkout. No skill is installed or executed.',
  })
  @Responds(SkillDetailSchema)
  @Fails({ 400: 'The skill cannot be previewed.', 409: 'The selected skill name is ambiguous.' })
  async detail(
    @Query({ schema: SkillDetailQuerySchema }) query: z.infer<typeof SkillDetailQuerySchema>,
  ): Promise<SkillDetail> {
    if (this.backend.skills?.offline ?? DEFAULT_SKILLS_CONFIG.offline)
      throw new BadRequestException('Skill preview is unavailable in offline mode.');
    try {
      return await previewSkill(query, this.backend.skills);
    } catch (error) {
      if (error instanceof SkillInstallConflict) throw new ConflictException(error.message);
      throw new BadRequestException(error instanceof Error ? error.message : String(error));
    }
  }

  @Post('install')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Install a skill from GitHub',
    description:
      'Copies one selected skill and supporting files without installing dependencies or enabling extensions.',
  })
  @Responds(SkillActionResultSchema)
  @Fails({
    400: 'Invalid source or skill, or installation failed.',
    409: 'The skill exists or the project is not trusted.',
  })
  async install(
    @Query({ schema: CwdQuerySchema }) query: z.infer<typeof CwdQuerySchema>,
    @Body({ schema: InstallSkillSchema }) body: InstallSkill,
  ): Promise<SkillActionResult> {
    const cwd = this.cwdOf(query.cwd);
    if (body.scope === 'project' && !(await this.trust.folderTrusted(cwd)))
      throw new ConflictException('Trust this folder before installing project skills.');
    if (this.backend.skills?.offline ?? DEFAULT_SKILLS_CONFIG.offline)
      throw new BadRequestException('Skill installation is unavailable in offline mode.');
    try {
      await installSkill({ ...body, agentDir: await this.sessions.agentDir(), cwd }, this.backend.skills);
    } catch (error) {
      if (error instanceof SkillInstallConflict) throw new ConflictException(error.message);
      throw new BadRequestException(error instanceof Error ? error.message : String(error));
    }
    const reloaded = await this.sessions.reloadIdleSessions();
    return { message: `Installed ${body.name}.`, reloaded };
  }

  @Delete('file')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Delete an individually managed skill',
    description:
      'Removes the whole skill folder. Bundled, package, symlinked, and learned skills cannot be deleted here.',
  })
  @Responds(SkillActionResultSchema)
  @Fails({
    400: 'That is not a deletable skill.',
    409: 'The skill changed, is learned, or the project is not trusted.',
  })
  async remove(
    @Query({ schema: SkillFileQuerySchema }) query: z.infer<typeof SkillFileQuerySchema>,
    @Body({ schema: DeleteSkillSchema }) body: z.infer<typeof DeleteSkillSchema>,
  ): Promise<SkillActionResult> {
    const cwd = this.cwdOf(query.cwd);
    const agentDir = await this.sessions.agentDir();
    const where = locateSkill(query.path, agentDir, cwd);
    if (!where) throw new BadRequestException('That is not an individually managed skill.');
    if (where.scope === 'project' && !(await this.trust.folderTrusted(cwd)))
      throw new ConflictException('Trust this folder before deleting project skills.');
    try {
      await deleteSkill({ path: query.path, mtime: body.mtime, agentDir, cwd });
    } catch (error) {
      if (error instanceof ChangedError || error instanceof ManagedSkillConflict)
        throw new ConflictException(error.message);
      throw new BadRequestException(error instanceof Error ? error.message : String(error));
    }
    return { message: `Deleted ${where.name}.`, reloaded: await this.sessions.reloadIdleSessions() };
  }

  @Get('file')
  @ApiOperation({
    summary: 'Read a skill file',
    description: "Returns the text of one of your skills' SKILL.md and its modified time. Any other path is refused.",
  })
  @Responds(SkillFileSchema)
  @Fails({ 400: 'That is not the file of one of your skills.' })
  async read(@Query({ schema: SkillFileQuerySchema }) query: z.infer<typeof SkillFileQuerySchema>): Promise<SkillFile> {
    try {
      return readSkill(query.path, await this.sessions.agentDir(), this.cwdOf(query.cwd));
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : String(error));
    }
  }
}
