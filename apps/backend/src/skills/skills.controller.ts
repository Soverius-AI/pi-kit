import { existsSync } from 'node:fs';
import { BadRequestException, Body, ConflictException, Controller, Get, HttpCode, Inject, Post, Put, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CwdQuerySchema, type NewSkill, NewSkillSchema, type SkillFile, type SkillFilePut, SkillFilePutSchema, SkillFileQuerySchema, SkillFileSchema } from '@pi-kit/protocol';
import type { z } from 'zod';
import type { BackendConfig } from '../app/config';
import { CONFIG } from '../app/config.token';
import { Fails, Responds } from '../contract';
import { PiSessionService } from '../pi/pi-session.service';
import { TrustService } from '../pi/trust.service';
import { ChangedError, createSkill, readSkill, saveSkill } from './skill-editor';

/** Your own skills: "+" on Your skills makes a folder from the template, and the editor dialog reads and saves its `SKILL.md`. */
@ApiTags('skills')
@Controller('skills')
export class SkillsController {
  constructor(
    private readonly sessions: PiSessionService,
    private readonly trust: TrustService,
    @Inject(CONFIG) private readonly backend: BackendConfig,
  ) {}

  private cwdOf(cwd: string | undefined): string {
    return cwd && existsSync(cwd) ? cwd : this.backend.defaultCwd;
  }

  @Post()
  @HttpCode(200)
  @ApiOperation({ summary: 'Create a skill', description: "Makes a skill folder with a SKILL.md from the template, in the user's skills folder or the project's `.pi/skills` (a trusted folder), and answers with the file for the editor." })
  @Responds(SkillFileSchema)
  @Fails({ 400: 'The name is not a skill name.', 409: 'A skill of that name exists, or the folder is not trusted.' })
  async create(@Query({ schema: CwdQuerySchema }) query: z.infer<typeof CwdQuerySchema>, @Body({ schema: NewSkillSchema }) body: NewSkill): Promise<SkillFile> {
    const cwd = this.cwdOf(query.cwd);
    if (body.scope === 'project' && !(await this.trust.folderTrusted(cwd))) throw new ConflictException('This folder is not trusted yet, so pi would not read its .pi/skills. Trust the folder first.');
    try {
      return createSkill({ name: body.name, scope: body.scope, agentDir: await this.sessions.agentDir(), cwd });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw /exists already/.test(message) ? new ConflictException(message) : new BadRequestException(message);
    }
  }

  @Get('file')
  @ApiOperation({ summary: 'Read a skill file', description: "Returns the text of one of your skills' SKILL.md and its modified time. Any other path is refused." })
  @Responds(SkillFileSchema)
  @Fails({ 400: 'That is not the file of one of your skills.' })
  async read(@Query({ schema: SkillFileQuerySchema }) query: z.infer<typeof SkillFileQuerySchema>): Promise<SkillFile> {
    try {
      return readSkill(query.path, await this.sessions.agentDir(), this.cwdOf(query.cwd));
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : String(error));
    }
  }

  @Put('file')
  @ApiOperation({ summary: 'Save a skill file', description: 'Saves the text of one of your skills when pi can load it and the file has not changed since `mtime`.' })
  @Responds(SkillFileSchema)
  @Fails({ 400: 'The text is not a skill pi can load, or the path is not one of your skills.', 409: 'The file changed since it was opened.' })
  async save(@Query({ schema: SkillFileQuerySchema }) query: z.infer<typeof SkillFileQuerySchema>, @Body({ schema: SkillFilePutSchema }) body: SkillFilePut): Promise<SkillFile> {
    try {
      return saveSkill({ path: query.path, text: body.text, mtime: body.mtime, agentDir: await this.sessions.agentDir(), cwd: this.cwdOf(query.cwd) });
    } catch (error) {
      if (error instanceof ChangedError) throw new ConflictException(error.message);
      throw new BadRequestException(error instanceof Error ? error.message : String(error));
    }
  }
}
