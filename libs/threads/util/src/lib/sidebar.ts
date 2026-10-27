import type { Translate } from '@pi-kit/i18n';
import type { ThreadSuggestion, ThreadSummary, Workspace } from '@pi-kit/protocol';
import { DEFAULT_CONTEXT_THRESHOLDS, type ContextThresholds } from '@pi-kit/ui';
import { forkMeta } from './fork-meta';
import { contextLevel, stateKinds, type ProjectCounts, type StateKind } from './thread-state';

/**
 * What the thread sidebar says in words and colours: the project tile, the three lines of a row (title, summary line, status line), the
 * "Needs you" strip and its answer chips, and the tags of a folded project. All pure, so the rules are tested without a component; the template only draws them.
 */

// ---- the project tile

/** The theme colours a project tile can take: the four brand and status hues, and a neutral. Never a colour outside the tokens. */
export type TileHue = 'primary' | 'info' | 'success' | 'secondary' | 'neutral';
export const TILE_HUES: readonly TileHue[] = ['primary', 'info', 'success', 'secondary', 'neutral'];

/** FNV-1a over the UTF-16 units with a murmur finalizer: small, stable across runs and platforms, and well spread over a few buckets (plain FNV-1a modulo 5 clumps short names). */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/** The tile's colour: the same project always gets the same one (it comes from the name, not from the order). */
export function tileHue(name: string): TileHue {
  return TILE_HUES[hash(name.trim().toLowerCase()) % TILE_HUES.length];
}

/** The tile's letter: the first letter or digit of the name, upper case; a dot when the name has neither. */
export function tileLetter(name: string): string {
  const match = /[\p{L}\p{N}]/u.exec(name);
  return match ? match[0].toUpperCase() : '•';
}

// ---- the summary line

export type SummaryLine =
  /** The attendant's summary or the last line of pi's last answer, or a count: plain text. */
  | { kind: 'summary' | 'last' | 'count'; text: string }
  /** The question a waiting thread asks, and the attendant's suggested answer when it has one. */
  | { kind: 'question'; question: string; answer: ThreadSuggestion | null };

const answerOf = (thread: ThreadSummary): ThreadSuggestion | null =>
  thread.state.suggestions.find((s) => s.kind === 'answer') ?? null;

/**
 * The second line of a row (detailed density): the first that exists of the attendant's summary, the question a waiting thread asks (with the suggested
 * answer as a second chip), the first line of pi's last answer, else the count of messages.
 */
export function summaryLine(translate: Translate, thread: ThreadSummary): SummaryLine {
  const state = thread.state;
  const summary = state.summary?.trim();
  if (summary) return { kind: 'summary', text: summary };
  if (state.activity === 'waiting')
    return {
      kind: 'question',
      question: state.question?.trim() || translate('threads.sidebar.needsAnAnswer'),
      answer: answerOf(thread),
    };
  const last = thread.lastLine?.trim();
  if (last) return { kind: 'last', text: last };
  const forks = forkMeta(translate, thread.forkCount ?? 0);
  const count =
    thread.messageCount === 0
      ? translate('threads.sidebar.noMessagesYet')
      : `${thread.messageCount} ${thread.messageCount === 1 ? translate('common.words.message') : translate('common.words.messages')}`;
  return { kind: 'count', text: [count, forks, thread.archived ? 'archived' : ''].filter(Boolean).join(', ') };
}

// ---- the status line

export type StatusTone = 'run' | 'wait' | 'err' | 'warn' | 'muted' | 'plain';
export type StatusKind = 'waiting' | 'error' | 'context-high' | 'running' | 'aborted' | 'context' | 'unread' | 'idle';

export interface StatusLine {
  kind: StatusKind;
  /** The state in words: "Running", "Waiting for you", "Done, unread", "Aborted", "The last run failed", "96 % context", "Idle". */
  label: string;
  tone: StatusTone;
}

const TONES: Record<StatusKind, StatusTone> = {
  waiting: 'wait',
  error: 'err',
  'context-high': 'err',
  running: 'run',
  aborted: 'muted',
  context: 'warn',
  unread: 'plain',
  idle: 'muted',
};

/**
 * The state of a row in words and colour: its strongest state (the order of `stateKinds`: a question, a failed run, a context over 90 %, a run, a stopped
 * run, a context over 70 %, news). The command-line mark is not a state of its own: it is a small mark next to this one (`hasCliMark`).
 */
export function statusLine(
  translate: Translate,
  thread: ThreadSummary,
  options: { looking?: boolean } = {},
  thresholds: ContextThresholds = DEFAULT_CONTEXT_THRESHOLDS,
): StatusLine {
  const kind = stateKinds(thread.state, options, thresholds).find((k): k is Exclude<StateKind, 'cli'> => k !== 'cli');
  if (!kind) return { kind: 'idle', label: translate('threads.sidebar.idle'), tone: TONES.idle };
  const label = {
    waiting: translate('threads.sidebar.waitingForYou'),
    error: translate('threads.sidebar.theLastRunFailed'),
    'context-high': translate('threads.sidebar.context', { value1: thread.state.context }),
    running: translate('threads.sidebar.running73989'),
    aborted: translate('threads.sidebar.aborted'),
    context: translate('threads.sidebar.context', { value1: thread.state.context }),
    unread: translate('threads.sidebar.doneUnread'),
  }[kind];
  return { kind, label, tone: TONES[kind] };
}

