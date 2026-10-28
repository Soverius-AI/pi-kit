import { Logger, Module, OnModuleInit } from '@nestjs/common';
import { AguiModule } from '../agui/agui.module';
import { PiAgentRunner } from '../agui/pi-agent-runner';
import { DbModule } from '../db/db.module';
import { PiModule } from '../pi/pi.module';
import { PiSessionService } from '../pi/pi-session.service';
import { ThreadsModule } from '../threads/threads.module';
import { ThreadStatusService } from '../threads/thread-status.service';
import { ThreadsService } from '../threads/threads.service';
import { TrustService } from '../pi/trust.service';
import { WorktreeService } from '../worktree/worktree.service';
import { CoordinationModule } from '../coordination/coordination.module';
import { CoordinationService } from '../coordination/coordination.service';
import { SnapshotsModule } from '../snapshots/snapshots.module';
import { RunSnapshotsService } from '../snapshots/run-snapshots.service';
import { BgAgentRunner } from './bg-agent-runner';
import { BgAgentsController } from './bg-agents.controller';
import { BgAgentsRepository } from './bg-agents.repository';
import { BgAgentsService } from './bg-agents.service';
import { THREAD_HOST, type ThreadHost } from './thread-host';

const logger = new Logger('BgAgentsModule');

/** The threads as the service sees them, behind a token so a process without Nest (the kill test's worker) builds the service by hand. */
const threadHost = (
  threads: ThreadsService,
  sessions: PiSessionService,
  trust: TrustService,
  worktrees: WorktreeService,
): ThreadHost => ({
  cwdOf: (id) => threads.cwdOf(id),
  allowed: async (id) => {
    // The thread's project, not the folder pi runs in: a thread in a worktree works outside the project's folder and still belongs to it.
    const projectCwd = threads.projectOf(id);
    const project = threads.workspaces().find((w) => w.cwd === projectCwd);
    // The same answer the main session runs under: a folder with no pi resources is trusted for nothing and needs no dialog, so agents may run there too.
    if ((await trust.state(projectCwd)).status !== 'trusted')
      return 'Background agents are off: this folder is not trusted (Settings › Projects).';
    if (project && !project.agents)
      return 'Background agents are off for this project: switch them on in Settings › Projects.';
    return undefined;
  },
  isolate: async (id, agentId, name) => {
    const projectCwd = threads.projectOf(id);
    const facts = await worktrees.create(projectCwd, {
      threadId: `${id}-${agentId}`,
      title: `agent-${name}`,
      setup: 'skip',
    });
    return { path: facts.path, branch: facts.branch, projectCwd: facts.projectCwd, base: facts.base };
  },
  discard: (worktree) => worktrees.discard(worktree),
  deliver: async (id, message) => {
    await threads.openSession(id);
    // pi's call resolves when the turn it starts ends: an agent's question must not wait for the main agent's whole answer.
    sessions
      .sendCustomMessage(id, message, { triggerTurn: true })
      .catch((error: unknown) =>
        logger.warn(
          `Delivering ${message.customType} to ${id} failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
  },
});

/** The background agents of the threads: one durable host per backend, its index table, the HTTP surface, and the hooks into the main sessions. */
@Module({
  imports: [DbModule, PiModule, ThreadsModule, AguiModule, CoordinationModule, SnapshotsModule],
  controllers: [BgAgentsController],
  providers: [
    BgAgentsRepository,
    BgAgentRunner,
    BgAgentsService,
    {
      provide: THREAD_HOST,
      inject: [ThreadsService, PiSessionService, TrustService, WorktreeService],
      useFactory: threadHost,
    },
  ],
  exports: [BgAgentsService],
})
export class BgAgentsModule implements OnModuleInit {
  constructor(
    private readonly agents: BgAgentsService,
    private readonly runner: BgAgentRunner,
    private readonly sessions: PiSessionService,
    private readonly threads: ThreadsService,
    private readonly status: ThreadStatusService,
    private readonly piRunner: PiAgentRunner,
    private readonly coordination: CoordinationService,
    private readonly snapshots: RunSnapshotsService,
  ) {}

  /**
   * The main sessions' `agent_*` tools reach the service through a hook (like the browser's), a deleted thread takes its agents along,
   * the runtime's runner hands `pi-bg` here, and a change to a thread's agents goes out over the status channel, with the thread's state
   * (the user questions of its agents are part of it).
   */
  onModuleInit(): void {
    this.sessions.setAgents(this.agents);
    this.threads.onDeleted((id) => void this.agents.deleteThread(id));
    this.piRunner.useBackground(this.runner);
    // An agent's edit takes the lease like pi's own; its work in the thread's folder is snapshotted like a run, so what it changes is the thread's.
    this.agents.onToolStart((start) => this.coordination.record(start));
    this.agents.watchWork({
      started: (agentId, threadId, folder) => this.snapshots.agentStarted(agentId, threadId, folder),
      ended: (agentId) => this.snapshots.agentEnded(agentId),
    });
    this.status.setAgentQuestions((threadId) => this.agents.userQuestions(threadId));
    this.agents.onChange((threadId) => {
      this.status.pushAgents(
        threadId,
        this.agents.list(threadId).map((row) => this.agents.toAgent(row)),
      );
      this.status.touch(threadId);
    });
  }
}
