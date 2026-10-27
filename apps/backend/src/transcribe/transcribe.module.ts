import { Module } from '@nestjs/common';
import { TranscribeController } from './transcribe.controller';
import { TranscribeService } from './transcribe.service';

/** Voice input: Whistle on this machine. */
@Module({ controllers: [TranscribeController], providers: [TranscribeService], exports: [TranscribeService] })
export class TranscribeModule {}
