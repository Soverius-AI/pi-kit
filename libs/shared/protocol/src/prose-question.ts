/**
 * Questions in prose: an assistant turn that ends in a question and no dialog pending. The thread counts as waiting for an
 * answer (the backend says so in the thread list) and the composer offers "Reply" with a pill per option when the text lists them
 * ("Vitest, Jest or Mocha?"). Pure text heuristics, shared by the backend (waiting) and the renderer (pills); they err on the side
 * of showing nothing: a wrong pill costs a click, a missing one costs a few words.
 */

const TRAILING = /\?[\s*_)"'`\]»”’]*$/;

/** The last non-empty line of the text, unless it is inside (or ends) a code fence. */
function lastLine(text: string): string | undefined {
  const trimmed = text.trimEnd();
  if (!trimmed || trimmed.endsWith('```')) return undefined;
  const fences = trimmed.split('\n').filter((l) => l.trimStart().startsWith('```')).length;
  if (fences % 2 === 1) return undefined;
  return trimmed.slice(trimmed.lastIndexOf('\n') + 1);
}

/** Does the text end with a question? */
export function endsWithQuestion(text: string): boolean {
  const line = lastLine(text);
  return line !== undefined && TRAILING.test(line);
}

const BULLET = /^\s*(?:[-*•]|\d{1,2}[.)]|\(?[a-zA-Z][.)])\s+(.*\S)\s*$/;
const STEM = /^(?:should|shall|would|could|can|do|does|did|will|want|like|prefer|is|are|i|we|you|me|us|use|using|go|going|with|choose|pick|take|try|keep|for|on|to|have|run|build|make|and)$/i;
const MAX_OPTIONS = 5;
const MAX_WORDS = 5;

const clean = (value: string): string =>
  value
    .replace(/[*_`]+/g, '')
    .replace(/[.,;:!?]+$/, '')
    .trim();

/** A list item's head: "Vitest, the default runner" and "Vitest - fast" both give "Vitest" when the head is short. */
function itemLabel(item: string): string {
  const text = clean(item);
  const head = text.split(/\s+[—–-]\s+|:\s+|,\s+/)[0];
  const label = clean(head.length >= 2 && head.length <= 40 ? head : text);
  return label;
}

/** The options a question lists, for the reply pills. Empty when it lists none (or too many, or long ones). */
export function replyOptions(text: string): string[] {
  const trimmed = text.trimEnd();
  const line = lastLine(trimmed);
  if (line === undefined || !TRAILING.test(line)) return [];

  // 1. A list right above the question line.
  const lines = trimmed.split('\n');
  const above = lines.slice(0, -1);
  while (above.length && !above[above.length - 1].trim()) above.pop();
  const items: string[] = [];
  for (let i = above.length - 1; i >= 0; i--) {
    const match = BULLET.exec(above[i]);
    if (!match) break;
    items.unshift(match[1]);
  }
  if (items.length >= 2 && items.length <= MAX_OPTIONS) {
    const labels = items.map(itemLabel);
    if (labels.every((l) => l.length > 0 && l.length <= 48)) return dedupe(labels);
  }

  // 2. "A, B or C?" in the last sentence.
  const sentence = clean(line.split(/(?<=[.!:;])\s+/).at(-1) ?? line);
  if (!/\bor\b/i.test(sentence)) return [];
  const parts = sentence
    .split(/,\s*or\s+|\s+or\s+|,\s*/i)
    .map((p) => clean(p))
    .filter(Boolean);
  if (parts.length < 2 || parts.length > MAX_OPTIONS) return [];
  const words = parts[0].split(/\s+/);
  while (words.length > 1 && STEM.test(words[0].replace(/[^A-Za-z]/g, ''))) words.shift();
  parts[0] = words.join(' ');
  if (parts.some((p) => p.split(/\s+/).length > MAX_WORDS)) return [];
  return dedupe(parts);
}

const dedupe = (values: string[]): string[] => [...new Set(values)];
