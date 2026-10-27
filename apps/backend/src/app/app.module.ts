import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AguiModule } from '../agui/agui.module';
import { BgAgentsModule } from '../bg-agents/bg-agents.module';
import { BrowserModule } from '../browser/browser.module';
import { AttendantModule } from '../attendant/attendant.module';
import { LearnModule } from '../learn/learn.module';
import { ComputerUseModule } from '../computer-use/computer-use.module';
import { ScoreModule } from '../score/score.module';
import { ChangesModule } from '../changes/changes.module';
import { ContractModule } from '../contract';
import { CoordinationModule } from '../coordination/coordination.module';
import { DbModule } from '../db/db.module';
import { DesktopModule } from '../desktop/desktop.module';
import { McpModule } from '../mcp/mcp.module';
import { PackagesModule } from '../packages/packages.module';
import { SkillsModule } from '../skills/skills.module';
import { SecretsModule, SecretStoreModule } from '../secrets/secrets.module';
import { SessionModule } from '../session/session.module';
import { SetupModule } from '../setup/setup.module';
import { SettingsModule } from '../settings/settings.module';
import { UsageModule } from '../usage/usage.module';
import { TerminalModule } from '../terminal/terminal.module';
import { ThreadsModule } from '../threads/threads.module';
import { TreeModule } from '../tree/tree.module';
import { UpdateModule } from '../update/update.module';
import { TranscribeModule } from '../transcribe/transcribe.module';
import { BearerTokenGuard } from './auth.guard';
import { loadConfig } from './config';
import { ConfigModule } from './config.module';
import { DevController } from './dev.controller';
import { HealthController } from './health.controller';
import { ParentProcessMonitor } from './parent-process-monitor';

const config = loadConfig();

/**
 * The root module: imports every feature module of the backend, serves the health check (and the dev controller in
 * development), watches the parent process, and puts the bearer-token guard in front of every route.
 */
@Module({
  imports: [ConfigModule, ContractModule, SecretStoreModule, DbModule, SecretsModule, DesktopModule, BrowserModule, ThreadsModule, SessionModule, ChangesModule, CoordinationModule, TerminalModule, SettingsModule, TreeModule, McpModule, PackagesModule, SkillsModule, AguiModule, UpdateModule, TranscribeModule, AttendantModule, LearnModule, ScoreModule, ComputerUseModule, SetupModule, UsageModule, BgAgentsModule],
  controllers: [HealthController, ...(config.dev ? [DevController] : [])],
  providers: [ParentProcessMonitor, { provide: APP_GUARD, useClass: BearerTokenGuard }],
})
export class AppModule {}
