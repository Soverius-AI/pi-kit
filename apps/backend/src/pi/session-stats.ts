import type { AgentSession } from '@earendil-works/pi-coding-agent' with { 'resolution-mode': 'import' };
import { endsWithQuestion, type SessionContext, type SessionStats, type ThinkingLevel } from '@pi-kit/protocol';
import { type ContextMessage, type ContextTool, buildContextItems, groupContextItems } from './context-items';
import type { OpenThread } from './session-lifecycle';

export type WindowLookup = (provider: string | undefined, model: string) => number | undefined;

function modelOf(session: AgentSession): SessionStats['model'] {
  return session.model ? { provider: session.model.provider, id: session.model.id, name: session.model.name } : null;
}

/** One `getContextUsage()` call: pi rebuilds the session projection for each. */
function contextOf(session: AgentSession, lookup: WindowLookup): Pick<SessionStats, 'contextTokens' | 'contextWindow'> {
  const usage = session.getContextUsage();
  return {
    contextTokens: usage?.tokens ?? null,
    contextWindow:
      usage?.contextWindow ?? (session.model ? lookup(session.model.provider, session.model.id) : undefined) ?? null,
  };
}

/** `/session`, the composer's token meter and the status bar. */
export function sessionStats({ session, info, ui }: OpenThread, lookup: WindowLookup): SessionStats {
  const stats = session.getSessionStats();
  const context = contextOf(session, lookup);
  const compaction = session.settingsManager.getCompactionSettings(session.model);
  return {
    sessionId: stats.sessionId,
    sessionFile: stats.sessionFile ?? null,
    userMessages: stats.userMessages,
    assistantMessages: stats.assistantMessages,
    toolCalls: stats.toolCalls,
    toolResults: stats.toolResults,
    totalMessages: stats.totalMessages,
    tokens: stats.tokens,
    cost: stats.cost,
    ...context,
    model: modelOf(session),
    thinkingLevel: session.thinkingLevel as ThinkingLevel,
    autoCompaction: session.autoCompactionEnabled,
    compactionThreshold:
      session.autoCompactionEnabled && context.contextWindow
        ? Math.max(0, context.contextWindow - compaction.reserveTokens)
        : null,
    streaming: session.isStreaming,
    waitingForAnswer: ui.size > 0,
    cwd: info.cwd,
  };
}

/** The context inspector: what pi keeps for the model right now, piece by piece, and what each piece costs. */
export function sessionContext(session: AgentSession, lookup: WindowLookup): SessionContext {
  const summaries = (session.sessionManager.getBranch() as { type: string; summary?: string }[])
    .filter((entry) => entry.type === 'compaction' && entry.summary)
    .map((entry) => entry.summary as string);
  const items = buildContextItems(
    session.agent.state.messages as unknown as ContextMessage[],
    session.agent.state.tools as unknown as ContextTool[],
    summaries,
  );
  return {
    ...contextOf(session, lookup),
    estimatedTokens: items.reduce((sum, item) => sum + item.tokens, 0),
    model: modelOf(session),
    groups: groupContextItems(items),
    items,
  };
}

/** Whole percent of the model's window the context fills; null while unknown (right after a compaction, before the first response). */
export function contextShare(session: AgentSession): number | null {
  const usage = session.getContextUsage();
  if (!usage || usage.tokens === null || !usage.contextWindow) return null;
  return Math.max(0, Math.round((usage.tokens / usage.contextWindow) * 100));
}

/**
 * The last line of an assistant turn that ended in a question while nothing runs: the thread is "waiting" for the
 * user the same way it is while a dialog is open.
 */
export function proseQuestion(thread: OpenThread): string | undefined {
  if (thread.session.isStreaming || thread.ui.size > 0) return undefined;
  const last = thread.session.messages.at(-1);
  if (last?.role !== 'assistant') return undefined;
  const content = (last as { content?: unknown }).content;
  const text = Array.isArray(content)
    ? content
        .map((part) =>
          part && typeof part === 'object' && (part as { type?: string }).type === 'text'
            ? String((part as { text?: unknown }).text ?? '')
            : '',
        )
        .join('')
    : '';
  if (!endsWithQuestion(text)) return undefined;
  const trimmed = text.trimEnd();
  return trimmed.slice(trimmed.lastIndexOf('\n') + 1).trim();
}
