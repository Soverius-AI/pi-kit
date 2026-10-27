import {
  type AgentStateMutation,
  type AgentSubscriber,
  type BaseEvent,
  EventType,
  type RunAgentInput,
  type RunAgentParameters,
  runHttpRequest,
  transformHttpEventStream,
} from '@ag-ui/client';
import { ProxiedCopilotRuntimeAgent } from '@copilotkit/core';
import {
  REPLAY_CHECKPOINT_EVENT,
  REPLAY_CURSOR_HEADER,
  REPLAY_CURSOR_METADATA,
  REPLAY_RESET_EVENT,
  THREAD_HYDRATION_HEADER,
  THREAD_HYDRATION_EVENT,
  type ThreadHydration,
} from '@pi-kit/protocol';
import { type Message } from '@ag-ui/client';
import { type Observable, asyncScheduler, concat, concatMap, from, of, scheduled } from 'rxjs';
import { type CachedThreadReplay } from './thread-replay-cache.store';

export interface ThreadReplayCachePort {
  get(id: string): CachedThreadReplay | undefined;
  record(id: string, value: Omit<CachedThreadReplay, 'visitedAt' | 'view'>): void;
  forget(id: string): void;
  ready?(id: string): void;
  prepare?(id: string, messages: readonly Message[]): Promise<void>;
}

/** Keeps CopilotKit's run/interrupt lifecycle; only the history transport resumes from our signal-store cache. */
export class ThreadReplayAgent extends ProxiedCopilotRuntimeAgent {
  cache?: ThreadReplayCachePort;
  private applyEpoch = 0;

  override async connectAgent(parameters?: RunAgentParameters, subscriber?: AgentSubscriber) {
    // Core clears its agent on a thread switch. Restore once before its reducer starts; never replay the cached history.
    const cached = this.cache?.get(this.threadId);
    if (cached) {
      this.setMessages(cached.messages);
      this.setState(cached.state);
      this.pendingInterrupts = structuredClone(cached.interrupts);
    }
    return super.connectAgent(parameters, subscriber);
  }

  override connect(input: RunAgentInput): Observable<BaseEvent> {
    const cached = this.cache?.get(input.threadId);
    // The server owns the history. Sending the cached transcript back would add latency and grow the request forever.
    const init = this.requestInit({ ...input, messages: [], state: {} });
    const headers = new Headers(init.headers);
    headers.set(THREAD_HYDRATION_HEADER, '1');
    if (cached) headers.set(REPLAY_CURSOR_HEADER, cached.cursor);
    return transformHttpEventStream(
      runHttpRequest(() => this.fetch(`${this.runtimeUrl}/agent/${this.agentId}/connect`, { ...init, headers })),
    ).pipe(
      concatMap((event) => {
        if (
          event.type === EventType.CUSTOM &&
          (event as { name?: string }).name === THREAD_HYDRATION_EVENT &&
          this.cache?.prepare
        ) {
          const snapshot = (event as unknown as { value: ThreadHydration<Message> }).value;
          return from(this.cache.prepare(input.threadId, snapshot.messages).then(() => event));
        }
        // Angular's interrupt controller learns pending decisions from a terminal event. An unchanged delta has no
        // such event, so restore this small piece of control state from the cache when the server accepts its cursor.
        if (
          event.type === EventType.CUSTOM &&
          (event as { name?: string }).name === REPLAY_RESET_EVENT &&
          (event as unknown as { value?: { reset?: boolean } }).value?.reset === false &&
          cached?.interrupts.length
        ) {
          return of(
            {
              type: EventType.RUN_FINISHED,
              threadId: input.threadId,
              runId: input.runId,
              outcome: { type: 'interrupt', interrupts: cached.interrupts },
            } as BaseEvent,
            event,
          );
        }
        return of(event);
      }),
    );
  }

  protected override apply(
    input: RunAgentInput,
    events: Observable<BaseEvent>,
    subscribers: AgentSubscriber[],
  ): Observable<AgentStateMutation> {
    const epoch = ++this.applyEpoch;
    let liveHydration = false;
    const checkpoints = events.pipe(
      concatMap((event) => {
        const cursor = event.metadata?.[REPLAY_CURSOR_METADATA];
        // Insert after protocol validation and before the serial reducer. Checkpoints observe fully applied messages, not queued events.
        if (typeof cursor !== 'string') return of(event);
        const checkpoint = { type: EventType.CUSTOM, name: REPLAY_CHECKPOINT_EVENT, value: cursor } as BaseEvent;
        // Let the snapshot's first render settle before bookkeeping/terminal lifecycle work. This is one
        // boundary per hydration, not a delayed replay of its historical events; live deltas stay ordered.
        return event.type === EventType.CUSTOM && (event as { name?: string }).name === THREAD_HYDRATION_EVENT
          ? concat(of(event), scheduled([checkpoint], asyncScheduler))
          : of(event, checkpoint);
      }),
    );
    return super.apply(input, checkpoints, [
      ...subscribers,
      {
        onCustomEvent: ({ event }) => {
          if (this.threadId !== input.threadId || epoch !== this.applyEpoch) return undefined;
          if (event.name === THREAD_HYDRATION_EVENT) {
            const snapshot = event.value as ThreadHydration<Message>;
            liveHydration = snapshot.running === true;
            this.pendingInterrupts = [];
            // One mutation installs the state. Historical tool/text chunks never enter the UI reducer.
            return { messages: snapshot.messages, state: snapshot.state, stopPropagation: true };
          }
          if (event.name === REPLAY_RESET_EVENT && (event.value as { reset?: boolean })?.reset) {
            this.cache?.forget(input.threadId);
            this.pendingInterrupts = [];
            // A raw replay of a running thread (a background agent's transcript) has no hydration snapshot: it is ready at
            // its first checkpoint, and the live feed follows the stored events.
            if ((event.value as { running?: boolean }).running === true) liveHydration = true;
            return { messages: [], state: {}, stopPropagation: true };
          }
          if (event.name === REPLAY_CHECKPOINT_EVENT && typeof event.value === 'string') {
            this.cache?.record(input.threadId, {
              cursor: event.value,
              messages: this.messages,
              state: this.state,
              interrupts: structuredClone(this.pendingInterrupts),
            });
            if (liveHydration) {
              liveHydration = false;
              this.cache?.ready?.(input.threadId);
            }
            return { stopPropagation: true };
          }
          return undefined;
        },
      },
    ]);
  }
}
