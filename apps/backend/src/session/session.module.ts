import { Module } from '@nestjs/common';
import { DbModule } from '../db/db.module';
import { PiModule } from '../pi/pi.module';
import { ThreadsModule } from '../threads/threads.module';
import { FolderChangesModule } from '../folder-changes/folder-changes.module';
import { CommandsService } from './commands.service';
import { ComposerController } from './composer.controller';
import { FilesService } from './files.service';
import { FsService } from './fs.service';
import { QueueController } from './queue.controller';
import { SessionController } from './session.controller';

/**
 * The REST side of a thread's pi session: the commands, the composer's completions and actions, the message queue,
 * and files.
 */
@Module({
  imports: [DbModule, PiModule, ThreadsModule, FolderChangesModule],
  controllers: [SessionController, ComposerController, QueueController],
  providers: [CommandsService, FilesService, FsService],
})
export class SessionModule {}
