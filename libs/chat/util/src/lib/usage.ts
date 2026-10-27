import type { Translate } from '@pi-kit/i18n';
import { compactNumber, DEFAULT_CONTEXT_THRESHOLDS, formatCost, type ContextThresholds } from '@pi-kit/ui';
import type { BlockUsage } from './transcript-model';

/** Context meter colour steps: below 70 % nothing special, 70 % warning, 90 % error. */
export const CONTEXT_WARNING_PERCENT = DEFAULT_CONTEXT_THRESHOLDS.warning;
export const CONTEXT_ERROR_PERCENT = DEFAULT_CONTEXT_THRESHOLDS.error;

export type ContextLevel = 'ok' | 'warning' | 'error';

export function contextPercent(tokens: number, contextWindow: number): number {
  return contextWindow > 0 ? (tokens / contextWindow) * 100 : 0;
}

export function contextLevel(
  percent: number,
  thresholds: ContextThresholds = DEFAULT_CONTEXT_THRESHOLDS,
): ContextLevel {
  if (percent >= thresholds.error) return 'error';
  if (percent >= thresholds.warning) return 'warning';
  return 'ok';
}

/** `4.2s` below ten seconds, `12s` / `1m 12s` above; the usage line is for people, not for a stopwatch. */
export function formatSeconds(ms: number): string {
  if (ms < 10_000) return `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total}s`;
  return total % 60 ? `${Math.floor(total / 60)}m ${total % 60}s` : `${Math.floor(total / 60)}m`;
}

/**
 * The usage line under an assistant turn: `in 3.1k · out 420 · cache read 48k · $0.012 · 4.2s · model`. Numbers that are zero are left
 * out (a local model has no cost, a provider without caching no cache), and the model is the id without its provider.
 */
export function usageLine(translate: Translate, usage: BlockUsage): string {
  const parts = [
    translate('chat.usage.in', { value1: compactNumber(usage.input) }),
    translate('chat.usage.out', { value1: compactNumber(usage.output) }),
  ];
  if (usage.cacheRead > 0) parts.push(translate('chat.usage.cacheRead', { value1: compactNumber(usage.cacheRead) }));
  if (usage.cacheWrite > 0) parts.push(translate('chat.usage.cacheWrite', { value1: compactNumber(usage.cacheWrite) }));
  if (usage.cost > 0) parts.push(formatCost(usage.cost));
  if (usage.elapsedMs > 0) parts.push(formatSeconds(usage.elapsedMs));
  if (usage.models.length > 0) parts.push(usage.models.map((m) => m.slice(m.indexOf('/') + 1)).join(', '));
  return parts.join(' · ');
}

/** `$0.84 · 112k tokens · 9 turns`, the status bar's totals. */
export function totalsLine(translate: Translate, cost: number, tokens: number, turns: number): string {
  return translate('chat.usage.tokens', {
    value1: formatCost(cost),
    value2: compactNumber(tokens),
    value3: turns,
    value4: turns === 1 ? translate('chat.usage.turn') : translate('chat.usage.turns'),
  });
}

/** `18%`, `7.4%`: one decimal below ten percent so a small context does not read as zero. */
export const percentLabel = (percent: number): string =>
  `${percent >= 10 || percent === 0 ? Math.round(percent) : Math.round(percent * 10) / 10}%`;
