import { Injectable, signal } from '@angular/core';
// CopilotKit and pi-kit share the common registry. The remaining grammars load on first use.
import hljs from 'highlight.js/lib/common';
import { Marked } from 'marked';

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

const escapeHtml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

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

/**
 * Markdown for assistant text (`marked` + `highlight.js`, both pinned). Fenced code is highlighted
 * with highlight.js; raw HTML in the text is shown as text, not rendered. The result still goes through
 * Angular's sanitiser when bound with `[innerHTML]`.
 */
@Injectable({ providedIn: 'root' })
export class MarkdownService {
  private readonly marked = new Marked({
    gfm: true,
    breaks: false,
    renderer: {
      code({ text, lang }) {
        const { html, language } = highlight(text, lang?.split(/\s+/)[0]);
        return `<pre><code class="hljs${language ? ` language-${language}` : ''}">${html}</code></pre>`;
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

  /** Rendered text of blocks that are not streaming, newest last; a virtualized transcript draws the same blocks again and again. */
  private readonly cache = new Map<string, string>();
  private cacheRevision = 0;

  render(text: string): string {
    return this.marked.parse(text, { async: false });
  }

  /** `render` for text that no longer changes: the last `CACHE_ENTRIES` results are kept. */
  renderCached(text: string): string {
    const revision = grammarRevision();
    if (this.cacheRevision !== revision) {
      this.cache.clear();
      this.cacheRevision = revision;
    }
    const hit = this.cache.get(text);
    if (hit !== undefined) {
      this.cache.delete(text);
      this.cache.set(text, hit);
      return hit;
    }
    const html = this.render(text);
    this.cache.set(text, html);
    if (this.cache.size > CACHE_ENTRIES) this.cache.delete(this.cache.keys().next().value as string);
    return html;
  }
}
