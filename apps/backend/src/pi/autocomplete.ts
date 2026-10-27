import { COMPLETE_MAX_ITEMS, type CompleteItem, type CompleteResponse } from '@pi-kit/protocol';

/**
 * pi's autocomplete types (`@earendil-works/pi-tui`), declared here so this file does not import pi. They are
 * structurally the same: a factory an extension passes to `ctx.ui.addAutocompleteProvider` is accepted as is.
 */
export interface AutocompleteItem {
  value: string;
  label: string;
  description?: string;
}

export interface AutocompleteSuggestions {
  items: AutocompleteItem[];
  prefix: string;
}

export interface AutocompleteResult {
  lines: string[];
  cursorLine: number;
  cursorCol: number;
}

export interface AutocompleteProvider {
  getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options: { signal: AbortSignal; force?: boolean },
  ): Promise<AutocompleteSuggestions | null>;
  applyCompletion(lines: string[], cursorLine: number, cursorCol: number, item: AutocompleteItem, prefix: string): AutocompleteResult;
}

/** What `ctx.ui.addAutocompleteProvider` takes: it wraps the provider built so far and returns the one that goes on top. */
export type AutocompleteProviderFactory = (current: AutocompleteProvider) => AutocompleteProvider;

export const COMPLETE_TIMEOUT_MS = 3000;

/** The provider at the bottom of the chain: nothing to suggest, and an item replaces the `prefix` before the cursor. */
export const baseProvider: AutocompleteProvider = {
  getSuggestions: () => Promise.resolve(null),
  applyCompletion: (lines, cursorLine, cursorCol, item, prefix) => {
    const line = lines[cursorLine] ?? '';
    const before = line.slice(0, Math.max(0, cursorCol - prefix.length));
    const next = [...lines];
    next[cursorLine] = before + item.value + line.slice(cursorCol);
    return { lines: next, cursorLine, cursorCol: before.length + item.value.length };
  },
};

/** Stacks the factories in the order the extensions added them (the last one is asked first). A factory that throws is skipped. */
export function buildAutocompleteChain(factories: readonly AutocompleteProviderFactory[], onError?: (error: unknown) => void): AutocompleteProvider {
  let provider = baseProvider;
  for (const factory of factories) {
    try {
      provider = factory(provider);
    } catch (error) {
      onError?.(error);
    }
  }
  return provider;
}

/** Where a caret at (`line`, `col`) sits in `lines` joined with newlines. */
const offsetOf = (lines: readonly string[], line: number, col: number): number => lines.slice(0, line).reduce((sum, l) => sum + l.length + 1, 0) + col;

export interface CompleteOptions {
  /** Aborts the provider; the answer is then empty. Defaults to a fresh signal that fires after `timeoutMs`. */
  signal?: AbortSignal;
  timeoutMs?: number;
  limit?: number;
  onError?: (error: unknown) => void;
}

/**
 * Asks the extensions' providers for suggestions at `cursor` in the single-line `text`, and applies every suggested item
 * through the same chain so the answer carries the complete text and caret the composer should end up with.
 * Nothing suggested, a provider that throws, or one that does not answer within the timeout all give an empty list.
 */
export async function completeThroughChain(
  factories: readonly AutocompleteProviderFactory[],
  text: string,
  cursor: number,
  options: CompleteOptions = {},
): Promise<CompleteResponse> {
  const empty: CompleteResponse = { prefix: '', items: [] };
  if (factories.length === 0) return empty;
  const chain = buildAutocompleteChain(factories, options.onError);
  const lines = [text];
  const col = Math.min(cursor, text.length);

  const timeout = AbortSignal.timeout(options.timeoutMs ?? COMPLETE_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  // A provider that ignores the signal must not hold the request: the race ends it at the deadline.
  const aborted = new Promise<null>((resolve) => signal.addEventListener('abort', () => resolve(null), { once: true }));

  let suggestions: AutocompleteSuggestions | null;
  try {
    suggestions = await Promise.race([chain.getSuggestions(lines, 0, col, { signal }), aborted]);
  } catch (error) {
    options.onError?.(error);
    return empty;
  }
  if (!suggestions || signal.aborted) return empty;

  const items: CompleteItem[] = [];
  for (const item of suggestions.items.slice(0, options.limit ?? COMPLETE_MAX_ITEMS)) {
    if (typeof item?.value !== 'string') continue;
    let applied: AutocompleteResult;
    try {
      applied = chain.applyCompletion(lines, 0, col, item, suggestions.prefix);
    } catch (error) {
      options.onError?.(error);
      applied = baseProvider.applyCompletion(lines, 0, col, item, suggestions.prefix);
    }
    items.push({
      value: item.value,
      label: typeof item.label === 'string' && item.label ? item.label : item.value,
      ...(item.description ? { description: item.description } : {}),
      insert: { text: applied.lines.join('\n'), cursor: offsetOf(applied.lines, applied.cursorLine, applied.cursorCol) },
    });
  }
  return { prefix: suggestions.prefix, items };
}
