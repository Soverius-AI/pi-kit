import { Module } from '@nestjs/common';
import { DbModule } from '../db/db.module';
import { PiModule } from '../pi/pi.module';
import { ThreadsModule } from '../threads/threads.module';
import { CoordinationController } from './coordination.controller';
import { CoordinationService } from './coordination.service';

/** File leases and the "other agents" knowledge every session is given. */
@Module({ imports: [DbModule, PiModule, ThreadsModule], controllers: [CoordinationController], providers: [CoordinationService], exports: [CoordinationService] })
export class CoordinationModule {}
