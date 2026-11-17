import { renderToString } from 'katex';
import type { TokenizerAndRendererExtension, Tokens } from 'marked';
import { escapeHtml } from './markdown-dom';

interface MathToken extends Tokens.Generic {
  type: 'math' | 'blockMath';
  text: string;
  display: boolean;
}

const literalMath = (raw: string): string => `<span class="pk-math-error">${escapeHtml(raw)}</span>`;

function renderMath(token: Tokens.Generic): string {
  const math = token as MathToken;
  // maxExpand bounds macro expansion, not the parser's recursion. Bound nesting separately,
  // and contain non-ParseError failures so one pathological formula cannot break an answer.
  let depth = 0;
  if (math.text.length > 10_000) return literalMath(math.raw);
  for (const character of math.text) {
    if (character === '{' && ++depth > 100) return literalMath(math.raw);
    if (character === '}') depth = Math.max(0, depth - 1);
  }
  try {
    return renderToString(math.text, {
      displayMode: math.display,
      throwOnError: false,
      trust: false,
      strict: 'ignore',
      maxExpand: 1000,
      maxSize: 20,
    });
  } catch {
    return literalMath(math.raw);
  }
}

/** Tokenizers, not a replacement over HTML: dollars in code, attributes and link targets stay literal. */
export const mathExtensions: TokenizerAndRendererExtension[] = [
  {
    name: 'blockMath',
    level: 'block',
    start: (source) => source.match(/(?:^|\n) {0,3}\$\$[ \t]*\n/)?.index,
    tokenizer(source): MathToken | undefined {
      const match = /^ {0,3}\$\$[ \t]*\n([\s\S]+?)\n[ \t]*\$\$(?:[ \t]*(?:\n|$))/.exec(source);
      return match ? { type: 'blockMath', raw: match[0], text: match[1], display: true } : undefined;
    },
    renderer: renderMath,
  },
  {
    name: 'math',
    level: 'inline',
    start: (source) => source.indexOf('$'),
    tokenizer(source): MathToken | undefined {
      const display = /^\$\$([^$]+?)\$\$/.exec(source);
      if (display) return { type: 'math', raw: display[0], text: display[1], display: true };
      // A closing dollar cannot follow whitespace or precede a digit: "$349 ... $289" is currency.
      const inline = /^\$(?!\s)([^$\n]*?\S)\$(?!\d)/.exec(source);
      return inline ? { type: 'math', raw: inline[0], text: inline[1], display: false } : undefined;
    },
    renderer: renderMath,
  },
];
