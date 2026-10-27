import { toolImages } from './tool-images';
import { type BaseEvent, EventType } from '@ag-ui/core';
import {
  A2UI_SURFACE_ACTIVITY,
  MCP_APPS_ACTIVITY,
  a2uiOperationsOf,
  activityId,
  genUiId,
  mcpServerHash,
  type PiActivityContent,
  type PiActivityType,
  type PiCustomEvent,
} from '@pi-kit/protocol';
import { normalizeA2uiOperations } from './a2ui';
import { OPEN_GENERATIVE_UI_ACTIVITY, openGenerativeUiOf } from '@pi-kit/protocol';
import { addedFileHunks, parseUnifiedPatch } from './diff';
import type {
  PiAssistantMessage,
  PiAssistantMessageEvent,
  PiEvent,
  PiMessage,
  PiToolResult,
} from './pi-events';

/**
 * pi session event → AG-UI events (table, CUSTOM events).
 *
 * `mapEvent` has no I/O and never touches pi: feed it the events from `session.subscribe()` in
 * order, with one context per run. The context carries the small amount of state the mapping needs
 * (which blocks are open, the current assistant message id, a pending error). `RUN_STARTED` is not
 * produced here: whoever accepts the run emits it before the first pi event.
 *
 * pi-kit's additions: every tool call also gets a `pi.tool` activity (status, start time and
 * the latest `tool_execution_update` boiled down to one line), `bash` calls a streaming `pi.bash`
 * activity, `edit` / `write` calls a `pi.diff` activity, a finished compaction a `pi.compaction`
 * marker, and user messages that arrive mid-run (steering, follow-ups) are replayed as user text
 * messages. A stopped run ends with `RUN_FINISHED { result: { aborted: true } }`, not `RUN_ERROR`.
 * A custom message an extension displays (`pi.sendMessage` with `display: true`) is a user text message too.
 *
 * Not mapped (returns `[]`): system messages, custom messages that are not displayed, `summarization_retry_*`,
 * `bash_execution_update`. Extension dialogs are not session events at all; they reach the host
 * through the `uiContext` passed to `bindExtensions()` and `PiAgent` turns them into interrupts.
 */

type BlockKind = 'text' | 'reasoning' | 'tool';

interface Block {
  kind: BlockKind;
  /** AG-UI message id (text, reasoning) or tool call id. */
  id: string;
  sawDelta: boolean;
}

export interface MapState {
  /** AG-UI id of the assistant message currently streaming (or the last one, for late tool calls). */
  assistantId?: string;
  /** Epoch milliseconds when that assistant message started streaming (the request was made), for the usage line's duration. */
  assistantStartedAt?: number;
  /** Open content blocks of the streaming assistant message by pi `contentIndex`. */
  blocks: Map<number, Block>;
  /** Tool call ids already announced with `TOOL_CALL_START`. */
  announcedToolCalls: Set<string>;
  textBlocks: number;
  /** Tool calls that have started executing, by id (activity rows, streaming output, elapsed time). */
  tools: Map<string, ToolState>;
  /** How many of pi's next user messages are the prompt this run was started with (the client already has it). */
  skipUserMessages: number;
  model?: { provider: string; modelId: string };
  thinkingLevel?: string;
  pendingError?: string;
  pendingAbort: boolean;
  finished: boolean;
}

interface ToolState {
  name: string;
  args: Record<string, unknown>;
  startedAt: number;
  /** Time of the last streamed update, for throttling. */
  lastEmit: number;
  lastOutput: string;
}

export interface MapContext {
  threadId: string;
  /** Mutable: a run that resumes an interrupted one carries this context over and gets its own run id. */
  runId: string;
  newId: () => string;
  now: () => number;
  /**
   * Which MCP tools link an MCP App: the `ui://` resource of a server's tool, if it has one. The adapter
   * does not know pi's connections, the backend does. Without it MCP results are plain tool results.
   */
  mcpApp?: (server: string, tool: string) => string | undefined;
  state: MapState;
}

/** Streamed tool output is forwarded at most this often; the final result is always sent. */
export const TOOL_UPDATE_INTERVAL_MS = 120;

