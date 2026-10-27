import type { PiSessionEntry } from '@pi-kit/pi-adapter';
import type { PiDialogRequest } from '@pi-kit/protocol';

/**
 * What the attendant reads of a thread and what it asks the model. Pure: the digest is built from the session entries, the prompts
 * from the digest, and a model's reply is cleaned (or refused) here, so each step is tested without a model.
 */

export interface DigestLine {
  role: 'user' | 'assistant';
  text: string;
}

export interface ThreadDigest {
  /** The first user message of the branch. */
  first: string;
  /** The last few messages of the branch, oldest first. */
  recent: DigestLine[];
  /** Tool names the assistant called on the branch, in order of first use. */
  tools: string[];
  /** The assistant has answered at least once. */
  answered: boolean;
}

const RECENT = 6;
const FIRST_CHARS = 500;
const LINE_CHARS = 300;

interface Block {
  type?: string;
  text?: string;
  name?: string;
}

const textOf = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return (content as Block[])
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n');
};

const squeeze = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** The branch that ends at `leafId` (the last entry when null), root first: what the thread's transcript holds. */
export function branchOf(entries: readonly PiSessionEntry[], leafId: string | null): PiSessionEntry[] {
  const byId = new Map(entries.map((e) => [e.id, e] as const));
  const path: PiSessionEntry[] = [];
  for (let current = leafId ? byId.get(leafId) : entries.at(-1); current && path.length <= entries.length; current = current.parentId ? byId.get(current.parentId) : undefined) {
    path.push(current);
  }
  return path.reverse();
}

export function digestOf(entries: readonly PiSessionEntry[], leafId: string | null): ThreadDigest {
  const lines: DigestLine[] = [];
  const tools: string[] = [];
  let answered = false;
  for (const entry of branchOf(entries, leafId)) {
    if (entry.type !== 'message') continue;
    const message = entry['message'] as { role?: string; content?: unknown } | undefined;
    if (message?.role === 'user') {
      const text = squeeze(textOf(message.content), FIRST_CHARS);
      if (text) lines.push({ role: 'user', text });
    } else if (message?.role === 'assistant') {
      if (Array.isArray(message.content)) {
        for (const block of message.content as Block[]) if (block.type === 'toolCall' && block.name && !tools.includes(block.name)) tools.push(block.name);
      }
      const text = squeeze(textOf(message.content), FIRST_CHARS);
      if (text) {
        lines.push({ role: 'assistant', text });
        answered = true;
      }
    }
  }
  const first = lines.find((l) => l.role === 'user')?.text ?? '';
  return {
    first: first.slice(0, FIRST_CHARS),
    recent: lines.slice(-RECENT).map((l) => ({ role: l.role, text: squeeze(l.text, LINE_CHARS) })),
    tools,
    answered,
  };
}

const conversation = (digest: ThreadDigest): string =>
  [`First message: ${digest.first || '(none)'}`, '', 'Latest messages:', ...digest.recent.map((l) => `${l.role === 'user' ? 'User' : 'Agent'}: ${l.text}`), ...(digest.tools.length ? ['', `Tools used: ${digest.tools.join(', ')}`] : [])].join('\n');

export interface Prompt {
  system: string;
  user: string;
}

export function titlePrompt(digest: ThreadDigest): Prompt {
  return {
    system:
      'You name conversations between a developer and a coding agent. Reply with a title of 6 to 10 words in the language of the conversation: no quotes, no markdown, no trailing period, nothing else.',
    user: `${conversation(digest)}\n\nTitle:`,
  };
}

export function summaryPrompt(digest: ThreadDigest, question?: string): Prompt {
  return {
    system:
      'You keep a one-line status of a conversation between a developer and a coding agent. Reply with one line of at most 14 words saying what the agent is doing now or what it needs from the user, in the present tense, in the language of the conversation: no quotes, no markdown, nothing else.',
    user: `${conversation(digest)}${question ? `\n\nThe agent is waiting for the user to answer: ${question}` : ''}\n\nStatus:`,
  };
}

export function labelPrompt(point: { preview: string; branches: string[] }): Prompt {
  return {
    system:
      'You label the point where a conversation with a coding agent branches into different directions. Reply with a label of 2 to 4 words that names what was being decided or tried at that point: no quotes, no markdown, no trailing period, nothing else.',
    user: [`The conversation at the branch point: ${point.preview}`, '', 'It continues in these directions:', ...point.branches.map((b, i) => `${i + 1}. ${b}`), '', 'Label:'].join('\n'),
  };
}

/** The choices a question offers a user: Allow or Deny for a yes/no question, the options of a list. Other kinds of dialog are not answered by the attendant. */
export function answerOptions(request: PiDialogRequest): string[] | undefined {
  if (request.method === 'confirm') return ['Allow', 'Deny'];
  if (request.method === 'select' && request.options && request.options.length > 0) return request.options;
  return undefined;
}

export function draftPrompt(request: PiDialogRequest, options: readonly string[], digest: ThreadDigest): Prompt {
  return {
    system:
      'A coding agent has stopped and asks its user a question. You draft the answer only when the question is mechanical: a routine, low-risk confirmation or a choice with an obvious safe default. ' +
      'Never approve anything that deletes, overwrites, publishes, spends money, runs unknown code or touches credentials: answer SKIP for those, and whenever you are unsure. ' +
      `Reply with exactly one of these words or phrases and nothing else: ${[...options, 'SKIP'].join(' | ')}`,
    user: [`Question: ${request.title}`, ...(request.message ? [`Details: ${request.message}`] : []), `Choices: ${options.join(', ')}`, '', 'What the conversation is about:', conversation(digest), '', 'Answer:'].join('\n'),
  };
}

// ---- cleaning what a model said

const firstLine = (text: string): string => text.split('\n').map((l) => l.trim()).find(Boolean) ?? '';

/** Quotes, markdown and a "Title:" lead-in off a model's one-line answer. */
const bare = (text: string): string =>
  firstLine(text)
    .replace(/^(title|label|status|summary)\s*:\s*/i, '')
    .replace(/^[\s"'`*_#>\-–—]+|[\s"'`*_.!。]+$/g, '')
    .trim();

/** A 2–12 word title, at most 80 characters, no trailing period; undefined when the reply is empty or is not a title. */
export function cleanTitle(text: string): string | undefined {
  const title = bare(text);
  const words = title.split(/\s+/).filter(Boolean);
  if (words.length < 2) return undefined;
  const clipped = words.slice(0, 12).join(' ');
  return clipped.length > 80 ? `${clipped.slice(0, 79).replace(/\s+\S*$/, '')}…` : clipped;
}

/** One line of at most 100 characters; undefined when empty. */
export function cleanSummary(text: string): string | undefined {
  const line = bare(text);
  if (!line) return undefined;
  return line.length > 100 ? `${line.slice(0, 99).replace(/\s+\S*$/, '')}…` : line;
}

/** A 1–5 word label of at most 40 characters; undefined when empty. */
export function cleanLabel(text: string): string | undefined {
  const label = bare(text);
  const words = label.split(/\s+/).filter(Boolean);
  if (words.length === 0) return undefined;
  const clipped = words.slice(0, 5).join(' ');
  return clipped.length > 40 ? clipped.slice(0, 40).replace(/\s+\S*$/, '') : clipped;
}

/** The option a model named, matched without regard to case or punctuation; undefined for SKIP or anything that is not one of the options. */
export function parseChoice(text: string, options: readonly string[]): string | undefined {
  const answer = bare(text).toLowerCase();
  if (!answer || answer === 'skip') return undefined;
  return options.find((o) => o.toLowerCase() === answer);
}
