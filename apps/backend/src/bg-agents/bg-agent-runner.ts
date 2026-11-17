import { Injectable, Logger } from '@nestjs/common';
import { AbstractAgent, type AgentCapabilities, type BaseEvent, EventType } from '@ag-ui/client';
import type { AgentRunnerConnectRequest, AgentRunnerRunRequest, AgentRunnerStopRequest } from '@copilotkit/runtime/v2';
import {
  AGENT_LIVE_SYNC_RUN,
  REPLAY_CURSOR_HEADER,
  REPLAY_CURSOR_METADATA,
  REPLAY_RESET_EVENT,
} from '@pi-kit/protocol';
import { Observable, Subject, type Subscription } from 'rxjs';
import { EventLogRepository } from '../db/event-log.repository';
import { COMPACTION, LogCompactor } from '../agui/log-compactor';
import { AgentEventMapper, type AgentLive, type AgentViewStream } from './agent-events';

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
    return {
      identity: { name: BG_AGENT_ID, type: 'coding-agent' },
      transport: { streaming: true, resumable: true },
      tools: { supported: true, clientProvided: false },
      humanInTheLoop: { supported: false, interrupts: false, approvals: false },
    };
  }
  run(): Observable<BaseEvent> {
    return new Observable((subscriber) =>
      subscriber.error(new Error('A background agent is driven through the runner, not run.')),
    );
  }
}

interface Followed {
  agentId: string;
  mapper: AgentEventMapper;
  live: Subject<{ seq: number; event: BaseEvent }>;
  stream: AgentViewStream;
  /** The AG-UI run the stored events belong to right now. */
  run?: string;
  tail: Promise<void>;
  pending: number;
  failed?: Error;
  stopping?: Promise<unknown>;
}

/** What a run or stop of `pi-bg` asks of the service: a message to the agent, or its end. */
export interface BgAgentActions {
  send(agentId: string, text: string, mode: 'steer' | 'followUp', requestId: string): Promise<void>;
  stop(agentId: string): Promise<void>;
}

/**
 * The runner of the AG-UI agent `pi-bg`: a background agent's transcript, with the agent id as thread id. `attach` follows
 * the agent's durable views, maps them (`agent-events.ts`) and stores them in the same log as the threads', so `connect` replays them
 * with the cursors and follows the live feed; `run` is only a message to the agent, `stop` ends it. `PiAgentRunner` hands the
 * requests of this agent id here.
 */
@Injectable()
export class BgAgentRunner {
  private readonly logger = new Logger(BgAgentRunner.name);
  private readonly followed = new Map<string, Followed>();
  private readonly compactor: LogCompactor;
  private actions: BgAgentActions | undefined;
  /** The sync runs written to each agent's log by this process: a transcript that is not connected while idle joins when it moves. */
  private readonly syncs = new Map<string, number>();
  /** Told when an agent's live state changed (the panel's "running", "tool" and "idle", or a sync run in its log). */
  onLive: ((agentId: string) => void | Promise<void>) | undefined;

  constructor(private readonly log: EventLogRepository) {
    this.compactor = new LogCompactor(log);
  }

  useActions(actions: BgAgentActions): void {
    this.actions = actions;
  }

  /** Follows an agent until `detach`: its snapshot now, its views as they are committed, all into the log. */
  async attach(agentId: string, stream: AgentViewStream): Promise<void> {
    if (this.followed.has(agentId)) return;
    const mapper = new AgentEventMapper(agentId);
    const entry: Followed = { agentId, mapper, live: new Subject(), stream, tail: Promise.resolve(), pending: 0 };
    this.followed.set(agentId, entry);
    // A new attachment starts the log over: the snapshot is the whole transcript, and the old rows would replay before it.
    await this.enqueue(entry, async () => {
      await this.log.clear(agentId);
      await this.store(entry, mapper.snapshot(stream.view, stream.timing));
    });
    stream.start((view, ops, timing) =>
      this.enqueue(entry, async () => {
        const before = { ...mapper.live };
        const syncs = this.liveSyncsOf(agentId);
        await this.store(entry, mapper.map(view, ops, timing));
        if (
          before.activity !== mapper.live.activity ||
          before.tool !== mapper.live.tool ||
          before.contextTokens !== mapper.live.contextTokens ||
          syncs !== this.liveSyncsOf(agentId)
        )
          await this.onLive?.(agentId);
      }),
    );
  }