/** The thread was changed in the pi command line since it was looked at. */
export const hasCliMark = (thread: ThreadSummary, options: { looking?: boolean } = {}): boolean =>
  stateKinds(thread.state, options).includes('cli');

/** The context share that gets its own small gauge next to a state that is not the context itself: from 70 %. */
export function gaugeBesideStatus(
  thread: ThreadSummary,
  status: StatusLine,
  thresholds: ContextThresholds = DEFAULT_CONTEXT_THRESHOLDS,
): 'warn' | 'err' | undefined {
  if (status.kind === 'context' || status.kind === 'context-high') return undefined;
  return contextLevel(thread.state.context, thresholds);
}

// ---- the folded project

export interface CollapsedTag {
  kind: 'running' | 'waiting';
  /** "2 running", "1 waiting". */
  text: string;
}

/** The mini tags a folded project's band keeps: how many threads run and how many wait for the person; nothing for zero. */
export function collapsedTags(translate: Translate, counts: ProjectCounts): CollapsedTag[] {
  const tags: CollapsedTag[] = [];
  if (counts.running > 0)
    tags.push({ kind: 'running', text: translate('threads.sidebar.running', { value1: counts.running }) });
  if (counts.waiting > 0)
    tags.push({ kind: 'waiting', text: translate('threads.sidebar.waiting', { value1: counts.waiting }) });
  return tags;
}

// ---- Needs you

/** What a chip does when it is pressed: answer the thread's pending dialog, or open the thread. */
export type ChipAction =
  { type: 'dialog'; dialogId: string; payload: { confirmed: boolean } | { value: string } } | { type: 'open' };

export interface AnswerChip {
  key: string;
  label: string;
  /** The attendant's suggested answer: drawn as the primary chip, and marked accepted once it was used. */
  suggested: boolean;
  action: ChipAction;
}

/** More options than this and the strip shows the first ones and "Open": the full list is in the thread. */
export const MAX_OPTION_CHIPS = 3;

/**
 * The answers a "Needs you" item offers. A `confirm` dialog: Allow and Deny. A `select`: its options. An `input` or `editor` dialog, and a question in prose:
 * the attendant's suggested answer when there is one, and "Open" otherwise. The suggested answer comes first.
 */
export function answerChips(translate: Translate, thread: ThreadSummary): AnswerChip[] {
  const dialog = thread.state.dialog ?? null;
  const suggestion =
    thread.state.suggestions.find((s) => s.kind === 'answer' && (!dialog || s.target === dialog.id)) ?? null;
  const open: AnswerChip = {
    key: 'open',
    label: translate('threads.sidebar.open'),
    suggested: false,
    action: { type: 'open' },
  };
  const first = <T extends { suggested: boolean }>(items: T[]): T[] =>
    suggestion ? [...items.filter((i) => i.suggested), ...items.filter((i) => !i.suggested)] : items;

  if (dialog?.method === 'confirm') {
    const make = (label: 'Allow' | 'Deny'): AnswerChip => ({
      key: label,
      label: translate(label === 'Allow' ? 'shared.approval.allow' : 'shared.approval.deny'),
      suggested: suggestion?.text === label,
      action: { type: 'dialog', dialogId: dialog.id, payload: { confirmed: label === 'Allow' } },
    });
    return first([make('Allow'), make('Deny')]);
  }
  if (dialog?.method === 'select' && dialog.options?.length) {
    const options = dialog.options.map<AnswerChip>((label) => ({
      key: label,
      label,
      suggested: suggestion?.text === label,
      action: { type: 'dialog', dialogId: dialog.id, payload: { value: label } },
    }));
    const shown = first(options).slice(0, MAX_OPTION_CHIPS);
    return options.length > shown.length ? [...shown, open] : shown;
  }
  if (suggestion) {
    const answer: AnswerChip = dialog
      ? {
          key: 'suggested',
          label: suggestion.text,
          suggested: true,
          action: { type: 'dialog', dialogId: dialog.id, payload: { value: suggestion.text } },
        }
      : { key: 'suggested', label: suggestion.text, suggested: true, action: { type: 'open' } };
    return [answer, open];
  }
  return [open];
}

export interface NeedsItem {
  thread: ThreadSummary;
  project: { cwd: string; name: string };
  question: string;
  chips: AnswerChip[];
}

export interface NeedsYou {
  /** Every waiting thread, newest first. */
  items: NeedsItem[];
  /** All the threads that wait. */
  total: number;
}

/**
 * The threads waiting for the person across the projects the sidebar lists, newest first (the session file changed last).
 * An archived thread is not asked about.
 */
export function needsYou(
  translate: Translate,
  projects: readonly { workspace: Pick<Workspace, 'cwd' | 'name'>; threads: readonly ThreadSummary[] }[],
): NeedsYou {
  const all: NeedsItem[] = [];
  for (const project of projects) {
    for (const thread of project.threads) {
      if (thread.state.activity !== 'waiting' || thread.archived) continue;
      all.push({
        thread,
        project: { cwd: project.workspace.cwd, name: project.workspace.name },
        question: thread.state.question?.trim() || translate('threads.sidebar.needsAnAnswer'),
        chips: answerChips(translate, thread),
      });
    }
  }
  all.sort((a, b) => b.thread.updatedAt - a.thread.updatedAt);
  return { items: all, total: all.length };
}
