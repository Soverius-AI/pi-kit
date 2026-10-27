import type { ContextItem, ContextKind } from '@pi-kit/protocol';

/**
 * The context of a session, piece by piece, from the messages pi keeps for the model and the tools it declares: what the model sees and
 * where each piece came from, so a full context can be read (the context inspector of the Session panel). Pure: the service hands it the
 * agent's messages, its tools and the summaries of the session's compactions. Tokens are estimated as pi estimates them (characters over
 * four, an image as 4800 characters), so the numbers agree with pi's own compaction arithmetic and differ from the provider's count.
 */

const IMAGE_CHARS = 4800;
const TEXT_LIMIT = 4000;
const SKILL_BLOCK = /<skill\s+name="([^"]+)"[^>]*>[\s\S]*?<\/skill>/g;
const SECTION_LABELS: Record<string, string> = {
  preamble: 'Preamble',
  tools: 'Tool snippets',
  rules: 'Rules',
  docs: 'pi documentation',
  addendum: 'Appended prompt',
  project_context: 'Project context (AGENTS.md)',
  skills: 'Skills list',
  cwd: 'Working directory',
};

type Block = { type: string; text?: string; thinking?: string; name?: string; arguments?: unknown; id?: string };
export interface ContextMessage {
  role: string;
  content?: string | Block[];
  sections?: Record<string, string | null>;
  toolCallId?: string;
  toolName?: string;
  customType?: string;
  display?: boolean;
}
export interface ContextTool {
  name: string;
  description?: string;
  parameters?: unknown;
}

const tokensOf = (chars: number): number => Math.ceil(chars / 4);
const textOf = (content: string | Block[] | undefined): { text: string; chars: number } => {
  if (typeof content === 'string') return { text: content, chars: content.length };
  const parts: string[] = [];
  let chars = 0;
  for (const block of content ?? []) {
    if (block.type === 'text' && block.text) {
      parts.push(block.text);
      chars += block.text.length;
    } else if (block.type === 'image') {
      parts.push('[image]');
      chars += IMAGE_CHARS;
    }
  }
  return { text: parts.join('\n'), chars };
};
const firstLine = (text: string): string => text.split('\n').find((line) => line.trim())?.trim().slice(0, 100) ?? '';

export function buildContextItems(messages: ContextMessage[], tools: ContextTool[], summaries: string[]): ContextItem[] {
  const items: ContextItem[] = [];
  const calls = new Map<string, string>();
  let turn = 0;
  const add = (kind: ContextKind, label: string, source: string | null, text: string, chars: number, extra: Partial<ContextItem> = {}): void => {
    items.push({
      id: `${kind}:${items.length}`,
      kind,
      label,
      source,
      tokens: tokensOf(chars),
      chars,
      text: text.slice(0, TEXT_LIMIT),
      truncated: text.length > TEXT_LIMIT,
      turn: turn || null,
      ...extra,
    });
  };
  for (const tool of tools) {
    const text = `${tool.description ?? ''}\n${JSON.stringify(tool.parameters ?? {}, null, 1)}`;
    add('tool', tool.name, `tool:${tool.name}`, text, text.length, { turn: null });
  }
  for (const message of messages) {
    if (message.role === 'system') {
      const base = textOf(message.content);
      if (base.chars) add('system', 'System prompt', 'pi', base.text, base.chars, { turn: null });
      for (const [name, section] of Object.entries(message.sections ?? {})) {
        if (!section) continue;
        add('system', SECTION_LABELS[name] ?? name, SECTION_LABELS[name] ? 'pi' : `extension:${name}`, section, section.length, { turn: null });
      }
      continue;
    }
    if (message.role === 'user') {
      turn += 1;
      const { text, chars } = textOf(message.content);
      if (summaries.some((summary) => summary && text.includes(summary))) {
        add('summary', 'Compaction summary', 'compaction', text, chars);
        continue;
      }
      let rest = text;
      let restChars = chars;
      for (const match of text.matchAll(SKILL_BLOCK)) {
        add('skill', match[1], `skill:${match[1]}`, match[0], match[0].length);
        rest = rest.replace(match[0], '');
        restChars -= match[0].length;
      }
      if (rest.trim() || restChars > 0) add('user', firstLine(rest) || '(images)', 'user', rest.trim(), Math.max(0, restChars));
      continue;
    }
    if (message.role === 'assistant') {
      for (const block of (message.content ?? []) as Block[]) {
        if (block.type === 'text' && block.text) add('assistant', firstLine(block.text), 'model', block.text, block.text.length);
        else if (block.type === 'thinking' && block.thinking) add('thinking', firstLine(block.thinking), 'model', block.thinking, block.thinking.length);
        else if (block.type === 'toolCall' && block.name) {
          const args = JSON.stringify(block.arguments ?? {});
          if (block.id) calls.set(block.id, block.name);
          add('toolCall', block.name, `tool:${block.name}`, args, block.name.length + args.length);
        }
      }
      continue;
    }
    if (message.role === 'toolResult') {
      const name = message.toolName ?? (message.toolCallId ? calls.get(message.toolCallId) : undefined) ?? 'tool';
      const { text, chars } = textOf(message.content);
      add('toolResult', name, `tool:${name}`, text, chars);
      continue;
    }
    const { text, chars } = textOf(message.content);
    if (chars) add('extension', message.customType ?? message.role, `extension:${message.customType ?? message.role}`, text, chars);
  }
  return items;
}

/** The items summed per kind, largest first. */
export function groupContextItems(items: ContextItem[]): { kind: ContextKind; tokens: number; count: number }[] {
  const groups = new Map<ContextKind, { kind: ContextKind; tokens: number; count: number }>();
  for (const item of items) {
    const group = groups.get(item.kind) ?? { kind: item.kind, tokens: 0, count: 0 };
    group.tokens += item.tokens;
    group.count += 1;
    groups.set(item.kind, group);
  }
  return [...groups.values()].sort((a, b) => b.tokens - a.tokens);
}