export interface MapContextOptions {
  threadId: string;
  runId: string;
  /** Id generator; defaults to `crypto.randomUUID`. Inject a counter in tests. */
  newId?: () => string;
  /** Clock in epoch milliseconds; defaults to `Date.now`. Inject one in tests. */
  now?: () => number;
  /** pi's user messages to swallow before replaying any (default 1: the run's own prompt; 0 when attaching mid-run). */
  skipUserMessages?: number;
  /** The session's model when the run starts, so `pi.model` is only emitted on a change. */
  model?: { provider: string; modelId: string };
  thinkingLevel?: string;
  /** See `MapContext.mcpApp`. */
  mcpApp?: MapContext['mcpApp'];
}

export function createMapContext(options: MapContextOptions): MapContext {
  return {
    threadId: options.threadId,
    runId: options.runId,
    newId: options.newId ?? (() => globalThis.crypto.randomUUID()),
    now: options.now ?? Date.now,
    ...(options.mcpApp ? { mcpApp: options.mcpApp } : {}),
    state: {
      blocks: new Map(),
      announcedToolCalls: new Set(),
      tools: new Map(),
      skipUserMessages: options.skipUserMessages ?? 1,
      textBlocks: 0,
      model: options.model,
      thinkingLevel: options.thinkingLevel,
      pendingAbort: false,
      finished: false,
    },
  };
}

const custom = (event: PiCustomEvent): BaseEvent =>
  ({ type: EventType.CUSTOM, name: event.name, value: event.value }) as BaseEvent;

function activity<T extends PiActivityType>(id: string, type: T, content: PiActivityContent<T>): BaseEvent {
  return {
    type: EventType.ACTIVITY_SNAPSHOT,
    messageId: id,
    activityType: type,
    content,
    replace: true,
  } as BaseEvent;
}

/** The `pi.review` activity of a user turn that carried review comments; `entryId` is the `pi-kit.review` custom entry. */
export function reviewActivity(entryId: string, comments: PiActivityContent<'pi.review'>['comments']): BaseEvent {
  return activity(activityId.review(entryId), 'pi.review', { comments });
}

/** The `pi.skills` activity of a user turn that carried skill or template chips; `entryId` is the `pi-kit.skills` custom entry. */
export function skillsActivity(entryId: string, chips: PiActivityContent<'pi.skills'>['chips']): BaseEvent {
  return activity(activityId.skills(entryId), 'pi.skills', { chips });
}

export function mapEvent(event: PiEvent, ctx: MapContext): BaseEvent[] {
  const { state } = ctx;
  if (state.finished) return [];

  switch (event.type) {
    case 'message_start':
      return onMessageStart(event['message'] as PiMessage, ctx);
    case 'message_update':
      return onMessageUpdate(event['assistantMessageEvent'] as PiAssistantMessageEvent, ctx);
    case 'message_end':
      return onMessageEnd(event['message'] as PiMessage, ctx);

    case 'tool_execution_start':
      return onToolExecutionStart(event, ctx);
    case 'tool_execution_update':
      return onToolExecutionUpdate(event, ctx);
    case 'tool_execution_end':
      return onToolExecutionEnd(event, ctx);

    case 'agent_settled':
      return onSettled(event['aborted'] === true, ctx);

    case 'queue_update':
      return [
        custom({
          name: 'pi.queue',
          value: {
            steer: lengthOf(event['steering']),
            followUp: lengthOf(event['followUp']),
            steerTexts: textsOf(event['steering']),
            followUpTexts: textsOf(event['followUp']),
          },
        }),
      ];
    case 'compaction_start':
      return [custom({ name: 'pi.compaction', value: { phase: 'start' } })];
    case 'compaction_end': {
      const result = event['result'] as
        | { tokensBefore?: number; estimatedTokensAfter?: number; firstKeptEntryId?: string; summary?: string }
        | undefined;
      const out: BaseEvent[] = [
        custom({
          name: 'pi.compaction',
          value: { phase: 'end', tokensBefore: result?.tokensBefore, tokensAfter: result?.estimatedTokensAfter },
        }),
      ];
      // The marker is a transcript message so it keeps its place; its id matches `sessionToMessages()`.
      if (result?.firstKeptEntryId && event['aborted'] !== true) {
        out.push(
          activity(activityId.compaction(result.firstKeptEntryId), 'pi.compaction', {
            tokensBefore: result.tokensBefore,
            tokensAfter: result.estimatedTokensAfter,
            summary: result.summary,
          }),
        );
      }
      return out;
    }
    case 'auto_retry_start':
      return [
        custom({
          name: 'pi.retry',
          value: {
            attempt: Number(event['attempt']),
            maxAttempts: Number(event['maxAttempts']),
            reason: String(event['errorMessage'] ?? ''),
          },
        }),
      ];
    case 'auto_retry_end':
      if (event['success'] === true) state.pendingError = undefined;
      return [];
    case 'session_info_changed':
      return [custom({ name: 'pi.session_info', value: { name: event['name'] as string | undefined } })];
    case 'thinking_level_changed': {
      state.thinkingLevel = String(event['level']);
      return state.model
        ? [
            custom({
              name: 'pi.model',
              value: { ...state.model, thinkingLevel: state.thinkingLevel },
            }),
          ]
        : [];
    }
    case 'entry_appended': {
      const id = (event['entry'] as { id?: string } | undefined)?.id;
      return id ? [custom({ name: 'pi.tree', value: { leafId: id, changed: [id] } })] : [];
    }
    default:
      return [];
  }
}

