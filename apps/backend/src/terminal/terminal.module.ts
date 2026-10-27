import { Module } from '@nestjs/common';
import { DbModule } from '../db/db.module';
import { TerminalController } from './terminal.controller';
import { TerminalService } from './terminal.service';

/**
 * The convenience terminal of each workspace: its shell, kept while the backend runs, and its last screen in the
 * database.
 */
@Module({ imports: [DbModule], controllers: [TerminalController], providers: [TerminalService], exports: [TerminalService] })
export class TerminalModule {}
