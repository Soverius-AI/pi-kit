import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { type LearnedSkill, LearnedSkillDetailSchema, type LearnedSkillDetail, LearnedSkillSchema, type SaveLearnedSkill, SaveLearnedSkillSchema } from '@pi-kit/protocol';
import { Fails, Responds } from '../contract';
import { LearnedSkillsService } from './learned-skills.service';

const SKILL_ID = { name: 'id', description: 'The learned skill’s id: the id of the draft it was approved from.', schema: { type: 'string' } } as const;

/** The record of the skills learned from finished threads: uses, outcomes, the last verification, and Re-verify, Edit, Retire. */
@ApiTags('learn')
@Controller('skills/learned')
export class LearnedSkillsController {
  constructor(private readonly learned: LearnedSkillsService) {}

  @Get()
  @ApiOperation({
    summary: 'List the learned skills',
    description:
      'Returns every skill approved from a draft, retired ones included (`retiredAt`), with where it was learned from, how often prompts used it, how many of those uses were followed by a merged outcome, ' +
      'its last verification and a flag when its last three threads all ended without an outcome (or it failed a verification and none of them merged).',
  })
  @Responds(LearnedSkillSchema, { array: true })
  list(): LearnedSkill[] {
    return this.learned.list();
  }

  @Get(':id')
  @ApiParam(SKILL_ID)
  @ApiOperation({ summary: 'Get a learned skill', description: 'The record of one learned skill and its `SKILL.md` as it is on disk now (in `.retired/` while it is retired), for the edit dialog.' })
  @Responds(LearnedSkillDetailSchema)
  @Fails({ 404: 'There is no such learned skill.' })
  get(@Param('id') id: string): LearnedSkillDetail {
    return this.learned.detail(id);
  }

  @Post(':id/retire')
  @HttpCode(200)
  @ApiParam(SKILL_ID)
  @ApiOperation({
    summary: 'Retire a learned skill',
    description:
      'Moves the skill’s folder to `.pi/skills/.retired/<name>/` (the user scope: `<agent dir>/skills/.retired/`), records the retirement on the draft and makes open sessions read their skills again, ' +
      'so the skill is gone from the `/` menu and the chips. Nothing is deleted; `unretire` moves it back.',
  })
  @Responds(LearnedSkillSchema)
  @Fails({ 404: 'There is no such learned skill.', 409: 'The skill is retired already, is being verified, or its folder is not where pi-kit wrote it.' })
  retire(@Param('id') id: string): Promise<LearnedSkill> {
    return this.learned.retire(id);
  }

  @Post(':id/unretire')
  @HttpCode(200)
  @ApiParam(SKILL_ID)
  @ApiOperation({ summary: 'Restore a retired learned skill', description: 'Moves the folder back out of `.retired/` and makes open sessions read their skills again.' })
  @Responds(LearnedSkillSchema)
  @Fails({ 404: 'There is no such learned skill.', 409: 'The skill is not retired, its place is taken, or pi lists a skill of that name now.' })
  unretire(@Param('id') id: string): Promise<LearnedSkill> {
    return this.learned.unretire(id);
  }

  @Post(':id/reverify')
  @HttpCode(200)
  @ApiParam(SKILL_ID)
  @ApiOperation({
    summary: 'Verify a learned skill again',
    description:
      'Replays the skill as the file is now from its thread’s base commit, exactly like verifying a draft (`POST /api/skill-drafts/{id}/verify`; stop it with `…/verify/stop`). Answers at once with the skill, whose ' +
      '`verification.state` is `running`. The draft stays approved; the report lands in the draft’s `verification` and in the file’s `x-pi-kit.verified`.',
  })
  @Responds(LearnedSkillSchema)
  @Fails({ 404: 'There is no such learned skill.', 409: 'The skill is retired, or cannot be verified now: no outcome, another verification is running, or the commits are gone.' })
  reverify(@Param('id') id: string): Promise<LearnedSkill> {
    return this.learned.reverify(id);
  }

  @Post(':id/save')
  @HttpCode(200)
  @ApiParam(SKILL_ID)
  @ApiOperation({
    summary: 'Save an edited learned skill',
    description:
      'Writes the edited `SKILL.md` over the skill’s file. The name and folder stay; the text must be a skill pi loads; the provenance is stamped again and the `verified` block states a result only for a replay of exactly this text. ' +
      'Open sessions read their skills again.',
  })
  @Responds(LearnedSkillSchema)
  @Fails({ 400: 'The text is not a skill pi would load under that name.', 404: 'There is no such learned skill.', 409: 'The skill is retired, is being verified, or its file is gone.' })
  save(@Param('id') id: string, @Body({ schema: SaveLearnedSkillSchema }) body: SaveLearnedSkill): Promise<LearnedSkill> {
    return this.learned.save(id, body);
  }
}