function lengthOf(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

/** The queued messages of a `queue_update`, as the strings pi holds them (expanded skill and template text included). */
function textsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function onMessageStart(message: PiMessage | undefined, ctx: MapContext): BaseEvent[] {
  if (message?.role !== 'assistant') return [];
  const { state } = ctx;
  const assistant = message as unknown as PiAssistantMessage;
  state.assistantId = ctx.newId();
  state.assistantStartedAt = ctx.now();
  state.blocks.clear();
  state.textBlocks = 0;
  // A new assistant message after a failed one means pi retried; the earlier error is superseded.
  state.pendingError = undefined;
  const out: BaseEvent[] = [];
  if (assistant.provider && assistant.model) {
    const changed = state.model?.provider !== assistant.provider || state.model?.modelId !== assistant.model;
    state.model = { provider: assistant.provider, modelId: assistant.model };
    if (assistant.thinkingLevel) state.thinkingLevel = assistant.thinkingLevel;
    if (changed) out.push(custom({ name: 'pi.model', value: { ...state.model, thinkingLevel: state.thinkingLevel } }));
  }
  return out;
}

function onMessageUpdate(update: PiAssistantMessageEvent | undefined, ctx: MapContext): BaseEvent[] {
  if (!update || update.contentIndex === undefined) return [];
  const { state } = ctx;
  const index = update.contentIndex;
  const block = state.blocks.get(index);

  switch (update.type) {
    case 'text_start':
      return openText(index, ctx);
    case 'text_delta':
      return block?.kind === 'text' && update.delta ? textDelta(block, update.delta) : [];
    case 'text_end':
      return block?.kind === 'text' ? closeBlock(index, block, ctx, update.content) : [];

    case 'thinking_start':
      return openReasoning(index, ctx);
    case 'thinking_delta':
      return block?.kind === 'reasoning' && update.delta ? reasoningDelta(block, update.delta) : [];
    case 'thinking_end':
      return block?.kind === 'reasoning' ? closeBlock(index, block, ctx, update.content) : [];

    case 'toolcall_start':
      return openTool(update, ctx);
    case 'toolcall_delta':
      if (block?.kind !== 'tool' || !update.delta) return [];
      block.sawDelta = true;
      return [{ type: EventType.TOOL_CALL_ARGS, toolCallId: block.id, delta: update.delta } as BaseEvent];
    case 'toolcall_end': {
      if (block?.kind !== 'tool') return [];
      const out: BaseEvent[] = [];
      if (!block.sawDelta && update.toolCall?.arguments) {
        out.push({
          type: EventType.TOOL_CALL_ARGS,
          toolCallId: block.id,
          delta: JSON.stringify(update.toolCall.arguments),
        } as BaseEvent);
      }
      out.push(...closeBlock(index, block, ctx));
      return out;
    }
    default:
      return [];
  }
}

function openText(index: number, ctx: MapContext): BaseEvent[] {
  const { state } = ctx;
  const parent = assistantId(ctx);
  // The first text block takes the assistant message id so tool calls (whose parent is that id)
  // attach to the same AG-UI assistant message.
  const id = state.textBlocks === 0 ? parent : `${parent}:${index}`;
  state.textBlocks += 1;
  state.blocks.set(index, { kind: 'text', id, sawDelta: false });
  return [{ type: EventType.TEXT_MESSAGE_START, messageId: id, role: 'assistant' } as BaseEvent];
}

function textDelta(block: Block, delta: string): BaseEvent[] {
  block.sawDelta = true;
  return [{ type: EventType.TEXT_MESSAGE_CONTENT, messageId: block.id, delta } as BaseEvent];
}

function openReasoning(index: number, ctx: MapContext): BaseEvent[] {
  const id = `${assistantId(ctx)}:r${index}`;
  ctx.state.blocks.set(index, { kind: 'reasoning', id, sawDelta: false });
  return [
    { type: EventType.REASONING_START, messageId: id, timestamp: ctx.now() } as BaseEvent,
    { type: EventType.REASONING_MESSAGE_START, messageId: id, role: 'reasoning' } as BaseEvent,
  ];
}

function reasoningDelta(block: Block, delta: string): BaseEvent[] {
  block.sawDelta = true;
  return [{ type: EventType.REASONING_MESSAGE_CONTENT, messageId: block.id, delta } as BaseEvent];
}

function openTool(update: PiAssistantMessageEvent, ctx: MapContext): BaseEvent[] {
  const index = update.contentIndex as number;
  const fromPartial = update.partial?.content?.[index];
  const id = update.id ?? fromPartial?.id;
  const name = update.toolName ?? fromPartial?.name;
  if (!id || !name) return [];
  ctx.state.blocks.set(index, { kind: 'tool', id, sawDelta: false });
  ctx.state.announcedToolCalls.add(id);
  return [
    {
      type: EventType.TOOL_CALL_START,
      toolCallId: id,
      toolCallName: name,
      parentMessageId: assistantId(ctx),
    } as BaseEvent,
  ];
}

/** Emits the closing events for an open block, after catching up on content the deltas never carried. */
function closeBlock(index: number, block: Block, ctx: MapContext, finalContent?: string): BaseEvent[] {
  const out: BaseEvent[] = [];
  ctx.state.blocks.delete(index);
  switch (block.kind) {
    case 'text':
      if (!block.sawDelta && finalContent) out.push(...textDelta(block, finalContent));
      out.push({ type: EventType.TEXT_MESSAGE_END, messageId: block.id } as BaseEvent);
      break;
    case 'reasoning':
      if (!block.sawDelta && finalContent) out.push(...reasoningDelta(block, finalContent));
      out.push(
        { type: EventType.REASONING_MESSAGE_END, messageId: block.id } as BaseEvent,
        { type: EventType.REASONING_END, messageId: block.id, timestamp: ctx.now() } as BaseEvent,
      );
      break;
    case 'tool':
      out.push({ type: EventType.TOOL_CALL_END, toolCallId: block.id } as BaseEvent);
      break;
  }
  return out;
}

/** Closing events for whatever text, reasoning and tool-call blocks are open, e.g. before a run ends in an interrupt. */
export function closeOpenBlocks(ctx: MapContext): BaseEvent[] {
  return flushBlocks(ctx);
}

function flushBlocks(ctx: MapContext): BaseEvent[] {
  const out: BaseEvent[] = [];
  for (const [index, block] of [...ctx.state.blocks]) out.push(...closeBlock(index, block, ctx));
  return out;
}

function onMessageEnd(message: PiMessage | undefined, ctx: MapContext): BaseEvent[] {
  if (message?.role === 'user') return onUserMessageEnd(message, ctx);
  // A custom message an extension displays (`pi.sendMessage` with `display: true`): a user-side note, as `sessionToMessages` renders it.
  if (message?.role === 'custom') return message['display'] === true ? userMessage(message, ctx) : [];
  if (message?.role !== 'assistant') return [];
  const assistant = message as unknown as PiAssistantMessage;
  const out = flushBlocks(ctx);
  if (assistant.stopReason === 'error') ctx.state.pendingError = assistant.errorMessage ?? 'The model request failed.';
  if (assistant.stopReason === 'aborted') ctx.state.pendingAbort = true;
  const usage = assistant.usage;
  if (usage && assistant.stopReason !== 'pending') {
    out.push(
      custom({
        name: 'pi.usage',
        value: {
          input: usage.input,
          output: usage.output,
          cacheRead: usage.cacheRead,
          cacheWrite: usage.cacheWrite,
          cost: usage.cost?.total ?? 0,
          contextTokens: usage.totalTokens ?? usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
        },
      }),
      // The same numbers as a transcript message, so the usage line under the turn is there in history too.
      activity(activityId.usage(assistantId(ctx)), 'pi.turn_usage', {
        input: usage.input,
        output: usage.output,
        cacheRead: usage.cacheRead,
        cacheWrite: usage.cacheWrite,
        cost: usage.cost?.total ?? 0,
        ...(ctx.state.assistantStartedAt !== undefined ? { elapsedMs: Math.max(0, ctx.now() - ctx.state.assistantStartedAt) } : {}),
        ...(assistant.provider ? { provider: assistant.provider } : {}),
        ...(assistant.model ? { model: assistant.model } : {}),
        ...(assistant.thinkingLevel ? { thinkingLevel: assistant.thinkingLevel } : {}),
      }),
    );
  }
  return out;
}

/** A message the user sent while the run was going (steer / follow-up): shown as a user message. */
function onUserMessageEnd(message: PiMessage, ctx: MapContext): BaseEvent[] {
  if (ctx.state.skipUserMessages > 0) {
    ctx.state.skipUserMessages -= 1;
    return [];
  }
  return userMessage(message, ctx);
}

/** The text of a message on the user's side, as one user message. */
function userMessage(message: PiMessage, ctx: MapContext): BaseEvent[] {
  const content = message['content'];
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.map((part: { type?: string; text?: string }) => (part.type === 'text' ? (part.text ?? '') : '')).join('')
        : '';
  if (!text.trim()) return [];
  const messageId = ctx.newId();
  return [
    { type: EventType.TEXT_MESSAGE_START, messageId, role: 'user' } as BaseEvent,
    { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: text } as BaseEvent,
    { type: EventType.TEXT_MESSAGE_END, messageId } as BaseEvent,
  ];
}

const toolArgs = (event: PiEvent): Record<string, unknown> => {
  const args = event['args'];
  return args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
};

const toolActivity = (id: string, tool: ToolState, patch: Partial<PiActivityContent<'pi.tool'>> = {}): BaseEvent =>
  activity(activityId.tool(id), 'pi.tool', {
    toolCallId: id,
    toolName: tool.name,
    status: 'running',
    startedAt: tool.startedAt,
    ...patch,
  });

const bashActivity = (id: string, tool: ToolState, patch: Partial<PiActivityContent<'pi.bash'>>): BaseEvent =>
  activity(activityId.bash(id), 'pi.bash', {
    command: String(tool.args['command'] ?? ''),
    output: '',
    running: true,
    ...patch,
  });

function onToolExecutionStart(event: PiEvent, ctx: MapContext): BaseEvent[] {
  const id = String(event['toolCallId']);
  const out: BaseEvent[] = [];
  if (!ctx.state.announcedToolCalls.has(id)) {
    // A call the model never emitted itself, e.g. one a codemode script made through `ctx.executeTool()`.
    ctx.state.announcedToolCalls.add(id);
    out.push(
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: id,
        toolCallName: String(event['toolName']),
        parentMessageId: assistantId(ctx),
      } as BaseEvent,
      { type: EventType.TOOL_CALL_ARGS, toolCallId: id, delta: JSON.stringify(event['args'] ?? {}) } as BaseEvent,
      { type: EventType.TOOL_CALL_END, toolCallId: id } as BaseEvent,
    );
  }
  if (!ctx.state.tools.has(id)) {
    const now = ctx.now();
    const tool: ToolState = { name: String(event['toolName']), args: toolArgs(event), startedAt: now, lastEmit: now, lastOutput: '' };
    ctx.state.tools.set(id, tool);
    out.push(toolActivity(id, tool));
    if (tool.name === 'bash') out.push(bashActivity(id, tool, {}));
  }
  return out;
}

