import type { Translate } from '@pi-kit/i18n';
import type { ActivityMessage, Message } from '@ag-ui/core';
import type { ComposerChip, PiActivityContent, ReviewComment } from '@pi-kit/protocol';

/**
 * The transcript as blocks: pure functions from the AG-UI message list that
 * `injectAgentStore().messages` holds to what the renderer draws. No Angular, no state.
 *
 * - a user message is a user block;
 * - reasoning, assistant text and tool calls between two user messages are one assistant block, in the
 *   order they happened (thinking between tool calls stays between them);
 * - consecutive tool calls form one activity list; every assistant message that calls tools is a step;
 * - a `pi.compaction` or `pi.branch_summary` activity message is a marker between blocks, a user `pi.bash` activity a shell block;
 * - a `pi.review` activity message belongs to the user message before it (its comments become that block's `review`);
 * - so does a `pi.skills` activity message: its chips become that block's `skills`, drawn over the text;
 * - an `a2ui-surface` or `mcp-apps` activity message (generated UI) is an item of the assistant block it arrived in;
 * - a `pi.turn_usage` activity message adds its request to the usage of the assistant block before it. Everything between two
 *   user messages is one block, so the text, tool calls and further text of a turn share one gap and one usage line.
 * Everything else (tool results, system messages, the other activity messages) is looked up by id where it
 * is used, not drawn on its own.
 */

export interface UserBlock {
  kind: 'user';
  id: string;
  text: string;
  /** `data:` or remote URLs of attached images. */
  images: string[];
  /** The review comments this message carried: the `pi.review` activity that follows the message. */
  review?: ReviewComment[];
  /** The skill and prompt-template chips this message was sent: the `pi.skills` activity that follows the message. */
  skills?: ComposerChip[];
}

export interface ToolCallView {
  id: string;
  name: string;
  /** The raw JSON arguments, possibly still streaming (partial). */
  arguments: string;
  /** The assistant message that made the call. */
  messageId: string;
  result?: string;
  error?: string;
}

export interface ThinkItem {
  kind: 'think';
  id: string;
  text: string;
}

export interface TextItem {
  kind: 'text';
  id: string;
  text: string;
}

export interface StepView {
  /** The assistant message id. */
  id: string;
  /** 1-based within the assistant block. */
  index: number;
  calls: ToolCallView[];
}

export interface ActivityItem {
  kind: 'activity';
  id: string;
  steps: StepView[];
  callCount: number;
}

/** Generated UI: an A2UI surface or an MCP App, drawn by the renderer that CopilotKit has registered for `activityType`. */
export interface GenUiItem {
  kind: 'genui';
  /** The activity message id. */
  id: string;
  activityType: string;
  content: unknown;
}

/** The activity types that are generated UI inside the transcript. */
export const GENUI_ACTIVITY_TYPES: readonly string[] = ['a2ui-surface', 'mcp-apps', 'open-generative-ui'];

export type AssistantItem = ThinkItem | TextItem | ActivityItem | GenUiItem;

/** What the model requests of one assistant block used, summed (the usage line under the turn). */
export interface BlockUsage {
  requests: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  elapsedMs: number;
  /** `provider/model` of the requests, in order of first use. */
  models: string[];
}

export interface AssistantBlock {
  kind: 'assistant';
  id: string;
  items: AssistantItem[];
  /** Number of steps (assistant messages with tool calls) in the block. */
  stepCount: number;
  /** Absent while the first request is still streaming, and for a block pi reported no usage for. */
  usage?: BlockUsage;
  /** The `pi.turn_usage` activity messages of the block, in order: the last one carries the turn's usage line, drawn as a piece of its own. */
  usageIds: string[];
}

export interface MarkerBlock {
  kind: 'marker';
  id: string;
  tokensBefore?: number;
  tokensAfter?: number;
  /** A fixed text instead of the compaction wording (a branch summary). */
  label?: string;
}

/** A `!command` the user ran: its `pi.bash` activity (id `bash:user:<id>`) is the content. */
export interface ShellBlock {
  kind: 'shell';
  id: string;
}

export type TranscriptBlock = UserBlock | AssistantBlock | MarkerBlock | ShellBlock;

type Loose = Message & {
  content?: unknown;
  toolCalls?: { id: string; function: { name: string; arguments: string } }[];
  error?: string;
  toolCallId?: string;
};

