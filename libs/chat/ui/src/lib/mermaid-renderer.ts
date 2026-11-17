import { Injectable } from '@angular/core';
import createDOMPurify from 'dompurify';

export const MERMAID_MAX_TEXT_SIZE = 50_000;
export const MERMAID_MAX_EDGES = 500;
const CACHE_ENTRIES = 32;
const CACHE_BYTES = 4_000_000;
const MAX_SVG_SIZE = 1_000_000;
// Mermaid's configuration and renderer are global, even across injector instances.
let renderQueue: Promise<unknown> = Promise.resolve();
let nextId = 0;
let mermaidModule: Promise<typeof import('mermaid')> | undefined;
let initializedDark: boolean | undefined;

/**
 * A CSS url() argument that can reach a resource. Plain words ("new URL(input)", "URL (primary)") resolve at most
 * to the app's own origin; schemes, slashes, escapes and entities are rejected. Unterminated url( runs to the end.
 */
function fetchable([, argument]: RegExpMatchArray): boolean {
  return !/^[\w\s'".,-]*$/.test(argument);
}

/** A source the policy forbids; trimming it to a shorter streaming prefix must not bypass the rejection. */
export class MermaidPolicyError extends Error {}

/** Reject configuration before Mermaid gets a chance to interpret it, including while streaming. */
export function validateMermaidSource(source: string): void {
  if (source.length > MERMAID_MAX_TEXT_SIZE)
    throw new MermaidPolicyError('Diagram exceeds the 50,000 character limit.');
  if (!source.trim()) throw new MermaidPolicyError('Diagram source is empty.');
  if (/%%\s*\{/.test(source) || /^\s*---(?:\s|$)/m.test(source)) {
    throw new MermaidPolicyError('Diagram configuration directives and frontmatter are not allowed.');
  }
  if (/(?:^|[;\r\n])\s*click\b/i.test(source))
    throw new MermaidPolicyError('Diagram links and callbacks are not allowed.');
  // Mermaid can load images and apply CSS in the live DOM BEFORE returning SVG. Reject
  // the whole metadata/styling feature, not merely URL spellings in its eventual output.
  if (/@\s*\{|@import|@font-face/i.test(source) || [...source.matchAll(/url\s*\(([^)]*)/gi)].some(fetchable)) {
    throw new MermaidPolicyError('Diagram image metadata and custom styles are not allowed.');
  }
}

// Diagram types without style statements, where a line may begin with the free text "Style ...".
const UNSTYLED = new Set(['gantt', 'journey', 'timeline', 'mindmap', 'kanban']);

/** Keyword checks use Mermaid's own diagram type: elsewhere these words are text, like the Gantt task "Style guide". */
function validateParsed(source: string, { diagramType, config }: { diagramType: string; config?: object }): void {
  if (config && Object.keys(config).length) {
    throw new MermaidPolicyError('Diagram configuration directives and frontmatter are not allowed.');
  }
  const sequence = diagramType === 'sequence';
  const links =
    (sequence && /(?:^|[;\r\n])\s*links?\b/i.test(source)) ||
    ((diagramType === 'class' || diagramType === 'classDiagram') &&
      /(?:^|[;\r\n])\s*(?:link|callback)\b/i.test(source));
  if (links) throw new MermaidPolicyError('Diagram links and callbacks are not allowed.');
  if (
    (!UNSTYLED.has(diagramType) && /(?:^|[;\r\n])\s*(?:style|classDef|linkStyle)\b/i.test(source)) ||
    (sequence && /(?:^|[;\r\n])\s*(?:properties|details)\b/i.test(source))
  ) {
    throw new MermaidPolicyError('Diagram image metadata and custom styles are not allowed.');
  }
}

/** Only fragment references (Mermaid's own markers and gradients) may appear in CSS url(). */
function assertLocalUrls(css: string): void {
  for (const match of css.matchAll(/url\s*\(([^)]*)\)/gi)) {
    if (
      !match[1]
        .trim()
        .replace(/^['"]|['"]$/g, '')
        .startsWith('#')
    ) {
      throw new Error('External diagram resources are not allowed.');
    }
  }
}

/** Lazy, serialized Mermaid rendering. Only sanitized, isolated SVG image URLs leave this service. */
@Injectable({ providedIn: 'root' })
export class MermaidRenderer {
  private readonly cache = new Map<string, string>();
  private cacheBytes = 0;
  // Streaming snapshots overwrite one slot instead of evicting finished diagrams from the LRU.
  private preview?: { key: string; image: string };
  private purifier?: ReturnType<typeof createDOMPurify>;

  render(source: string, dark: boolean, preview = false): Promise<string> {
    try {
      validateMermaidSource(source);
    } catch (error) {
      return Promise.reject(error);
    }
    const key = `${dark ? 'dark' : 'light'}\0${source}`;
    const work = renderQueue.then(async () => {
      const cached = this.cache.get(key) ?? (this.preview?.key === key ? this.preview.image : undefined);
      if (cached) {
        if (!preview) this.remember(key, cached);
        return cached;
      }
      const { default: mermaid } = await (mermaidModule ??= import('mermaid').catch((error) => {
        mermaidModule = undefined;
        throw error;
      }));
      if (initializedDark !== dark) {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          suppressErrorRendering: true,
          maxTextSize: MERMAID_MAX_TEXT_SIZE,
          maxEdges: MERMAID_MAX_EDGES,
          htmlLabels: false,
          theme: dark ? 'dark' : 'default',
          flowchart: { htmlLabels: false },
          secure: [
            'secure',
            'securityLevel',
            'startOnLoad',
            'maxTextSize',
            'maxEdges',
            'suppressErrorRendering',
            'htmlLabels',
          ],
        });
        initializedDark = dark;
      }
      validateParsed(source, await mermaid.parse(source));
      // Never call bindFunctions: model-supplied callbacks are not executable UI.
      const { svg } = await mermaid.render(`pk-mermaid-${++nextId}`, source);
      const image = this.sanitizeImage(svg);
      if (preview) this.preview = { key, image };
      else this.remember(key, image);
      return image;
    });
    renderQueue = work.catch(() => undefined);
    return work;
  }

  private remember(key: string, image: string): void {
    const previous = this.cache.get(key);
    if (previous !== undefined) {
      this.cache.delete(key);
      this.cacheBytes -= previous.length;
    }
    if (image.length > CACHE_BYTES) return;
    this.cache.set(key, image);
    this.cacheBytes += image.length;
    while (this.cache.size > CACHE_ENTRIES || this.cacheBytes > CACHE_BYTES) {
      const oldest = this.cache.entries().next().value;
      if (!oldest) break;
      this.cacheBytes -= oldest[1].length;
      this.cache.delete(oldest[0]);
    }
  }

  private sanitizeImage(svg: string): string {
    if (svg.length > MAX_SVG_SIZE) throw new Error('Rendered diagram is too large.');
    // DOMPurify does not sanitize CSS. Reject network-bearing CSS before preserving Mermaid styles.
    if (/@import|expression\s*\(/i.test(svg)) throw new Error('Unsafe diagram styling.');
    assertLocalUrls(svg);
    if (typeof window === 'undefined' || typeof DOMParser === 'undefined') {
      throw new Error('Secure diagram sanitization is unavailable in this environment.');
    }
    if (!this.purifier) {
      this.purifier = createDOMPurify(window);
      if (!this.purifier.isSupported) {
        this.purifier = undefined;
        throw new Error('Secure diagram sanitization is unavailable in this environment.');
      }
      this.purifier.addHook('uponSanitizeAttribute', (_node, data) => {
        if (/^(?:href|xlink:href)$/i.test(data.attrName) && !data.attrValue.startsWith('#')) {
          data.keepAttr = false;
        }
      });
    }
    const clean = this.purifier.sanitize(svg, {
      USE_PROFILES: { svg: true, svgFilters: true },
      FORBID_TAGS: [
        'script',
        'foreignObject',
        'a',
        'image',
        'iframe',
        'animate',
        'animateMotion',
        'animateTransform',
        'set',
      ],
      FORBID_ATTR: ['tabindex'],
    });
    if (!/^\s*<svg[\s>]/i.test(clean)) throw new Error('Renderer did not return an SVG diagram.');
    // Inspect decoded attributes as well: XML entities and CSS escapes must not disguise URLs.
    const document = new DOMParser().parseFromString(clean, 'image/svg+xml');
    const styles = [
      ...Array.from(document.querySelectorAll('style'), (node) => node.textContent ?? ''),
      ...Array.from(document.querySelectorAll('[style]'), (node) => node.getAttribute('style') ?? ''),
    ];
    for (const style of styles) {
      if (/\\|@import|expression\s*\(/i.test(style)) throw new Error('Unsafe diagram styling.');
      assertLocalUrls(style);
    }
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(clean)}`;
  }
}
