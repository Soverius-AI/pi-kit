import { Module } from '@nestjs/common';
import { DbModule } from '../db/db.module';
import { PiModule } from '../pi/pi.module';
import { ThreadsModule } from '../threads/threads.module';
import { ChangesController } from './changes.controller';
import { ChangesService } from './changes.service';
import { WorkspaceStatusController } from './workspace-status.controller';

/**
 * The Changes panel: the changed files of a thread and their review, and the workspace status that decorates the
 * Files panel.
 */
@Module({ imports: [DbModule, PiModule, ThreadsModule], controllers: [ChangesController, WorkspaceStatusController], providers: [ChangesService], exports: [ChangesService] })
export class ChangesModule {}