  async detach(agentId: string): Promise<void> {
    const entry = this.followed.get(agentId);
    if (!entry) return;
    this.followed.delete(agentId);
    await (entry.stopping ??= entry.stream.stop()).catch((error: unknown) =>
      this.logger.debug(`Stopping the events of ${agentId}: ${error instanceof Error ? error.message : String(error)}`),
    );
    await entry.tail;
    entry.live.complete();
  }

  async close(): Promise<void> {
    await Promise.all([...this.followed.keys()].map((id) => this.detach(id)));
  }

  /** A deleted agent: no longer followed, and its transcript gone from the log. */
  async forget(agentId: string): Promise<void> {
    await this.detach(agentId);
    await this.log.clear(agentId);
    this.syncs.delete(agentId);
  }

  liveOf(agentId: string): AgentLive | undefined {
    return this.followed.get(agentId)?.mapper.live;
  }

  /** How many sync runs (`AGENT_LIVE_SYNC_RUN`) this process wrote to the agent's log. */
  liveSyncsOf(agentId: string): number {
    return this.syncs.get(agentId) ?? 0;
  }

  /** Whether the id is a followed agent's (a thread id never is: threads are UUIDs, agents numbers). */
  async owns(id: string): Promise<boolean> {
    return this.followed.has(id) || ((await this.log.count(id)) > 0 && /^\d+$/.test(id));
  }

  /** A run of `pi-bg` is a message to the agent (the panel's message box); the answer streams through `connect`. */
  run(request: AgentRunnerRunRequest): Observable<BaseEvent> {
    const { threadId: agentId, input } = request;
    const last = input.messages.at(-1);
    const text = last?.role === 'user' ? (typeof last.content === 'string' ? last.content : '') : '';
    const mode =
      (input.forwardedProps as { streamingBehavior?: unknown } | undefined)?.streamingBehavior === 'steer'
        ? 'steer'
        : 'followUp';
    return new Observable((subscriber) => {
      subscriber.next({ type: EventType.RUN_STARTED, threadId: agentId, runId: input.runId } as BaseEvent);
      const done = (): void => {
        subscriber.next({
          type: EventType.RUN_FINISHED,
          threadId: agentId,
          runId: input.runId,
          outcome: { type: 'success' },
        } as BaseEvent);
        subscriber.complete();
      };
      if (!text.trim() || !this.actions) return done();
      this.actions.send(agentId, text, mode, `message:${input.runId}`).then(done, (error: unknown) => {
        subscriber.next({
          type: EventType.RUN_ERROR,
          message: error instanceof Error ? error.message : String(error),
          code: 'error',
        } as BaseEvent);
        subscriber.complete();
      });
    });
  }

