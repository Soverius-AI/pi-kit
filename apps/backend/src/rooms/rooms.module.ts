import { Module } from '@nestjs/common';
import { AguiModule } from '../agui/agui.module';
import { DbModule } from '../db/db.module';
import { McpModule } from '../mcp/mcp.module';
import { PeersModule } from '../peers/peers.module';
import { PiModule } from '../pi/pi.module';
import { ThreadsModule } from '../threads/threads.module';
import { RoomAgents } from './room-agents';
import { RoomBus } from './room-bus';
import { RoomDirectoryService } from './room-directory.service';
import { RoomEnvironments } from './room-environments';
import { RoomQuestions } from './room-questions';
import { RoomLeadService } from './room-lead.service';
import { RoomTasksService } from './room-tasks.service';
import { RoomWorkerRunner } from './room-worker-runner';
import { RoomWorkerService } from './room-worker.service';
import { RoomsEnabledGuard } from './rooms-enabled.guard';
import { A2aController, A2aWellKnownController, RoomsController } from './rooms.controller';
import { RoomA2aClient } from './room-a2a.client';
import { RoomA2aServer } from './room-a2a.server';
import { RoomA2aPushSender } from './room-a2a.push-sender';
import { RoomA2aPushStore } from './room-a2a.push-store';
import { RoomA2aTaskStore } from './room-a2a.task-store';
import { RoomOutbox } from './room-outbox';
import { RoomA2aAgents } from './room-a2a-agents';
import { RoomsService } from './rooms.service';
import { RoomPlaybookTools } from './room-playbook-tools.service';
import { RoomSources } from './room-sources.service';
import { RoomConsultant } from './room-consultant.service';
import { RoomPlaybookService } from './room-playbook.service';
import { RoomPlaybookFiles } from './room-playbook-files.service';
import { RoomFolders } from './room-folders';
import { RoomRuns } from './room-runs';
import { RoomLive } from './room-live';
import { RoomPlaybookEditor } from './room-playbook-editor.service';

@Module({
  imports: [DbModule, PiModule, ThreadsModule, AguiModule, PeersModule, McpModule],
  providers: [
    RoomsService,
    RoomBus,
    RoomAgents,
    RoomLeadService,
    RoomTasksService,
    RoomWorkerRunner,
    RoomWorkerService,
    RoomsEnabledGuard,
    RoomEnvironments,
    RoomDirectoryService,
    RoomQuestions,
    RoomA2aClient,
    RoomA2aServer,
    RoomA2aPushSender,
    RoomA2aPushStore,
    RoomA2aTaskStore,
    RoomOutbox,
    RoomA2aAgents,
    RoomFolders,
    RoomRuns,
    RoomLive,
    RoomPlaybookFiles,
    RoomPlaybookTools,
    RoomSources,
    RoomConsultant,
    RoomPlaybookService,
    RoomPlaybookEditor,
  ],
  controllers: [RoomsController, A2aController, A2aWellKnownController],
})
export class RoomsModule {}
