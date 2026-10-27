import { Module } from '@nestjs/common';
import { AguiModule } from '../agui/agui.module';
import { AttendantModule } from '../attendant/attendant.module';
import { DbModule } from '../db/db.module';
import { PiModule } from '../pi/pi.module';
import { ThreadsModule } from '../threads/threads.module';
import { LearningThreadsService } from './learning-threads.service';
import { LearnController } from './learn.controller';
import { LearnPackage } from './learn-package';
import { LearnService } from './learn.service';
import { LearnedSkillsController } from './learned-skills.controller';
import { LearnedSkillsService } from './learned-skills.service';
import { VerifyService } from './verify.service';

/** Skills learned from finished threads: the plugin API's host, the drafts, the approval, the verification by replay, and the record of the learned skills. */
@Module({
  imports: [DbModule, PiModule, ThreadsModule, AttendantModule, AguiModule],
  controllers: [LearnController, LearnedSkillsController],
  providers: [LearningThreadsService, LearnService, LearnPackage, VerifyService, LearnedSkillsService],
  exports: [LearnService, VerifyService, LearnedSkillsService],
})
export class LearnModule {}
