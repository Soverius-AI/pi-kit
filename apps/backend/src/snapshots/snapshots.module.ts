import { Module } from '@nestjs/common';
import { DbModule } from '../db/db.module';
import { PiModule } from '../pi/pi.module';
import { FolderChangesModule } from '../folder-changes/folder-changes.module';
import { RunSnapshotsService } from './run-snapshots.service';

/** Snapshots of a thread's folder around its runs, in a private git repository per project: what "This thread" and the score read. */
@Module({
  imports: [DbModule, PiModule, FolderChangesModule],
  providers: [RunSnapshotsService],
  exports: [RunSnapshotsService],
})
export class SnapshotsModule {}
