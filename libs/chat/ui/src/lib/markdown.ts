import { Injectable, signal } from '@angular/core';
// CopilotKit and pi-kit share the common registry. The remaining grammars load on first use.
import hljs from 'highlight.js/lib/common';
import { completePartialMarkdown } from '@copilotkit/core';
import { Marked, type Token, type Tokens, type TokensList } from 'marked';
import { escapeHtml } from './markdown-dom';
import { mathExtensions } from './markdown-math';

const grammarRevision = signal(0);
let allGrammars: Promise<unknown> | undefined;
function ensureLanguage(language: string): void {
  grammarRevision();
  if (hljs.getLanguage(language) || allGrammars) return;
  allGrammars = import('highlight.js')
    .then(() => grammarRevision.update((version) => version + 1))
    .catch(() => {
      allGrammars = undefined;
    });
}

/** Highlighted `<code>` content for a language highlight.js knows, else the escaped text. */
export function highlight(code: string, language?: string): { html: string; language?: string } {
  if (language) ensureLanguage(language);
  if (language && hljs.getLanguage(language)) {
    return { html: hljs.highlight(code, { language, ignoreIllegals: true }).value, language };
  }
  return { html: escapeHtml(code) };
}

/** Language name for a file path (by extension), for highlighting file content. */
export function languageOf(path: string | undefined): string | undefined {
  const ext = path?.split('.').pop()?.toLowerCase();
  if (!ext || ext === path?.toLowerCase()) return undefined;
  const alias: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    jsx: 'javascript',
    md: 'markdown',
    yml: 'yaml',
    sh: 'bash',
    zsh: 'bash',
    rs: 'rust',
    py: 'python',
    rb: 'ruby',
    html: 'xml',
    htm: 'xml',
    vue: 'xml',
    svg: 'xml',
  };
  const name = alias[ext] ?? ext;
  ensureLanguage(name);
  return hljs.getLanguage(name) ? name : undefined;
}

const CACHE_ENTRIES = 400;

export interface MarkdownBlock {
  readonly kind: 'code' | 'mermaid';
  readonly code: string;
  readonly language: string;
  readonly streaming: boolean;
}

export interface MarkdownDocument {
  readonly html: string;
  readonly blocks: readonly MarkdownBlock[];
}

/** Whether the original token has a closing fence; never infer completion from synthetically repaired Markdown. */
function closedFence(token: Tokens.Code): boolean {
  const opening = /^ {0,3}(`{3,}|~{3,})[^\n]*(?:\n|$)/.exec(token.raw);
  if (!opening) return true; // Indented code is not a streaming diagram fence.
  if (opening[0].length === token.raw.length) return false; // The header itself may still be arriving.
  const fence = opening[1];
  const last = token.raw.trimEnd().split('\n').at(-1) ?? '';
  return new RegExp(`^ {0,3}${fence[0]}{${fence.length},}[ \\t]*$`).test(last);
}

interface RenderContext {
  blocks: MarkdownBlock[];
  streaming: boolean;
}

function parser(context: RenderContext): Marked {
  return new Marked({
    gfm: true,
    breaks: false,
    extensions: mathExtensions,
    renderer: {
      code(token) {
        const language = token.lang?.split(/\s+/)[0] ?? '';
        const index = context.blocks.length;
        context.blocks.push({
          kind: language.toLowerCase() === 'mermaid' ? 'mermaid' : 'code',
          code: token.text,
          language,
          streaming: context.streaming && !closedFence(token),
        });
        return `<div data-pk-block="${index}"></div>`;
      },
      html({ text }) {
        return escapeHtml(text);
      },
      link({ href, title, tokens }) {
        const label = this.parser.parseInline(tokens);
        const safe = /^(https?:|mailto:|#|\/)/i.test(href) ? href : '#';
        return `<a href="${escapeHtml(safe)}"${title ? ` title="${escapeHtml(title)}"` : ''} target="_blank" rel="noopener noreferrer">${label}</a>`;
      },
    },
  });
}

type InlineBlock = Tokens.Paragraph | Tokens.Heading | Tokens.Text;
// Prose followed by one of these (or a blank line) is finished, so the stream tail is not inline text.
const TAIL_BARRIERS = new Set(['code', 'table', 'hr', 'html', 'space', 'def', 'blockMath']);

/** Markdown + math, with component slots for code/diagrams. Raw HTML stays text; Prose sanitizes the generated DOM. */
@Injectable({ providedIn: 'root' })
export class MarkdownService {
  private readonly context: RenderContext = { blocks: [], streaming: false };
  private readonly marked = parser(this.context);
  /** Completed text is cached because virtualized rows are frequently remounted. */
  private readonly documents = new Map<string, MarkdownDocument>();

  document(text: string, streaming = false): MarkdownDocument {
    if (streaming) return this.parse(text, true);
    const result = this.documents.get(text) ?? this.parse(text, false);
    this.documents.delete(text);
    this.documents.set(text, result);
    if (this.documents.size > CACHE_ENTRIES) this.documents.delete(this.documents.keys().next().value as string);
    return result;
  }

  private parse(text: string, streaming: boolean): MarkdownDocument {
    const blocks: MarkdownBlock[] = [];
    this.context.blocks = blocks;
    this.context.streaming = streaming;
    const tokens = this.marked.lexer(text);
    if (streaming) this.repairTail(tokens);
    return { html: this.marked.parser(tokens), blocks };
  }

  /**
   * Complete the trailing inline prose only. Earlier paragraphs are finished (a closer would turn
   * "snake_case" into "snake_case_"), and repairing fenced code would invent Mermaid source.
   */
  private repairTail(tokens: TokensList): void {
    let tail: Token | undefined;
    void this.marked.walkTokens(tokens, (token) => {
      if (TAIL_BARRIERS.has(token.type) && !(token.type === 'html' && !token.block)) tail = token;
      else if ((token.type === 'paragraph' || token.type === 'heading' || token.type === 'text') && token.tokens)
        tail = token;
    });
    if (!tail || TAIL_BARRIERS.has(tail.type)) return;
    const prose = tail as InlineBlock;
    // Mask complete math while calculating the appended closers so underscores/brackets in TeX
    // aren't mistaken for unfinished Markdown. The mask has the same length as the source.
    let masked = prose.text;
    for (const inline of prose.tokens ?? []) {
      if (inline.type === 'math') masked = masked.replace(inline.raw, '`' + 'x'.repeat(inline.raw.length - 2) + '`');
    }
    const suffix = completePartialMarkdown(masked).slice(masked.length);
    if (!suffix) return;
    // A fresh lexer has no link definitions; share the document's so reference links still resolve.
    const lexer = new this.marked.Lexer(this.marked.defaults);
    lexer.tokens.links = tokens.links;
    prose.tokens = lexer.inlineTokens(prose.text + suffix);
  }
}