  /** The stored transcript after the client's cursor, then the live feed while the agent is followed. */
  connect(request: AgentRunnerConnectRequest): Observable<BaseEvent> {
    const agentId = request.threadId;
    return new Observable<BaseEvent>((subscriber) => {
      let replaying = true;
      let last = 0;
      const pending: { seq: number; event: BaseEvent }[] = [];
      const found = this.followed.get(agentId);
      const entry = found?.failed ? undefined : found;
      let ended = false;
      // Subscribe before any awaited reads: commits during replay must not disappear in the gap.
      const follow: Subscription | undefined = entry?.live.subscribe({
        next: (item) => {
          if (replaying) pending.push(item);
          else if (item.seq > last) {
            last = item.seq;
            subscriber.next(item.event);
          }
        },
        error: (error: unknown) => subscriber.error(error),
        complete: () => {
          ended = true;
          if (!replaying) subscriber.complete();
        },
      });
      void (async () => {
        if (entry) await entry.tail;
        if ((await this.log.count(agentId)) > COMPACTION.maxRows) await this.compactor.compact(agentId, { full: true });
        const after = await this.log.resolveCursor(agentId, request.headers?.[REPLAY_CURSOR_HEADER]);
        if (subscriber.closed) return;
        subscriber.next({
          type: EventType.CUSTOM,
          name: REPLAY_RESET_EVENT,
          value: { reset: after === undefined, running: !!entry && !entry.failed },
        } as BaseEvent);
        const stored = after === undefined ? await this.log.read(agentId) : await this.log.readAfter(agentId, after);
        last = after ?? 0;
        for (const { seq, event } of stored) {
          last = seq;
          subscriber.next(this.withCursor(agentId, seq, event));
        }
        for (const { seq, event } of pending)
          if (seq > last) {
            last = seq;
            subscriber.next(event);
          }
        replaying = false;
        if (!entry || ended) subscriber.complete();
      })().catch((error: unknown) => subscriber.error(error));
      return () => follow?.unsubscribe();
    });
  }

  isRunning(agentId: string): boolean {
    const entry = this.followed.get(agentId);
    return !!entry && !entry.failed && entry.mapper.live.activity !== 'idle';
  }

  async stop(request: AgentRunnerStopRequest): Promise<boolean> {
    if (!this.followed.has(request.threadId) || !this.actions) return false;
    await this.actions.stop(request.threadId);
    return true;
  }

  private fail(entry: Followed, reason: unknown): Error {
    if (entry.failed) return entry.failed;
    const error = reason instanceof Error ? reason : new Error(String(reason));
    entry.failed = error;
    this.logger.warn(`Storing agent events failed; the transcript producer was stopped: ${error.message}`);
    entry.live.error(error);
    // Stop the producer, but not the durable agent: its conversations remain authoritative and recoverable.
    entry.stopping ??= entry.stream.stop().catch((stop: unknown) => {
      this.logger.debug(`Stopping a failed transcript producer: ${String(stop)}`);
    });
    return error;
  }

  private enqueue(entry: Followed, work: () => Promise<void>): Promise<void> {
    if (entry.pending >= 1024) {
      const rejected = Promise.reject(
        this.fail(
          entry,
          new Error('Background transcript queue exceeded 1024 batches. Reconnect to recover its durable transcript.'),
        ),
      );
      void rejected.catch(() => undefined);
      return rejected;
    }
    entry.pending++;
    const result = entry.tail.then(async () => {
      if (entry.failed) throw entry.failed;
      await work();
    });
    entry.tail = result.then(
      () => {
        entry.pending--;
      },
      (error: unknown) => {
        entry.pending--;
        this.fail(entry, error);
      },
    );
    return result;
  }

  private async store(entry: Followed, events: BaseEvent[]): Promise<void> {
    for (const event of events) {
      if (entry.failed) throw entry.failed;
      if (event.type === EventType.RUN_STARTED) {
        entry.run = (event as unknown as { runId: string }).runId;
        if (entry.run.startsWith(AGENT_LIVE_SYNC_RUN))
          this.syncs.set(entry.agentId, this.liveSyncsOf(entry.agentId) + 1);
      }
      const seq = await this.log.append(entry.agentId, entry.run ?? 'bg', event);
      if (entry.failed) throw entry.failed;
      entry.live.next({ seq, event: this.withCursor(entry.agentId, seq, event) });
      if (event.type === EventType.RUN_FINISHED || event.type === EventType.RUN_ERROR) {
        try {
          await this.compactor.compact(entry.agentId);
        } catch (error) {
          this.logger.warn(
            `Compacting an agent's log failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
  }

  private withCursor(agentId: string, seq: number, event: BaseEvent): BaseEvent {
    return { ...event, metadata: { ...event.metadata, [REPLAY_CURSOR_METADATA]: this.log.cursor(agentId, seq) } };
  }
}
