import { InjectionToken, type Type } from '@angular/core';
import { COLLAPSE_ABOVE_CALLS, MAX_IMAGE_BYTES } from '@pi-kit/chat/util';

export interface ChatPolicy {
  readonly noticeMs: number;
  readonly eventFreshMs: number;
  readonly pinnedThreads: number;
  readonly cycleToastMs: number;
  readonly maxImageBytes: number;
  readonly collapseAboveCalls: number;
  readonly connectRetries: number;
  readonly connectRetryMs: number;
  readonly reconnectWaitMs: number;
}

export const DEFAULT_CHAT_POLICY: ChatPolicy = {
  noticeMs: 9000,
  eventFreshMs: 20000,
  pinnedThreads: 50,
  cycleToastMs: 1500,
  maxImageBytes: MAX_IMAGE_BYTES,
  collapseAboveCalls: COLLAPSE_ABOVE_CALLS,
  connectRetries: 5,
  connectRetryMs: 1000,
  reconnectWaitMs: 10000,
};

export const CHAT_POLICY = new InjectionToken<ChatPolicy>('CHAT_POLICY', {
  providedIn: 'root',
  factory: () => DEFAULT_CHAT_POLICY,
});

/**
 * Which AG-UI agent a `ChatStore` follows: `pi`, the thread, by default; `pi-bg` for a background agent's transcript, which a
 * component provides together with its own `ChatStore` and a `ThreadsStore` stand-in whose selection is the agent. Without `session`, the
 * store leaves the session API alone (commands, models, stats, feedback, queue): an agent has none of them.
 */
export interface ChatAgent {
  readonly agentId: string;
  readonly session: boolean;
}
export const CHAT_AGENT = new InjectionToken<ChatAgent>('CHAT_AGENT', {
  providedIn: 'root',
  factory: () => ({ agentId: 'pi', session: true }),
});

/** The transcript component of the chat feature, for a page outside it that draws a transcript (the Agents panel); the shell provides it. */
export const TRANSCRIPT_VIEW = new InjectionToken<Type<unknown>>('TRANSCRIPT_VIEW');
/** The composer of a background agent's transcript: the chat domain's agent input container, handed to the agents domain the same way. */
export const AGENT_INPUT_VIEW = new InjectionToken<Type<unknown>>('AGENT_INPUT_VIEW');
