import { CompleteResponseSchema } from '@pi-kit/protocol';
import { describe, expect, it } from 'vitest';
import { type AutocompleteProvider, type AutocompleteProviderFactory, baseProvider, completeThroughChain } from './autocomplete';

const FRUITS = ['apple', 'apricot', 'banana', 'blueberry'];

/** What the pk-test extension does: completes the argument of /pk-fruit, delegates otherwise. */
const fruit: AutocompleteProviderFactory = (current) => ({
  ...current,
  async getSuggestions(lines, cursorLine, cursorCol, options) {
    const before = (lines[cursorLine] ?? '').slice(0, cursorCol);
    const match = /^\/pk-fruit (\S*)$/.exec(before);
    if (!match) return current.getSuggestions(lines, cursorLine, cursorCol, options);
    const items = FRUITS.filter((f) => f.startsWith(match[1])).map((f) => ({ value: f, label: f, description: 'fruit' }));
    return items.length > 0 ? { items, prefix: match[1] } : null;
  },
});

/** A second layer that knows one more thing and passes the rest down. */
const color: AutocompleteProviderFactory = (current) => ({
  ...current,
  async getSuggestions(lines, cursorLine, cursorCol, options) {
    const before = (lines[cursorLine] ?? '').slice(0, cursorCol);
    const match = /^\/pk-color (\S*)$/.exec(before);
    if (!match) return current.getSuggestions(lines, cursorLine, cursorCol, options);
    return { items: [{ value: 'red', label: 'red' }], prefix: match[1] };
  },
});

describe('baseProvider', () => {
  it('suggests nothing', async () => {
    await expect(baseProvider.getSuggestions(['/x '], 0, 3, { signal: new AbortController().signal })).resolves.toBeNull();
  });

  it('replaces the prefix before the cursor with the item value and puts the caret after it', () => {
    const result = baseProvider.applyCompletion(['/pk-fruit ap tail'], 0, 12, { value: 'apple', label: 'apple' }, 'ap');
    expect(result).toEqual({ lines: ['/pk-fruit apple tail'], cursorLine: 0, cursorCol: 15 });
  });
});

