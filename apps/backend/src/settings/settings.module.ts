import { Module } from '@nestjs/common';
import { DbModule } from '../db/db.module';
import { PiModule } from '../pi/pi.module';
import { ThreadsModule } from '../threads/threads.module';
import { DiagnosticsService } from './diagnostics.service';
import { SecretsController } from './secrets.controller';
import { SettingsController } from './settings.controller';

/**
 * The settings module: pi's settings, sign-in and trust, the stored secrets, and the diagnostics the bug-report
 * dialog shows.
 */
@Module({ imports: [DbModule, PiModule, ThreadsModule], controllers: [SettingsController, SecretsController], providers: [DiagnosticsService] })
export class SettingsModule {}
