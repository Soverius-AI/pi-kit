import { Module } from '@nestjs/common';
import { PiModule } from '../pi/pi.module';
import { ThreadsModule } from '../threads/threads.module';
import { TreeController } from './tree.controller';
import { TreeService } from './tree.service';

/** The session graph: `TreeService` over the threads and pi sessions, and `GET /api/threads/:id/tree` and its navigation routes. */
@Module({
  imports: [PiModule, ThreadsModule],
  controllers: [TreeController],
  providers: [TreeService],
  exports: [TreeService],
})
export class TreeModule {}
