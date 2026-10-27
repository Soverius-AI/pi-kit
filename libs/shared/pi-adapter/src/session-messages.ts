import { toolImages } from './tool-images';
import type { InputContent, Message } from '@ag-ui/core';
import {
  A2UI_SURFACE_ACTIVITY,
  MCP_APPS_ACTIVITY,
  a2uiOperationsOf,
  activityId,
  genUiId,
  mcpServerHash,
  type PiActivityContent,
  type PiActivityType,
  REVIEW_ENTRY_TYPE,
  ReviewBatchSchema,
  SKILLS_ENTRY_TYPE,
  type SkillsEntry,
  SkillsEntrySchema,
} from '@pi-kit/protocol';
import { normalizeA2uiOperations } from './a2ui';
import { OPEN_GENERATIVE_UI_ACTIVITY, openGenerativeUiOf } from '@pi-kit/protocol';
import { addedFileHunks, parseUnifiedPatch } from './diff';

/**
 * One entry of a pi session file (`SessionManager.getBranch()`), structurally typed so this library
 * never imports the pi package. See pi's `session-format.md`.
 */
export interface PiSessionEntry {
  type: string;
  id: string;
  parentId?: string | null;
  timestamp?: string;
  [key: string]: unknown;
}

interface PiContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
  data?: string;
  mimeType?: string;
}

interface PiStoredMessage {
  role: string;
  content?: string | PiContentBlock[];
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  stopReason?: string;
  usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } };
  provider?: string;
  model?: string;
  thinkingLevel?: string;
  details?: { patch?: string; truncation?: { truncated?: boolean }; server?: string; tool?: string; a2ui_operations?: unknown; open_generative_ui?: unknown } | undefined;
  durationMs?: number;
  timestamp?: number;
  // bashExecution
  command?: string;
  output?: string;
  exitCode?: number;
  cancelled?: boolean;
  truncated?: boolean;
}

const activityMessage = <T extends PiActivityType>(id: string, type: T, content: PiActivityContent<T>): Message =>
  ({ id, role: 'activity', activityType: type, content }) as Message;

interface KnownCall {
  name: string;
  args: Record<string, unknown>;
}

export interface SessionToMessagesOptions {
  /** The `ui://` resource an MCP tool links (see `MapContext.mcpApp`); without it MCP App surfaces are not rebuilt. */
  mcpApp?: (server: string, tool: string) => string | undefined;
}

/**
 * The AG-UI transcript for the active branch of a pi session, in the shape the live stream builds
 * one `reasoning` message per thinking block, the first text block under the pi entry id
 * (which is also where the tool calls hang), further text blocks as `<id>:<contentIndex>`.
 *
 * Used for `MESSAGES_SNAPSHOT` events: for threads that were never run through the app (created by
 * the pi CLI), and at the end of every run so the snapshot is the canonical history.
 *
 * `branch` is root-to-leaf, as `getBranch()` returns it. Entries that are not conversation turns
 * (model and thinking changes, usage, labels, session_info, custom entries) and the leading system
 * messages produce nothing; compactions and branch summaries become marker activities.
 */
