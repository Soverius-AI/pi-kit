import { Injectable, Logger } from '@nestjs/common';
import { AbstractAgent, type AgentCapabilities, type BaseEvent, EventType } from '@ag-ui/client';
import type { AgentRunnerConnectRequest, AgentRunnerRunRequest, AgentRunnerStopRequest } from '@copilotkit/runtime/v2';
import { REPLAY_CURSOR_HEADER, REPLAY_CURSOR_METADATA, REPLAY_RESET_EVENT } from '@pi-kit/protocol';
import { Observable, Subject, type Subscription } from 'rxjs';
import { EventLogRepository } from '../db/event-log.repository';
import { COMPACTION, LogCompactor } from '../agui/log-compactor';
import { AgentEventMapper, type AgentLive, type DurableEventStream } from './agent-events';

export const BG_AGENT_ID = 'pi-bg';

/** The AG-UI agent `pi-bg` as the CopilotKit runtime lists it; its runs and connections are the runner's below, not this class's. */
export class BgAgent extends AbstractAgent {
  constructor() {
    super({ agentId: BG_AGENT_ID, description: 'a background agent of a thread' });
  }
  override clone(): BgAgent {
    return new BgAgent();
  }
  override async getCapabilities(): Promise<AgentCapabilities> {
    return { identity: { name: BG_AGENT_ID, type: 'coding-agent' }, transport: { streaming: true, resumable: true }, tools: { supported: true, clientProvided: false }, humanInTheLoop: { supported: false, interrupts: false, approvals: false } };
  }
  run(): Observable<BaseEvent> {
    return new Observable((subscriber) => subscriber.error(new Error('A background agent is driven through the runner, not run.')));
  }
}

interface Followed {
  agentId: string;
  mapper: AgentEventMapper;
  live: Subject<{ seq: number; event: BaseEvent }>;
  stream: DurableEventStream;
  /** The AG-UI run the stored events belong to right now. */
  run?: string;
}

/** What a run or stop of `pi-bg` asks of the service: a message to the agent, or its end. */
export interface BgAgentActions {
  send(agentId: string, text: string, mode: 'steer' | 'followUp', requestId: string): Promise<void>;
  stop(agentId: string): Promise<void>;
}

/**
 * The runner of the AG-UI agent `pi-bg`: a background agent's transcript, with the agent id as thread id. `attach` follows
 * the agent's durable events, maps them (`agent-events.ts`) and stores them in the same log as the threads', so `connect` replays them
 * with the cursors and follows the live feed; `run` is only a message to the agent, `stop` ends it. `PiAgentRunner` hands the
 * requests of this agent id here.
 */
@Injectable()
export class BgAgentRunner {
  private readonly logger = new Logger(BgAgentRunner.name);
  private readonly followed = new Map<string, Followed>();
  private readonly compactor: LogCompactor;
  private actions: BgAgentActions | undefined;
  /** Told when an agent's live state changed (the panel's "running", "tool" and "idle"). */
  onLive: ((agentId: string) => void) | undefined;

  constructor(private readonly log: EventLogRepository) {
    this.compactor = new LogCompactor(log);
  }

  useActions(actions: BgAgentActions): void {
    this.actions = actions;
  }

  /** Follows an agent until `detach`: its snapshot now, its events as they are committed, all into the log. */
  attach(agentId: string, stream: DurableEventStream): void {
    if (this.followed.has(agentId)) return;
    const mapper = new AgentEventMapper(agentId);
    const entry: Followed = { agentId, mapper, live: new Subject(), stream };
    this.followed.set(agentId, entry);
    // A new attachment starts the log over: the snapshot is the whole transcript, and the old rows would replay before it.
    this.log.clear(agentId);
    this.store(entry, mapper.snapshot(stream.snapshot));
    stream.start(async (events) => {
      const before = { ...mapper.live };
      this.store(entry, events.flatMap((event) => mapper.map(event)));
      if (before.activity !== mapper.live.activity || before.tool !== mapper.live.tool || before.contextTokens !== mapper.live.contextTokens) this.onLive?.(agentId);
    });
  }

  async detach(agentId: string): Promise<void> {
    const entry = this.followed.get(agentId);
    if (!entry) return;
    this.followed.delete(agentId);
    entry.live.complete();
    await entry.stream.stop().catch((error: unknown) => this.logger.debug(`Stopping the events of ${agentId}: ${error instanceof Error ? error.message : String(error)}`));
  }

