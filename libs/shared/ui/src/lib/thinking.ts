/** The newest sentence of a (still streaming) thinking trace, for the live line next to "Thinking". */
import type { Translate } from '@pi-kit/i18n';
export function newestSentence(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  const sentences = flat.match(/[^.!?]+[.!?]+(?=\s|$)|[^.!?]+$/g) ?? [flat];
  const last = (sentences.at(-1) ?? flat).trim();
  const incomplete = !/[.!?]$/.test(last);
  const shown = last.length > max ? `…${last.slice(-max + 1)}` : last;
  return incomplete ? `${shown}…` : shown;
}

/** "Thought for 8s", "Thought for 1m 12s", or just "Thought" when the duration is unknown. */
export function thoughtLabel(translate: Translate, ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return translate('shared.thinking.thought');
  return translate('shared.thinking.thoughtFor', { value1: formatDuration(ms) });
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

/** Rough token count of a text (4 characters per token), shown with a "~". */
export function approxTokens(translate: Translate, text: string): string {
  const n = Math.round(text.length / 4);
  if (n < 1000) return translate('shared.thinking.tokens', { value1: n });
  return translate('shared.thinking.kTokens', { value1: (n / 1000).toFixed(1) });
}

/** 18400 → "18.4k", 200000 → "200k". */
export function compactNumber(n: number): string {
  if (n < 1000) return String(n);
  const k = n / 1000;
  return `${k >= 100 ? Math.round(k) : Math.round(k * 10) / 10}k`;
}

/** `$0.84`, `$0.0123` for small amounts. */
export function formatCost(usd: number): string {
  if (usd === 0) return '$0.00';
  return usd < 0.1 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}
