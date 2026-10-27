import { Module } from '@nestjs/common';
import { LiteLlmService } from '../setup/litellm.service';
import { PiConfigService } from './pi-config.service';
import { PiUpdateService } from './pi-update.service';
import { PiPluginService } from './pi-plugin.service';
import { PiSessionService } from './pi-session.service';
import { ResourcesService } from './resources.service';
import { TrustService } from './trust.service';

/**
 * pi itself: its sessions, config, plugins, trust, resources and updates, and the LiteLLM catalog refresh the model
 * picker needs.
 */
@Module({ providers: [LiteLlmService, PiPluginService, TrustService, PiSessionService, PiConfigService, PiUpdateService, ResourcesService], exports: [LiteLlmService, PiPluginService, PiSessionService, PiConfigService, TrustService, PiUpdateService, ResourcesService] })
export class PiModule {}
