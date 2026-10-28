import { Module } from '@nestjs/common';
import { FolderChangesService } from './folder-changes.service';

/** What changed in a workspace folder: `FolderChangesService`, where changes are published for the Files and Changes panels and the file index cache. */
@Module({ providers: [FolderChangesService], exports: [FolderChangesService] })
export class FolderChangesModule {}
