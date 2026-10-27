import { Module } from '@nestjs/common';
import { WatchService } from './watch.service';

/** The shared workspace file watcher: `WatchService`, exported for the Files and Changes panels and the file index cache. */
@Module({ providers: [WatchService], exports: [WatchService] })
export class WatchModule {}