/** Partial output of a running tool: the row's live sub-line and, for bash, the streaming terminal block. */
function onToolExecutionUpdate(event: PiEvent, ctx: MapContext): BaseEvent[] {
  const id = String(event['toolCallId']);
  const out: BaseEvent[] = [];
  if (!ctx.state.tools.has(id)) out.push(...onToolExecutionStart(event, ctx));
  const tool = ctx.state.tools.get(id) as ToolState;
  const text = resultText(event['partialResult'] as PiToolResult | undefined);
  const now = ctx.now();
  if (text === tool.lastOutput || now - tool.lastEmit < TOOL_UPDATE_INTERVAL_MS) return out;
  tool.lastOutput = text;
  tool.lastEmit = now;
  out.push(toolActivity(id, tool, { progress: lastLine(text) }));
  if (tool.name === 'bash') out.push(bashActivity(id, tool, { output: text }));
  return out;
}

function onToolExecutionEnd(event: PiEvent, ctx: MapContext): BaseEvent[] {
  const id = String(event['toolCallId']);
  const out: BaseEvent[] = [];
  if (!ctx.state.announcedToolCalls.has(id) || !ctx.state.tools.has(id)) out.push(...onToolExecutionStart(event, ctx));
  const tool = ctx.state.tools.get(id) as ToolState;
  const result = event['result'] as PiToolResult | undefined;
  const text = resultText(result);
  const isError = event['isError'] === true;
  const durationMs = typeof event['durationMs'] === 'number' ? event['durationMs'] : ctx.now() - tool.startedAt;

  out.push(toolActivity(id, tool, { status: isError ? 'error' : 'done', durationMs, progress: lastLine(text), images: toolImages(result?.content) }));
  if (tool.name === 'bash') {
    const structured = result?.structuredContent as { exit_code?: number; truncated?: boolean } | undefined;
    const exitCode = structured?.exit_code ?? exitCodeFromText(text);
    out.push(
      bashActivity(id, tool, {
        output: text,
        running: false,
        ...(exitCode !== undefined ? { exitCode } : {}),
        ...(structured?.truncated ? { truncated: true } : {}),
        ...(isError && exitCode === undefined && /aborted/i.test(text) ? { cancelled: true } : {}),
      }),
    );
  } else if (!isError && tool.name === 'edit') {
    const patch = (result as { details?: { patch?: string } } | undefined)?.details?.patch;
    const hunks = typeof patch === 'string' ? parseUnifiedPatch(patch) : [];
    if (hunks.length > 0) {
      out.push(activity(activityId.diff(id), 'pi.diff', { path: String(tool.args['path'] ?? ''), hunks, toolCallId: id }));
    }
  } else if (!isError && tool.name === 'write' && typeof tool.args['content'] === 'string') {
    out.push(
      activity(activityId.diff(id), 'pi.diff', {
        path: String(tool.args['path'] ?? ''),
        hunks: addedFileHunks(tool.args['content']),
        toolCallId: id,
        written: true,
      }),
    );
  }
  if (!isError) out.push(...genUiActivities(id, tool, result, text, ctx));
  ctx.state.tools.delete(id);
  out.push({
    type: EventType.TOOL_CALL_RESULT,
    messageId: ctx.newId(),
    toolCallId: id,
    content: text,
    role: 'tool',
  } as BaseEvent);
  return out;
}

