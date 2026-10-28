import { Module } from '@nestjs/common';
import { AttendantModule } from '../attendant/attendant.module';
import { DbModule } from '../db/db.module';
import { LearnModule } from '../learn/learn.module';
import { PiModule } from '../pi/pi.module';
import { ThreadsModule } from '../threads/threads.module';
import { SnapshotsModule } from '../snapshots/snapshots.module';
import { MeatProxyPackage } from './meat-proxy-package';
import { DialogAnswersService } from './dialog-answers.service';
import { ScoreController } from './score.controller';
import { ScoreService } from './score.service';

/** The Meat Proxy Score and the Vibe Score: the plugin API's second consumer, hosted next to `LearnModule`. */
@Module({
  imports: [DbModule, PiModule, ThreadsModule, AttendantModule, LearnModule, SnapshotsModule],
  controllers: [ScoreController],
  providers: [ScoreService, DialogAnswersService, MeatProxyPackage],
  exports: [ScoreService],
})
export class ScoreModule {}