  /** A deleted agent: no longer followed, and its transcript gone from the log. */
  async forget(agentId: string): Promise<void> {
    await this.detach(agentId);
    this.log.clear(agentId);
  }

  liveOf(agentId: string): AgentLive | undefined {
    return this.followed.get(agentId)?.mapper.live;
  }

  /** Whether the id is a followed agent's (a thread id never is: threads are UUIDs, agents numbers). */
  owns(id: string): boolean {
    return this.followed.has(id) || this.log.count(id) > 0 && /^\d+$/.test(id);
  }

  /** A run of `pi-bg` is a message to the agent (the panel's message box); the answer streams through `connect`. */
  run(request: AgentRunnerRunRequest): Observable<BaseEvent> {
    const { threadId: agentId, input } = request;
    const last = input.messages.at(-1);
    const text = last?.role === 'user' ? (typeof last.content === 'string' ? last.content : '') : '';
    const mode = (input.forwardedProps as { streamingBehavior?: unknown } | undefined)?.streamingBehavior === 'steer' ? 'steer' : 'followUp';
    return new Observable((subscriber) => {
      subscriber.next({ type: EventType.RUN_STARTED, threadId: agentId, runId: input.runId } as BaseEvent);
      const done = (): void => {
        subscriber.next({ type: EventType.RUN_FINISHED, threadId: agentId, runId: input.runId, outcome: { type: 'success' } } as BaseEvent);
        subscriber.complete();
      };
      if (!text.trim() || !this.actions) return done();
      this.actions.send(agentId, text, mode, `message:${input.runId}`).then(done, (error: unknown) => {
        subscriber.next({ type: EventType.RUN_ERROR, message: error instanceof Error ? error.message : String(error), code: 'error' } as BaseEvent);
        subscriber.complete();
      });
    });
  }

  /** The stored transcript after the client's cursor, then the live feed while the agent is followed. */
  connect(request: AgentRunnerConnectRequest): Observable<BaseEvent> {
    const agentId = request.threadId;
    return new Observable<BaseEvent>((subscriber) => {
      if (this.log.count(agentId) > COMPACTION.maxRows) this.compactor.compact(agentId, { full: true });
      const after = this.log.resolveCursor(agentId, request.headers?.[REPLAY_CURSOR_HEADER]);
      // `running` says the stored part is followed by a live feed, so the client stops waiting for a snapshot that never comes.
      subscriber.next({ type: EventType.CUSTOM, name: REPLAY_RESET_EVENT, value: { reset: after === undefined, running: this.followed.has(agentId) } } as BaseEvent);
      const stored = after === undefined ? this.log.read(agentId) : this.log.readAfter(agentId, after);
      for (const { seq, event } of stored) subscriber.next(this.withCursor(agentId, seq, event));
      const entry = this.followed.get(agentId);
      if (!entry) {
        subscriber.complete();
        return;
      }
      const last = stored.at(-1)?.seq ?? after ?? 0;
      const follow: Subscription = entry.live.subscribe({ next: ({ seq, event }) => seq > last && subscriber.next(event), complete: () => subscriber.complete() });
      return () => follow.unsubscribe();
    });
  }

  isRunning(agentId: string): boolean {
    return this.followed.get(agentId)?.mapper.live.activity !== 'idle' && this.followed.has(agentId);
  }

  async stop(request: AgentRunnerStopRequest): Promise<boolean> {
    if (!this.followed.has(request.threadId) || !this.actions) return false;
    await this.actions.stop(request.threadId);
    return true;
  }

  private store(entry: Followed, events: BaseEvent[]): void {
    for (const event of events) {
      if (event.type === EventType.RUN_STARTED) entry.run = (event as unknown as { runId: string }).runId;
      const seq = this.log.append(entry.agentId, entry.run ?? 'bg', event);
      entry.live.next({ seq, event: this.withCursor(entry.agentId, seq, event) });
      if (event.type === EventType.RUN_FINISHED || event.type === EventType.RUN_ERROR) {
        try {
          this.compactor.compact(entry.agentId);
        } catch (error) {
          this.logger.warn(`Compacting an agent's log failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  }

  private withCursor(agentId: string, seq: number, event: BaseEvent): BaseEvent {
    return { ...event, metadata: { ...event.metadata, [REPLAY_CURSOR_METADATA]: this.log.cursor(agentId, seq) } };
  }
}
