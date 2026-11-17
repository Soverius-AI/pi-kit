import createDOMPurify from 'dompurify';

let purifier: ReturnType<typeof createDOMPurify> | undefined;

export const escapeHtml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A private sanitizer: host/global hooks cannot weaken this policy. Never serialize and reparse the sanitized tree. */
export function markdownFragment(html: string): DocumentFragment | undefined {
  if (typeof window === 'undefined') return undefined;
  purifier ??= createDOMPurify(window);
  if (!purifier.isSupported) return undefined;
  return purifier.sanitize(html, {
    RETURN_DOM_FRAGMENT: true,
    // KaTeX's accessible MathML keeps its structure and the source annotation remains non-visual.
    ADD_TAGS: ['semantics', 'annotation'],
    // The desktop shell opens target=_blank links externally and cancels plain in-window navigation.
    ADD_ATTR: ['target'],
    FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed'],
  });
}
