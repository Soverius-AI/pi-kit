import { readFileSync, statSync } from 'node:fs';

/** A prompt template that wants a suggestion pill in the composer. */
export interface PromptSuggestion {
  suggested: true;
  /** `suggestion-title` of the frontmatter, when it has one. */
  suggestionTitle?: string;
}

/** The frontmatter block of a markdown file as flat `key: value` pairs; `undefined` when the file has none. Values keep no quotes. */
export function readFrontmatter(content: string): Record<string, string> | undefined {
  const lines = content.replace(new RegExp(`^${String.fromCharCode(0xfeff)}`), '').split(/\r?\n/);
  if (lines[0]?.trimEnd() !== '---') return undefined;
  const end = lines.findIndex((line, index) => index > 0 && line.trimEnd() === '---');
  if (end < 0) return undefined;
  const fields: Record<string, string> = {};
  for (const line of lines.slice(1, end)) {
    const match = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!match) continue; // a comment, a list item, a continuation line: not a flat pair
    fields[match[1]] = unquote(match[2].trim());
  }
  return fields;
}

function unquote(value: string): string {
  const quote = value[0];
  if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) return value.slice(1, -1);
  return value;
}

/** `suggested: true` and the optional `suggestion-title` of a prompt template's frontmatter. */
export function parsePromptSuggestion(content: string): PromptSuggestion | undefined {
  const fields = readFrontmatter(content);
  if (!fields || fields['suggested']?.toLowerCase() !== 'true') return undefined;
  const title = fields['suggestion-title'];
  return { suggested: true, ...(title ? { suggestionTitle: title } : {}) };
}

/** Reads prompt templates' frontmatter for the command list, remembering the answer for a file until it changes (path and mtime). */
export class PromptSuggestionReader {
  private readonly cache = new Map<string, { mtimeMs: number; size: number; suggestion: PromptSuggestion | undefined }>();

  read(path: string): PromptSuggestion | undefined {
    try {
      const stat = statSync(path);
      const cached = this.cache.get(path);
      if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.suggestion;
      const suggestion = parsePromptSuggestion(readFileSync(path, 'utf8'));
      this.cache.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, suggestion });
      return suggestion;
    } catch {
      this.cache.delete(path);
      return undefined; // a template that is not a readable file (an extension-provided one, say) is just not suggested
    }
  }
}