describe('completeThroughChain', () => {
  it('maps the suggestions to items that carry the whole text and caret after applying them', async () => {
    const text = '/pk-fruit ap';
    const response = await completeThroughChain([fruit], text, text.length);
    expect(response).toEqual({
      prefix: 'ap',
      items: [
        { value: 'apple', label: 'apple', description: 'fruit', insert: { text: '/pk-fruit apple', cursor: 15 } },
        { value: 'apricot', label: 'apricot', description: 'fruit', insert: { text: '/pk-fruit apricot', cursor: 17 } },
      ],
    });
    expect(CompleteResponseSchema.safeParse(response).success).toBe(true);
  });

  it('keeps the text after the caret', async () => {
    const response = await completeThroughChain([fruit], '/pk-fruit b and more', 11);
    expect(response.items.map((i) => i.insert)).toEqual([
      { text: '/pk-fruit banana and more', cursor: 16 },
      { text: '/pk-fruit blueberry and more', cursor: 19 },
    ]);
  });

  it('asks the factory added last first, and it delegates to the one below when it has nothing', async () => {
    const stacked = [fruit, color];
    expect((await completeThroughChain(stacked, '/pk-color ', 10)).items.map((i) => i.value)).toEqual(['red']);
    expect((await completeThroughChain(stacked, '/pk-fruit b', 11)).items.map((i) => i.value)).toEqual(['banana', 'blueberry']);
    expect(await completeThroughChain(stacked, '/other ', 7)).toEqual({ prefix: '', items: [] });
  });

  it('answers with nothing when no provider was added, and without calling anything', async () => {
    expect(await completeThroughChain([], '/pk-fruit a', 11)).toEqual({ prefix: '', items: [] });
  });

  it('gives at most 20 items', async () => {
    const many: AutocompleteProviderFactory = () => ({
      ...baseProvider,
      getSuggestions: () => Promise.resolve({ prefix: '', items: Array.from({ length: 50 }, (_, i) => ({ value: `v${i}`, label: `v${i}` })) }),
    });
    expect((await completeThroughChain([many], '', 0)).items).toHaveLength(20);
  });

  it('skips a factory that throws, and answers empty when a provider throws or rejects', async () => {
    const errors: unknown[] = [];
    const broken: AutocompleteProviderFactory = () => {
      throw new Error('factory');
    };
    const rejecting: AutocompleteProviderFactory = (current) => ({ ...current, getSuggestions: () => Promise.reject(new Error('provider')) });
    expect((await completeThroughChain([fruit, broken], '/pk-fruit a', 11, { onError: (e) => errors.push(e) })).items).toHaveLength(2);
    expect(await completeThroughChain([rejecting], 'x', 1, { onError: (e) => errors.push(e) })).toEqual({ prefix: '', items: [] });
    expect(errors).toHaveLength(2);
  });

  it('falls back to a plain replacement for an item the chain cannot apply', async () => {
    const odd: AutocompleteProviderFactory = (current) => ({
      ...current,
      getSuggestions: () => Promise.resolve({ prefix: 'a', items: [{ value: 'apple', label: 'apple' }] }),
      applyCompletion: () => {
        throw new Error('no');
      },
    });
    const response = await completeThroughChain([odd], '/x a', 4);
    expect(response.items[0].insert).toEqual({ text: '/x apple', cursor: 8 });
  });

  it('applies through the whole chain, so a provider that appends a space does so', async () => {
    const spacing: AutocompleteProviderFactory = (current: AutocompleteProvider) => ({
      ...current,
      getSuggestions: () => Promise.resolve({ prefix: 'a', items: [{ value: 'apple', label: 'apple' }] }),
      applyCompletion: (lines, line, col, item, prefix) => {
        const done = current.applyCompletion(lines, line, col, item, prefix);
        return { ...done, lines: [`${done.lines[0]} `], cursorCol: done.cursorCol + 1 };
      },
    });
    const response = await completeThroughChain([spacing], 'a', 1);
    expect(response.items[0].insert).toEqual({ text: 'apple ', cursor: 6 });
  });

  it('computes the caret across lines when a provider returns several', async () => {
    const multi: AutocompleteProviderFactory = () => ({
      ...baseProvider,
      getSuggestions: () => Promise.resolve({ prefix: '', items: [{ value: 'x', label: 'x' }] }),
      applyCompletion: () => ({ lines: ['ab', 'cd'], cursorLine: 1, cursorCol: 1 }),
    });
    expect((await completeThroughChain([multi], '', 0)).items[0].insert).toEqual({ text: 'ab\ncd', cursor: 4 });
  });

  it('stops waiting for a provider that never answers, at the timeout', async () => {
    const hanging: AutocompleteProviderFactory = (current) => ({ ...current, getSuggestions: () => new Promise(() => undefined) });
    const started = Date.now();
    expect(await completeThroughChain([hanging], 'x', 1, { timeoutMs: 30 })).toEqual({ prefix: '', items: [] });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('hands the provider a signal that fires at the timeout and when the caller aborts', async () => {
    let seen: AbortSignal | undefined;
    const spy: AutocompleteProviderFactory = (current) => ({
      ...current,
      getSuggestions: (_l, _c, _o, options) => {
        seen = options.signal;
        return new Promise(() => undefined);
      },
    });
    const caller = new AbortController();
    const pending = completeThroughChain([spy], 'x', 1, { signal: caller.signal, timeoutMs: 10_000 });
    expect(seen?.aborted).toBe(false);
    caller.abort();
    expect(await pending).toEqual({ prefix: '', items: [] });
    expect(seen?.aborted).toBe(true);
  });

  it('clamps a caret past the end of the text', async () => {
    const response = await completeThroughChain([fruit], '/pk-fruit a', 99);
    expect(response.items[0].insert.text).toBe('/pk-fruit apple');
  });
});
