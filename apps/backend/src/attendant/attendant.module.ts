import { Module } from '@nestjs/common';
import { BgAgentsModule } from '../bg-agents/bg-agents.module';
import { DbModule } from '../db/db.module';
import { PiModule } from '../pi/pi.module';
import { ThreadsModule } from '../threads/threads.module';
import { TreeModule } from '../tree/tree.module';
import { AttendantController } from './attendant.controller';
import { AttendantModel, AttendantModelPort } from './attendant-model';
import { AttendantService } from './attendant.service';
import { FollowUpService } from './follow-up.service';

/** The attendant agent. It is always loaded and does nothing until the user turns it on. */
@Module({
  imports: [DbModule, PiModule, ThreadsModule, TreeModule, BgAgentsModule],
  controllers: [AttendantController],
  providers: [AttendantService, FollowUpService, { provide: AttendantModelPort, useClass: AttendantModel }],
  exports: [AttendantService],
})
export class AttendantModule {}
