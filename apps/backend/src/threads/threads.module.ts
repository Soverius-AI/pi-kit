import { Module } from '@nestjs/common';
import { DbModule } from '../db/db.module';
import { PiModule } from '../pi/pi.module';
import { TerminalModule } from '../terminal/terminal.module';
import { SnapshotsModule } from '../snapshots/snapshots.module';
import { FolderChangesModule } from '../folder-changes/folder-changes.module';
import { WorktreeService } from '../worktree/worktree.service';
import { AppSettingsController } from './app-settings.controller';
import { OutcomesController } from './outcomes.controller';
import { OutcomesService } from './outcomes.service';
import { ThreadStatusService } from './thread-status.service';
import { ThreadsController } from './threads.controller';
import { ThreadsService } from './threads.service';
import { WorkspacesController } from './workspaces.controller';
import { WorktreeController } from './worktree.controller';

/**
 * Threads and what hangs off them: the sidebar's list and status stream, the projects, the app's own settings,
 * worktrees, outcomes.
 */
@Module({
  imports: [DbModule, PiModule, TerminalModule, FolderChangesModule, SnapshotsModule],
  controllers: [ThreadsController, WorkspacesController, AppSettingsController, WorktreeController, OutcomesController],
  providers: [ThreadsService, ThreadStatusService, WorktreeService, OutcomesService],
  exports: [ThreadsService, ThreadStatusService, WorktreeService, OutcomesService],
})
export class ThreadsModule {}