export function sessionToMessages(branch: readonly PiSessionEntry[], options: SessionToMessagesOptions = {}): Message[] {
  const out: Message[] = [];
  // Tool calls still waiting for a result. A call the user moved on from (the run was killed while it
  // executed) gets a stand-in result, so the transcript does not show it as running forever; pi
  // itself does the same when it rebuilds the model context.
  const unanswered = new Map<string, string>();
  const calls = new Map<string, KnownCall>();
  // A `pi-kit.review` custom entry is written right before the prompt it belongs to; its activity goes
  // right after that user message, which is where the live stream puts it.
  let pendingReview: { id: string; comments: PiActivityContent<'pi.review'>['comments'] } | undefined;
  // A `pi-kit.skills` custom entry is written right before its prompt, too. The message after it holds the expanded instructions;
  // the transcript shows the sentence that was typed (the entry's `text`) and the chips (a `pi.skills` activity).
  let pendingSkills: { id: string; entry: SkillsEntry } | undefined;
  const byId = new Map(branch.map((e) => [e.id, e] as const));
  for (const entry of branch) {
    if (entry.type === 'custom' && entry['customType'] === REVIEW_ENTRY_TYPE) {
      const batch = ReviewBatchSchema.safeParse(entry['data']);
      if (batch.success) pendingReview = { id: entry.id, comments: batch.data.comments };
    } else if (entry.type === 'custom' && entry['customType'] === SKILLS_ENTRY_TYPE) {
      const chips = SkillsEntrySchema.safeParse(entry['data']);
      if (chips.success) pendingSkills = { id: entry.id, entry: chips.data };
    } else if (entry.type === 'compaction' && typeof entry['firstKeptEntryId'] === 'string') {
      out.push(
        activityMessage(activityId.compaction(entry['firstKeptEntryId']), 'pi.compaction', {
          tokensBefore: typeof entry['tokensBefore'] === 'number' ? entry['tokensBefore'] : undefined,
          summary: typeof entry['summary'] === 'string' ? entry['summary'] : undefined,
        }),
      );
    } else if (entry.type === 'branch_summary') {
      out.push(
        activityMessage(activityId.branchSummary(entry.id), 'pi.branch_summary', {
          summary: typeof entry['summary'] === 'string' ? entry['summary'] : undefined,
        }),
      );
    } else if (entry.type === 'message') {
      const message = entry['message'] as PiStoredMessage | undefined;
      if (!message) continue;
      if (message.role === 'bashExecution') {
        out.push(
          activityMessage(activityId.bash(`user:${entry.id}`), 'pi.bash', {
            command: message.command ?? '',
            output: message.output ?? '',
            running: false,
            user: true,
            ...(message.exitCode !== undefined ? { exitCode: message.exitCode } : {}),
            ...(message.cancelled ? { cancelled: true } : {}),
            ...(message.truncated ? { truncated: true } : {}),
          }),
        );
        continue;
      }
      if (message.role === 'user') {
        for (const [callId, name] of unanswered) out.push(interruptedResult(callId, name));
        unanswered.clear();
      }
      const produced = fromMessage(entry.id, message);
      if (message.role === 'user' && pendingSkills) produced.splice(0, produced.length, ...typedUserMessage(produced, pendingSkills.entry.text));
      for (const m of produced) {
        if (m.role === 'assistant') {
          for (const call of m.toolCalls ?? []) {
            unanswered.set(call.id, call.function.name);
            calls.set(call.id, { name: call.function.name, args: parseArgs(call.function.arguments) });
          }
        }
        if (m.role === 'tool') unanswered.delete(m.toolCallId);
      }
      out.push(...produced);
      if (message.role === 'assistant' && message.usage) out.push(turnUsage(entry, message, byId.get(String(entry.parentId))));
      if (message.role === 'user' && pendingReview) {
        out.push(activityMessage(activityId.review(pendingReview.id), 'pi.review', { comments: pendingReview.comments }));
        pendingReview = undefined;
      }
      if (message.role === 'user' && pendingSkills) {
        out.push(activityMessage(activityId.skills(pendingSkills.id), 'pi.skills', { chips: pendingSkills.entry.chips }));
        pendingSkills = undefined;
      }
      if (message.role === 'toolResult') out.push(...toolActivities(message, calls.get(String(message.toolCallId)), options));
    } else if (entry.type === 'custom_message' && entry['display'] === true) {
      // Extension messages shown in the transcript: render as a user-side note. A background agent's report keeps the
      // attribution its live events carried (`subagentEnvelope` in the backend builds the same id) and the agent's name, so a reload shows it.
      const text = textOf(entry['content'] as string | PiContentBlock[] | undefined);
      const subagentRunId = subagentRunIdOf(entry['customType'] as string | undefined, entry['details']);
      const subagentName = subagentRunId ? (entry['details'] as { name?: string } | undefined)?.name : undefined;
      if (text) out.push({ id: entry.id, role: 'user', content: text, ...(subagentRunId ? { subagentRunId } : {}), ...(subagentName ? { subagentName } : {}) });
    }
  }
  return out;
}

/**
 * The attribution id of a background agent's message in the main thread: a `pikit.agent-*` custom message (a report, a question,
 * the receipt of an answer) with the agent in its details gets `<agentId>/<ref>`, the same live (`subagentEnvelope`) and stored.
 */
export function subagentRunIdOf(customType: string | undefined, details: unknown): string | undefined {
  const d = details as { agentId?: string; ref?: string; reportId?: string } | undefined;
  if (!customType?.startsWith('pikit.agent-') || !d?.agentId) return undefined;
  return `${d.agentId}/${d.ref ?? d.reportId ?? customType.slice('pikit.agent-'.length)}`;
}

/** The `pi.turn_usage` activity of an assistant message (`mapEvent` makes the same live); the duration is the time since the entry above it. */
function turnUsage(entry: PiSessionEntry, message: PiStoredMessage, parent: PiSessionEntry | undefined): Message {
  const usage = message.usage ?? {};
  const end = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
  const start = parent?.timestamp ? Date.parse(parent.timestamp) : NaN;
  return activityMessage(activityId.usage(entry.id), 'pi.turn_usage', {
    input: usage.input ?? 0,
    output: usage.output ?? 0,
    cacheRead: usage.cacheRead ?? 0,
    cacheWrite: usage.cacheWrite ?? 0,
    cost: usage.cost?.total ?? 0,
    ...(Number.isFinite(end) && Number.isFinite(start) && end >= start ? { elapsedMs: end - start } : {}),
    ...(message.provider ? { provider: message.provider } : {}),
    ...(message.model ? { model: message.model } : {}),
    ...(message.thinkingLevel ? { thinkingLevel: message.thinkingLevel } : {}),
  });
}

