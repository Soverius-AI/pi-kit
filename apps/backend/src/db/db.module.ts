import { Module } from '@nestjs/common';
import type { BackendConfig } from '../app/config';
import { CONFIG } from '../app/config.token';
import { AttendantRepository } from './attendant.repository';
import { ChangesRepository } from './changes.repository';
import { DatabaseService } from './database.service';
import { EventLogRepository } from './event-log.repository';
import { FeedbackRepository } from './feedback.repository';
import { LeasesRepository } from './leases.repository';
import { MetaRepository } from './meta.repository';
import { InstanceRepository } from './instance.repository';
import { PeersRepository } from './peers.repository';
import { OutcomesRepository } from './outcomes.repository';
import { RedactionService } from './redaction.service';
import { SignalsRepository } from './signals.repository';
import { AgentSpansRepository } from './agent-spans.repository';
import { SkillDraftsRepository } from './skill-drafts.repository';
import { SkillUsesRepository } from './skill-uses.repository';
import { MaintenanceRepository } from './maintenance.repository';
import { TerminalReplayRepository } from './terminal-replay.repository';
import { ThreadProtectionRepository } from './thread-protection.repository';
import { RoomsRepository } from './rooms.repository';
import { RoomPlaybooksRepository } from './room-playbooks.repository';
import { RoomRunsRepository } from './room-runs.repository';
import { A2aTasksRepository } from './a2a-tasks.repository';
import { A2aAgentsRepository } from './a2a-agents.repository';
import { ThreadsRepository } from './threads.repository';
import { RoomPhoneRepository } from './room-phone.repository';
import { RoomAssistantRepository } from './room-assistant.repository';

/**
 * The database: `DatabaseService`, opened from the config, the repositories that each own a
 * table or two, and the redaction that runs before text is kept. Every module that touches a table imports it.
 */
@Module({
  providers: [
    {
      provide: DatabaseService,
      inject: [CONFIG],
      useFactory: (config: BackendConfig) => DatabaseService.create(config),
    },
    ThreadsRepository,
    EventLogRepository,
    MetaRepository,
    InstanceRepository,
    PeersRepository,
    ChangesRepository,
    FeedbackRepository,
    AttendantRepository,
    RedactionService,
    TerminalReplayRepository,
    LeasesRepository,
    OutcomesRepository,
    SkillDraftsRepository,
    SkillUsesRepository,
    SignalsRepository,
    AgentSpansRepository,
    MaintenanceRepository,
    ThreadProtectionRepository,
    RoomsRepository,
    RoomPlaybooksRepository,
    RoomRunsRepository,
    A2aTasksRepository,
    A2aAgentsRepository,
    RoomPhoneRepository,
    RoomAssistantRepository,
  ],
  exports: [
    DatabaseService,
    ThreadsRepository,
    EventLogRepository,
    MetaRepository,
    InstanceRepository,
    PeersRepository,
    ChangesRepository,
    FeedbackRepository,
    AttendantRepository,
    RedactionService,
    TerminalReplayRepository,
    LeasesRepository,
    OutcomesRepository,
    SkillDraftsRepository,
    SkillUsesRepository,
    SignalsRepository,
    AgentSpansRepository,
    ThreadProtectionRepository,
    RoomsRepository,
    RoomPlaybooksRepository,
    RoomRunsRepository,
    A2aTasksRepository,
    A2aAgentsRepository,
    RoomPhoneRepository,
    RoomAssistantRepository,
  ],
})
export class DbModule {}
