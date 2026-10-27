import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { ThreadSuggestion } from '@pi-kit/protocol';
import { BgAgentsService } from '../bg-agents/bg-agents.service';
import { AttendantRepository } from '../db/attendant.repository';
import { EventLogRepository } from '../db/event-log.repository';
import { MetaRepository } from '../db/meta.repository';
import { ThreadsRepository } from '../db/threads.repository';
import { PiSessionService } from '../pi/pi-session.service';
import { TrustService } from '../pi/trust.service';
import { ThreadStatusService } from '../threads/thread-status.service';
import { ThreadsService } from '../threads/threads.service';
import { AttendantService } from './attendant.service';
import { cleanFollowUp, followUpPrompt, followUpTarget } from './follow-up-text';

/** One advisory prediction per finished conversation state, in the attendant's shared queue and budget. */
@Injectable()
export class FollowUpService implements OnModuleInit, OnModuleDestroy {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly attempted = new Map<string, string>();
  private readonly revisions = new Map<string, number>();
  private readonly unsubscribe: (() => void)[] = [];
  private stopped = false;

  constructor(
    private readonly attendant: AttendantService,
    private readonly repo: AttendantRepository,
    private readonly events: EventLogRepository,
    private readonly rows: ThreadsRepository,
    private readonly threads: ThreadsService,
    private readonly sessions: PiSessionService,
    private readonly agents: BgAgentsService,
    private readonly meta: MetaRepository,
    private readonly status: ThreadStatusService,
    private readonly trust: TrustService,
  ) {}

  onModuleInit(): void {
    // Predictions saved by a previous backend may refer to stale agent state.
    this.repo.expirePrompts();
    this.attendant.setPromptValidator((suggestion) => this.valid(suggestion));
    this.unsubscribe.push(
      this.events.onRunChange((id, change) => {
        this.invalidate(id);
        if (change === 'end') this.schedule(id);
      }),
      this.sessions.onTreeChanged((id) => this.invalidate(id)),
      this.sessions.onDialogsChanged((id) => this.invalidate(id)),
      this.agents.onChange((id) => {
        this.invalidate(id);
        this.schedule(id);
      }),
    );
  }

  onModuleDestroy(): void {
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    for (const off of this.unsubscribe) off();
  }

  private invalidate(id: string): void {
    this.revisions.set(id, (this.revisions.get(id) ?? 0) + 1);
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    this.repo.expirePrompts(id);
    this.status.touch(id);
  }

  private schedule(id: string): void {
    if (!this.enabled()) return;
    clearTimeout(this.timers.get(id));
    const timer = setTimeout(() => {
      this.timers.delete(id);
      this.attendant.enqueueTask(id, () => this.generate(id), 'prompt');
    }, 1500);
    timer.unref();
    this.timers.set(id, timer);
  }

  private enabled(): boolean {
    const settings = this.attendant.settings();
    return !this.stopped && settings.enabled && settings.followUpSuggestions;
  }

  private async snapshot(id: string) {
    const revision = this.revisions.get(id) ?? 0;
    const row = this.rows.get(id);
    const run = this.events.lastRun(id);
    if (!this.enabled() || !row || row.archived || !row.messageCount || !this.attendant.allowedIn(row.cwd) || this.meta.isVerificationThread(id) || this.meta.learningSource(id) || run?.status !== 'finished') return undefined;
    if (this.sessions.pendingDialogs(id).length || this.agents.userQuestions(id).length) return undefined;
    if (this.sessions.has(id)) {
      const queue = this.sessions.queue(id);
      if (this.sessions.isStreaming(id) || queue.steering.length || queue.followUp.length) return undefined;
    }
    const agents = this.agents.list(id);
    // Never turn a pending delegation into an invitation to repeat or supersede it.
    if (agents.some((agent) => agent.status === 'active' || agent.status === 'blocked')) return undefined;
    const agentsAllowed = this.agents.state().enabled && !this.meta.listWorkspaces().find((w) => w.cwd === row.cwd)?.agentsOff && (await this.trust.state(row.cwd)).status === 'trusted';
    const source = await this.threads.treeSource(id);
    if (revision !== (this.revisions.get(id) ?? 0)) return undefined;
    return { row, source, agents, agentsAllowed, revision, target: followUpTarget(run.runId, source.entries, source.leafId, agents, agentsAllowed) };
  }

  async valid(suggestion: ThreadSuggestion & { threadId: string }): Promise<boolean> {
    const snapshot = await this.snapshot(suggestion.threadId);
    return snapshot?.target === suggestion.target;
  }

  async generate(id: string): Promise<void> {
    const before = await this.snapshot(id);
    if (!before || this.attempted.get(id) === before.target || this.repo.hasSuggestion(id, 'prompt', before.target)) return;
    this.attempted.set(id, before.target);
    const result = await this.attendant.complete(before.row, followUpPrompt(before.source.entries, before.source.leafId, before.agents, before.agentsAllowed), {
      kind: 'prompt', initiative: 'attendant',
      describe: (text) => ({ status: cleanFollowUp(text) || /^\s*SKIP\s*$/i.test(text) ? 'done' : 'error', text: cleanFollowUp(text) ?? (/^\s*SKIP\s*$/i.test(text) ? 'No clear follow-up.' : 'The model’s follow-up was not usable.') }),
    });
    const after = await this.snapshot(id);
    if (!after || before.target !== after.target || before.revision !== after.revision) {
      // A debounced agent update may have arrived while this task already held the queue slot.
      if (after && before.target !== after.target) this.schedule(id);
      return;
    }
    const text = result.ok ? cleanFollowUp(result.text) : undefined;
    if (!text) return;
    this.repo.expirePrompts(id);
    this.repo.addSuggestion({ threadId: id, kind: 'prompt', target: before.target, text });
    this.status.touch(id);
  }
}
