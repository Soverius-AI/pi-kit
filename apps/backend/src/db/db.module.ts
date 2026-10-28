import { Module } from '@nestjs/common';
import type { SecretStore } from '@pi-kit/secret-store';
import type { BackendConfig } from '../app/config';
import { CONFIG } from '../app/config.token';
import { SECRET_STORE } from '../secrets/tokens';
import { encryptionEnabled } from '../secrets/security-config';
import { AttendantRepository } from './attendant.repository';
import { ChangesRepository } from './changes.repository';
import { DatabaseService } from './database.service';
import { EventLogRepository } from './event-log.repository';
import { FeedbackRepository } from './feedback.repository';
import { LeasesRepository } from './leases.repository';
import { MetaRepository } from './meta.repository';
import { OutcomesRepository } from './outcomes.repository';
import { RedactionService } from './redaction.service';
import { SignalsRepository } from './signals.repository';
import { AgentSpansRepository } from './agent-spans.repository';
import { SkillDraftsRepository } from './skill-drafts.repository';
import { SkillUsesRepository } from './skill-uses.repository';
import { MaintenanceRepository } from './maintenance.repository';
import { TerminalReplayRepository } from './terminal-replay.repository';
import { ThreadsRepository } from './threads.repository';

/**
 * The database: `DatabaseService`, opened from the config and the secret store, the repositories that each own a
 * table or two, and the redaction that runs before text is kept. Every module that touches a table imports it.
 */
@Module({
  providers: [{ provide: DatabaseService, inject: [CONFIG, SECRET_STORE], useFactory: (config: BackendConfig, store: SecretStore) => DatabaseService.create(config, store, encryptionEnabled(config.dataDir, store)) }, ThreadsRepository, EventLogRepository, MetaRepository, ChangesRepository, FeedbackRepository, AttendantRepository, RedactionService, TerminalReplayRepository, LeasesRepository, OutcomesRepository, SkillDraftsRepository, SkillUsesRepository, SignalsRepository, AgentSpansRepository, MaintenanceRepository],
  exports: [DatabaseService, ThreadsRepository, EventLogRepository, MetaRepository, ChangesRepository, FeedbackRepository, AttendantRepository, RedactionService, TerminalReplayRepository, LeasesRepository, OutcomesRepository, SkillDraftsRepository, SkillUsesRepository, SignalsRepository, AgentSpansRepository],
})
export class DbModule {}