function parseArgs(json: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(json);
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The activities the live stream would have produced for a finished tool call (see `mapEvent`). */
function toolActivities(message: PiStoredMessage, call: KnownCall | undefined, options: SessionToMessagesOptions): Message[] {
  const id = String(message.toolCallId ?? '');
  const name = message.toolName ?? call?.name ?? 'tool';
  const text = textOf(message.content);
  const out: Message[] = [];
  const durationMs = typeof message.durationMs === 'number' ? message.durationMs : undefined;
  out.push(
    activityMessage(activityId.tool(id), 'pi.tool', {
      toolCallId: id,
      toolName: name,
      status: message.isError ? 'error' : 'done',
      images: toolImages(message.content),
      startedAt: (message.timestamp ?? 0) - (durationMs ?? 0),
      ...(durationMs !== undefined ? { durationMs } : {}),
    }),
  );
  if (name === 'bash') {
    const code = /Command exited with code (\d+)/.exec(text);
    out.push(
      activityMessage(activityId.bash(id), 'pi.bash', {
        command: String(call?.args['command'] ?? ''),
        output: text,
        running: false,
        ...(code ? { exitCode: Number(code[1]) } : message.isError ? {} : { exitCode: 0 }),
      }),
    );
  } else if (!message.isError && name === 'edit' && typeof message.details?.patch === 'string') {
    const hunks = parseUnifiedPatch(message.details.patch);
    if (hunks.length > 0) {
      out.push(activityMessage(activityId.diff(id), 'pi.diff', { path: String(call?.args['path'] ?? ''), hunks, toolCallId: id }));
    }
  } else if (!message.isError && name === 'write' && typeof call?.args['content'] === 'string') {
    out.push(
      activityMessage(activityId.diff(id), 'pi.diff', {
        path: String(call.args['path'] ?? ''),
        hunks: addedFileHunks(call.args['content']),
        toolCallId: id,
        written: true,
      }),
    );
  }
  if (!message.isError) out.push(...genUiActivities(id, message, call, text, options));
  return out;
}

/** The generative UI of a finished call, as the live stream made it (`genUiActivities` in `map.ts`). */
function genUiActivities(id: string, message: PiStoredMessage, call: KnownCall | undefined, text: string, options: SessionToMessagesOptions): Message[] {
  const out: Message[] = [];
  const openUi = openGenerativeUiOf(message.details);
  if (!message.isError && openUi) out.push({ id: `${id}-activity`, role: 'activity', activityType: OPEN_GENERATIVE_UI_ACTIVITY, content: openUi } as Message);
  // Both conventions: pi-kit's `details.a2ui_operations` and a result text that is the AG-UI JSON container.
  const found = a2uiOperationsOf({ details: message.details, text });
  const operations = found && normalizeA2uiOperations(found);
  if (operations) {
    out.push({ id: genUiId.a2uiSurface(id), role: 'activity', activityType: A2UI_SURFACE_ACTIVITY, content: { a2ui_operations: operations } } as Message);
  }
  const { server, tool } = message.details ?? {};
  if (options.mcpApp && typeof server === 'string' && typeof tool === 'string') {
    const resourceUri = options.mcpApp(server, tool);
    if (resourceUri) {
      const blocks = (Array.isArray(message.content) ? message.content : []).filter((block) => block.type === 'text' || block.type === 'image');
      out.push({
        id: genUiId.mcpApp(id),
        role: 'activity',
        activityType: MCP_APPS_ACTIVITY,
        content: {
          serverHash: mcpServerHash(server),
          serverId: server,
          tool,
          resourceUri,
          result: { content: blocks },
          ...(call ? { toolInput: call.args } : {}),
        },
      } as Message);
    }
  }
  return out;
}

function interruptedResult(callId: string, name: string): Message {
  return {
    id: `${callId}-result`,
    role: 'tool',
    toolCallId: callId,
    content: `The ${name} call was interrupted and has no result.`,
    error: 'interrupted',
  };
}

function fromMessage(id: string, message: PiStoredMessage): Message[] {
  switch (message.role) {
    case 'user':
      return fromUser(id, message);
    case 'assistant':
      return fromAssistant(id, message);
    case 'toolResult':
      return [
        {
          id,
          role: 'tool',
          toolCallId: String(message.toolCallId ?? ''),
          content: textOf(message.content),
          ...(message.isError ? { error: textOf(message.content) || 'Tool failed' } : {}),
        },
      ];
    default:
      // system, bashExecution, compactionSummary, branchSummary, custom: not transcript turns yet.
      return [];
  }
}

/** The `<skill …>` block at the start of a text (pi's `parseSkillBlock` takes one; a message with chips holds several, each followed by a blank line or the end). */
const SKILL_BLOCK_START = /^<skill name="([^"]+)" location="[^"]+">\n[\s\S]*?\n<\/skill>(?=\n\n|$)/;

/** The `<file name="...">` blocks the composer's `@file` expansion puts in front of a prompt (as pi's CLI does). */
const FILE_BLOCKS = /^(?:<file name="[^"]*">[\s\S]*?<\/file>\n)+/;

/**
 * A user message as it was typed: a skill invocation instead of the skill's whole file, and without the
 * file contents the composer inlined for its `@paths` (the `@path` stays in the text).
 */
function collapseSkill(raw: string): string {
  let text = raw.replace(FILE_BLOCKS, '');
  const names: string[] = [];
  // A message with chips holds one block per skill; pi's own expansion holds one.
  for (;;) {
    const match = SKILL_BLOCK_START.exec(text);
    if (!match) break;
    names.push(match[1]);
    text = text.slice(match[0].length).replace(/^\n\n/, '');
  }
  if (names.length === 0) return text;
  const args = text.trim();
  return `${names.map((name) => `/skill:${name}`).join(' ')}${args ? ` ${args}` : ''}`;
}

/** The text of a stored user message as the user typed it (skill block collapsed, inlined files dropped); images are left out. */
export function userMessageText(content: string | PiContentBlock[] | undefined): string {
  if (typeof content === 'string') return collapseSkill(content);
  return (content ?? []).map((block) => (block.type === 'text' ? collapseSkill(block.text ?? '') : '')).join('\n');
}

/** The user message of a turn that carried chips, as it was typed: the sentence of the `pi-kit.skills` entry in place of the expanded prompt, images kept. */
function typedUserMessage(produced: Message[], text: string): Message[] {
  return produced.map((m) => {
    if (m.role !== 'user') return m;
    if (typeof m.content === 'string') return { ...m, content: text };
    const rest = m.content.filter((part) => part.type !== 'text');
    return { ...m, content: text ? [{ type: 'text' as const, text }, ...rest] : rest.length > 0 ? rest : '' };
  });
}

function fromUser(id: string, message: PiStoredMessage): Message[] {
  if (typeof message.content === 'string') return [{ id, role: 'user', content: collapseSkill(message.content) }];
  const parts: InputContent[] = [];
  for (const block of message.content ?? []) {
    if (block.type === 'text') parts.push({ type: 'text', text: collapseSkill(block.text ?? '') });
    else if (block.type === 'image' && block.data) {
      parts.push({ type: 'image', source: { type: 'data', value: block.data, mimeType: block.mimeType ?? 'image/png' } });
    }
  }
  if (parts.every((part) => part.type === 'text')) {
    return [{ id, role: 'user', content: parts.map((part) => (part.type === 'text' ? part.text : '')).join('\n') }];
  }
  return [{ id, role: 'user', content: parts }];
}

function fromAssistant(id: string, message: PiStoredMessage): Message[] {
  const blocks = Array.isArray(message.content) ? message.content : [];
  const reasoning: Message[] = [];
  const extraText: Message[] = [];
  const toolCalls: { id: string; type: 'function'; function: { name: string; arguments: string } }[] = [];
  let firstText: string | undefined;

  blocks.forEach((block, index) => {
    if (block.type === 'thinking' && block.thinking) {
      reasoning.push({ id: `${id}:r${index}`, role: 'reasoning', content: block.thinking });
    } else if (block.type === 'text' && block.text) {
      if (firstText === undefined) firstText = block.text;
      else extraText.push({ id: `${id}:${index}`, role: 'assistant', content: block.text });
    } else if (block.type === 'toolCall' && block.id && block.name) {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: { name: block.name, arguments: JSON.stringify(block.arguments ?? {}) },
      });
    }
  });

  const main: Message[] =
    firstText !== undefined || toolCalls.length > 0
      ? [{ id, role: 'assistant', content: firstText ?? '', ...(toolCalls.length > 0 ? { toolCalls } : {}) }]
      : [];
  return [...reasoning, ...main, ...extraText];
}

function textOf(content: string | PiContentBlock[] | undefined): string {
  if (typeof content === 'string') return content;
  return (content ?? []).map((block) => (block.type === 'text' ? (block.text ?? '') : `[${block.type}]`)).join('');
}