export function buildTranscript(translate: Translate, messages: readonly Message[]): TranscriptBlock[] {
  const results = new Map<string, { content: string; error?: string }>();
  for (const message of messages) {
    const m = message as Loose;
    if (m.role === 'tool' && m.toolCallId) results.set(m.toolCallId, { content: textOf(m.content), error: m.error });
  }

  const blocks: TranscriptBlock[] = [];
  let current: AssistantBlock | undefined;
  const assistant = (id: string): AssistantBlock => {
    if (!current) {
      current = { kind: 'assistant', id, items: [], stepCount: 0, usageIds: [] };
      blocks.push(current);
    }
    return current;
  };

  for (const message of messages) {
    const m = message as Loose;
    switch (m.role) {
      case 'user': {
        current = undefined;
        blocks.push(userBlock(m));
        break;
      }
      case 'reasoning': {
        const text = textOf(m.content);
        if (text.trim()) assistant(m.id).items.push({ kind: 'think', id: m.id, text });
        break;
      }
      case 'assistant': {
        const block = assistant(m.id);
        const text = textOf(m.content);
        if (text.trim()) block.items.push({ kind: 'text', id: m.id, text });
        if (m.toolCalls?.length) {
          block.stepCount += 1;
          const step: StepView = {
            id: m.id,
            index: block.stepCount,
            calls: m.toolCalls.map((call) => ({
              id: call.id,
              name: call.function.name,
              arguments: call.function.arguments,
              messageId: m.id,
              ...(results.get(call.id)
                ? { result: results.get(call.id)?.content, error: results.get(call.id)?.error }
                : {}),
            })),
          };
          const last = block.items.at(-1);
          if (last?.kind === 'activity') {
            last.steps.push(step);
            last.callCount += step.calls.length;
          } else {
            block.items.push({ kind: 'activity', id: `${m.id}:activity`, steps: [step], callCount: step.calls.length });
          }
        }
        break;
      }
      case 'activity': {
        const a = m as unknown as ActivityMessage;
        if (a.activityType === 'pi.bash' && a.id.startsWith('bash:user:')) {
          current = undefined;
          blocks.push({ kind: 'shell', id: a.id });
        } else if (a.activityType === 'pi.compaction') {
          current = undefined;
          const content = (a.content ?? {}) as { tokensBefore?: number; tokensAfter?: number };
          blocks.push({
            kind: 'marker',
            id: a.id,
            tokensBefore: content.tokensBefore,
            tokensAfter: content.tokensAfter,
          });
        } else if (a.activityType === 'pi.review') {
          const last = blocks.at(-1);
          const comments = ((a.content ?? {}) as { comments?: ReviewComment[] }).comments;
          if (last?.kind === 'user' && comments?.length) last.review = comments;
        } else if (a.activityType === 'pi.skills') {
          const last = blocks.at(-1);
          const chips = ((a.content ?? {}) as { chips?: ComposerChip[] }).chips;
          if (last?.kind === 'user' && chips?.length) last.skills = chips;
        } else if (a.activityType === 'pi.branch_summary') {
          current = undefined;
          blocks.push({ kind: 'marker', id: a.id, label: translate('chat.transcriptModel.summaryOfTheBranchYouLeft') });
        } else if (a.activityType === 'pi.turn_usage') {
          if (current) {
            addUsage(current, (a.content ?? {}) as Partial<PiActivityContent<'pi.turn_usage'>>);
            current.usageIds.push(a.id);
          }
        } else if (GENUI_ACTIVITY_TYPES.includes(a.activityType)) {
          assistant(a.id).items.push({ kind: 'genui', id: a.id, activityType: a.activityType, content: a.content });
        }
        break;
      }
      default:
        break;
    }
  }
  return blocks;
}

function addUsage(block: AssistantBlock, usage: Partial<PiActivityContent<'pi.turn_usage'>>): void {
  const total = block.usage ?? {
    requests: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    elapsedMs: 0,
    models: [],
  };
  total.requests += 1;
  total.input += usage.input ?? 0;
  total.output += usage.output ?? 0;
  total.cacheRead += usage.cacheRead ?? 0;
  total.cacheWrite += usage.cacheWrite ?? 0;
  total.cost += usage.cost ?? 0;
  total.elapsedMs += usage.elapsedMs ?? 0;
  const model = usage.model ? (usage.provider ? `${usage.provider}/${usage.model}` : usage.model) : undefined;
  if (model && !total.models.includes(model)) total.models.push(model);
  block.usage = total;
}

/** Activity messages by id (`tool:<callId>`, `bash:<callId>`, `diff:<callId>`, `widget:<key>`, ...). */
export function activityMap(messages: readonly Message[]): Map<string, ActivityMessage> {
  const map = new Map<string, ActivityMessage>();
  for (const message of messages) {
    if (message.role === 'activity') map.set(message.id, message as ActivityMessage);
  }
  return map;
}

function userBlock(message: Loose): UserBlock {
  const content = message.content;
  if (typeof content === 'string') return { kind: 'user', id: message.id, text: content, images: [] };
  const parts = Array.isArray(content)
    ? (content as {
        type: string;
        text?: string;
        source?: { type: string; value?: string; mimeType?: string; url?: string };
      }[])
    : [];
  const images: string[] = [];
  const text: string[] = [];
  for (const part of parts) {
    if (part.type === 'text') text.push(part.text ?? '');
    else if (part.type === 'image' && part.source) {
      if (part.source.type === 'data' && part.source.value)
        images.push(`data:${part.source.mimeType ?? 'image/png'};base64,${part.source.value}`);
      else if (part.source.url) images.push(part.source.url);
    }
  }
  return { kind: 'user', id: message.id, text: text.join('\n'), images };
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part: { type?: string; text?: string }) => (part.type === 'text' ? (part.text ?? '') : ''))
      .join('');
  }
  return '';
}

/** Tool calls of the whole block, in order. */
export function callsOf(block: AssistantBlock): ToolCallView[] {
  return block.items.flatMap((item) => (item.kind === 'activity' ? item.steps.flatMap((s) => s.calls) : []));
}
