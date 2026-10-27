import { Module } from '@nestjs/common';
import { PiModule } from '../pi/pi.module';
import { SkillsController } from './skills.controller';

/** The person's own skills: create from the template, edit. */
@Module({ imports: [PiModule], controllers: [SkillsController] })
export class SkillsModule {}
