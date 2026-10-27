/**
 * Fuzzy matching shared by the command menu (renderer) and the `@` file search (backend): the query's
 * characters must appear in the text in order, case-insensitively. Higher is better; `-1` is no match.
 * Runs of consecutive characters, matches at the start of a word (after `/ - _ . : space`) and at the very
 * start score extra, and a shorter text beats a longer one with the same match.
 */
export function fuzzyScore(query: string, text: string): number {
  if (query === '') return 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let score = 0;
  let ti = 0;
  let run = 0;
  for (let qi = 0; qi < q.length; qi++) {
    const found = t.indexOf(q[qi], ti);
    if (found < 0) return -1;
    const consecutive = found === ti && qi > 0;
    run = consecutive ? run + 1 : 0;
    const boundary = found === 0 || '/-_.: '.includes(t[found - 1]);
    score += 1 + run * 2 + (boundary ? 4 : 0) + (found === 0 ? 4 : 0);
    ti = found + 1;
  }
  // An exact substring is what people mean by a good match.
  if (t.includes(q)) score += 10;
  return score - Math.min(text.length, 80) / 80;
}

/** Items that match, best first; ties keep their original order. */
export function fuzzyFilter<T>(items: readonly T[], query: string, text: (item: T) => string): T[] {
  if (query.trim() === '') return [...items];
  return items
    .map((item, index) => ({ item, index, score: fuzzyScore(query.trim(), text(item)) }))
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.item);
}
