/**
 * The subset of pi's session events and messages that `mapEvent` reads.
 *
 * Deliberately structural: this library does not import the pi package (only `PiSessionService`
 * does), and the same shapes arrive from `session.subscribe()` in process and from
 * `pi --mode json`. Fixtures in `../fixtures` are recorded from the real SDK and checked in tests.
 */

/** Any event delivered by `session.subscribe()`; `mapEvent` narrows on `type`. */
export interface PiEvent {
  type: string;
  [key: string]: unknown;
}

export interface PiTextContent {
  type: 'text';
  text: string;
}

export interface PiToolCall {
  type: 'toolCall';
  id: string;
  name: string;
  arguments?: Record<string, unknown>;
}

export interface PiUsage {
  totalTokens?: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost?: { total?: number };
}

export interface PiAssistantMessage {
  role: 'assistant';
  content?: Array<{ type: string; id?: string; name?: string }>;
  provider?: string;
  model?: string;
  thinkingLevel?: string;
  usage?: PiUsage;
  stopReason?: 'pending' | 'stop' | 'length' | 'toolUse' | 'error' | 'aborted' | 'deferred';
  errorMessage?: string;
}

export interface PiMessage {
  role: string;
  [key: string]: unknown;
}

/** `message_update.assistantMessageEvent`: SDK events carry `partial`, JSON mode adds `id`/`toolName` instead. */
export interface PiAssistantMessageEvent {
  type: string;
  contentIndex?: number;
  delta?: string;
  content?: string;
  id?: string;
  toolName?: string;
  toolCall?: PiToolCall;
  partial?: { content?: Array<{ type: string; id?: string; name?: string }> };
}

export interface PiToolResult {
  content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  structuredContent?: unknown;
  details?: unknown;
}