/**
 * Generative UI a finished tool call asks:
 * - `details.open_generative_ui` (the arguments of a `generateSandboxedUi` call) becomes an `open-generative-ui` activity.
 * - `details.a2ui_operations` becomes an `a2ui-surface` activity. (A result whose *text* is the JSON container is
 *   left to the runtime's A2UI middleware, which looks for exactly that in `TOOL_CALL_RESULT`.)
 * - a call to an MCP tool that links a `ui://` resource becomes an `mcp-apps` activity with the call's result and input.
 */
function genUiActivities(id: string, tool: ToolState, result: PiToolResult | undefined, text: string, ctx: MapContext): BaseEvent[] {
  const out: BaseEvent[] = [];
  const details = result?.details;
  const openUi = openGenerativeUiOf(details);
  if (openUi) out.push({ type: EventType.ACTIVITY_SNAPSHOT, messageId: `${id}-activity`, activityType: OPEN_GENERATIVE_UI_ACTIVITY, content: openUi, replace: true } as BaseEvent);
  const found = a2uiOperationsOf({ details });
  const operations = found && normalizeA2uiOperations(found);
  if (operations) {
    out.push({
      type: EventType.ACTIVITY_SNAPSHOT,
      messageId: genUiId.a2uiSurface(id),
      activityType: A2UI_SURFACE_ACTIVITY,
      content: { a2ui_operations: operations },
      replace: true,
    } as BaseEvent);
  }
  const mcp = details as { server?: unknown; tool?: unknown } | undefined;
  if (ctx.mcpApp && typeof mcp?.server === 'string' && typeof mcp.tool === 'string') {
    const resourceUri = ctx.mcpApp(mcp.server, mcp.tool);
    if (resourceUri) {
      out.push({
        type: EventType.ACTIVITY_SNAPSHOT,
        messageId: genUiId.mcpApp(id),
        activityType: MCP_APPS_ACTIVITY,
        content: {
          serverHash: mcpServerHash(mcp.server),
          serverId: mcp.server,
          tool: mcp.tool,
          resourceUri,
          result: mcpAppResult(result, text),
          toolInput: tool.args,
        },
        replace: true,
      } as BaseEvent);
    }
  }
  return out;
}

