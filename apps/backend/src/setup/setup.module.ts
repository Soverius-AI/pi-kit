import { Module } from '@nestjs/common';
import { DbModule } from '../db/db.module';
import { PiModule } from '../pi/pi.module';
import { LiteLlmController } from './litellm.controller';
import { SetupController } from './setup.controller';
import { SetupService } from './setup.service';
import { LocalRuntimeModule } from './local-runtime.module';

/** First-run onboarding: the setup calls the cards need, the LiteLLM connection, and the local runtime wizard. */
@Module({ imports: [DbModule, PiModule, LocalRuntimeModule], controllers: [SetupController, LiteLlmController], providers: [SetupService] })
export class SetupModule {}
