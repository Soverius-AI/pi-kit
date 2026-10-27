import type { PiSessionEntry } from '@pi-kit/pi-adapter';

/** What the last response of a thread's active branch put in the context window. */
export interface ContextSample {
  tokens: number;
  provider: string | undefined;
  model: string;
}

interface StoredUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
}

/**
 * The context in use after the last response of the branch that ends at `leafId` (the last entry when null), the way pi's
 * `getContextUsage()` counts it: the response's own `usage.totalTokens` (else the sum of its parts). A compaction below the response means
 * the context is not known until the next response, and so does a branch without any response. Requests that produced nothing (a stopped or
 * failed run has no usage) are skipped. Pure: a thread whose session is not open is measured from its file.
 */
export function lastContext(entries: readonly PiSessionEntry[], leafId: string | null): ContextSample | null {
  const byId = new Map(entries.map((e) => [e.id, e] as const));
  let current = leafId ? byId.get(leafId) : entries.at(-1);
  for (let guard = 0; current && guard <= entries.length; guard++) {
    if (current.type === 'compaction') return null;
    const message = current.type === 'message' ? (current['message'] as { role?: string; usage?: StoredUsage; stopReason?: string; provider?: string; model?: string } | undefined) : undefined;
    if (message?.role === 'assistant' && message.usage && message.stopReason !== 'aborted' && message.stopReason !== 'error') {
      const u = message.usage;
      const tokens = u.totalTokens || (u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
      if (tokens > 0) return { tokens, provider: message.provider || undefined, model: message.model ?? '' };
    }
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return null;
}

/** Whole percent of the window in use; null without a window. */
export function contextPercent(tokens: number, window: number | undefined): number | null {
  return window && window > 0 ? Math.max(0, Math.round((tokens / window) * 100)) : null;
}

const LAST_LINE_CHARS = 140;

/**
 * The first line of the last assistant message on the branch that ends at `leafId`: what the sidebar's summary line says when the attendant has
 * no summary. Fenced code and blank lines are skipped, markdown marks are dropped, and the line is cut to a short length. A response that only called
 * tools (no text) and a stopped or failed one are skipped, so the line is always something pi said. `null` when there is none.
 */
export function lastAssistantLine(entries: readonly PiSessionEntry[], leafId: string | null): string | null {
  const byId = new Map(entries.map((e) => [e.id, e] as const));
  let current = leafId ? byId.get(leafId) : entries.at(-1);
  for (let guard = 0; current && guard <= entries.length; guard++) {
    const message = current.type === 'message' ? (current['message'] as { role?: string; content?: unknown; stopReason?: string } | undefined) : undefined;
    if (message?.role === 'assistant' && message.stopReason !== 'aborted' && message.stopReason !== 'error') {
      const line = firstLine(textOf(message.content));
      if (line) return line;
    }
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return null;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => (part && typeof part === 'object' && (part as { type?: string }).type === 'text' ? String((part as { text?: unknown }).text ?? '') : '')).join('\n');
}

function firstLine(text: string): string | null {
  let fenced = false;
  for (const raw of text.split('\n')) {
    const trimmed = raw.trim();
    if (trimmed.startsWith('```')) {
      fenced = !fenced;
      continue;
    }
    if (fenced || !trimmed) continue;
    const plain = trimmed
      .replace(/^#{1,6}\s+/, '')
      .replace(/^(?:[-*+]|\d{1,3}[.)])\s+/, '')
      .replace(/^>\s?/, '')
      .replace(/[*_`]+/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!plain) continue;
    return plain.length > LAST_LINE_CHARS ? `${plain.slice(0, LAST_LINE_CHARS - 1).replace(/\s+\S*$/, '')}…` : plain;
  }
  return null;
}