/** The result an MCP App is told about: the MCP `CallToolResult` pi kept (`structuredContent`), else the text pi gave the model. */
export function mcpAppResult(result: PiToolResult | undefined, text: string): Record<string, unknown> {
  const structured = result?.structuredContent;
  if (structured && typeof structured === 'object' && !Array.isArray(structured) && Array.isArray((structured as { content?: unknown }).content)) {
    return structured as Record<string, unknown>;
  }
  return { content: text ? [{ type: 'text', text }] : [] };
}

/** The last non-empty line of a tool's output, trimmed to one short sentence for the row's sub-line. */
export function lastLine(text: string): string | undefined {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line) return line.length > 200 ? `${line.slice(0, 199)}…` : line;
  }
  return undefined;
}

function exitCodeFromText(text: string): number | undefined {
  const match = /Command exited with code (\d+)/.exec(text);
  return match ? Number(match[1]) : undefined;
}

function resultText(result: PiToolResult | undefined): string {
  return (result?.content ?? []).map((part) => (part.type === 'text' ? (part.text ?? '') : `[${part.type}]`)).join('');
}

function onSettled(aborted: boolean, ctx: MapContext): BaseEvent[] {
  const { state } = ctx;
  const out = flushBlocks(ctx);
  state.finished = true;
  if (aborted || state.pendingAbort) {
    // Standard cancellation, with the legacy marker retained for existing clients and stored logs.
    out.push({
      type: EventType.RUN_FINISHED,
      threadId: ctx.threadId,
      runId: ctx.runId,
      outcome: { type: 'cancelled' },
      result: { aborted: true },
    } as BaseEvent);
  } else if (state.pendingError) {
    out.push({ type: EventType.RUN_ERROR, message: state.pendingError, code: 'error' } as BaseEvent);
  } else {
    out.push({
      type: EventType.RUN_FINISHED,
      threadId: ctx.threadId,
      runId: ctx.runId,
      outcome: { type: 'success' },
    } as BaseEvent);
  }
  return out;
}

function assistantId(ctx: MapContext): string {
  ctx.state.assistantId ??= ctx.newId();
  return ctx.state.assistantId;
}
