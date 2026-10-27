import type { Translate } from '@pi-kit/i18n';
import type { ThreadState, ThreadSummary } from '@pi-kit/protocol';
import { DEFAULT_CONTEXT_THRESHOLDS, type ContextThresholds } from '@pi-kit/ui';

/**
 * What the sidebar draws for a thread's state. The backend computes the facts (`ThreadState`); this turns them into
 * the badges, strongest first, and picks what a collapsed project shows. Pure, so the ranking is tested without a component.
 *
 * Order: a question that needs you, a failed run, a context nearly full, a run in progress, a stopped run, a context filling up, a result you
 * have not seen, a session changed in the pi command line.
 */
export type StateKind = 'waiting' | 'error' | 'context-high' | 'running' | 'aborted' | 'context' | 'unread' | 'cli';

export const STATE_ORDER: readonly StateKind[] = [
  'waiting',
  'error',
  'context-high',
  'running',
  'aborted',
  'context',
  'unread',
  'cli',
];

/** Context share (whole percent) where the ring turns warning and error (meter). */
export const CONTEXT_WARN = DEFAULT_CONTEXT_THRESHOLDS.warning;
export const CONTEXT_ERROR = DEFAULT_CONTEXT_THRESHOLDS.error;

export function contextLevel(
  pct: number | null,
  thresholds: ContextThresholds = DEFAULT_CONTEXT_THRESHOLDS,
): 'warn' | 'err' | undefined {
  if (pct === null) return undefined;
  return pct >= thresholds.error ? 'err' : pct >= thresholds.warning ? 'warn' : undefined;
}

/**
 * The badges of one thread, strongest first. `looking` is the thread the user has open: what it finished or changed is no news to them, so
 * unread and cli do not show on it, and a stopped or failed run of it shows on its row but does not light up its project.
 */
export function stateKinds(
  state: ThreadState,
  options: { looking?: boolean; group?: boolean } = {},
  thresholds: ContextThresholds = DEFAULT_CONTEXT_THRESHOLDS,
): StateKind[] {
  const kinds: StateKind[] = [];
  if (state.activity === 'waiting') kinds.push('waiting');
  // A project is lit by a failed or stopped run only until the user has looked; on the thread's own row it stays until the next run.
  const quiet = options.group === true && (options.looking === true || !state.unseen);
  if (state.lastRun === 'error' && !quiet) kinds.push('error');
  const level = contextLevel(state.context, thresholds);
  if (level === 'err') kinds.push('context-high');
  if (state.activity === 'running') kinds.push('running');
  if (state.lastRun === 'aborted' && !quiet) kinds.push('aborted');
  if (level === 'warn') kinds.push('context');
  if (state.unread && !options.looking) kinds.push('unread');
  if (state.cli && !options.looking) kinds.push('cli');
  return kinds;
}

/** The strongest badge among a project's threads, or undefined when none has one. */
export function strongestKind(
  threads: readonly ThreadSummary[],
  selectedId?: string,
  thresholds: ContextThresholds = DEFAULT_CONTEXT_THRESHOLDS,
): StateKind | undefined {
  let best: StateKind | undefined;
  for (const thread of threads) {
    const first = stateKinds(thread.state, { looking: thread.id === selectedId, group: true }, thresholds)[0];
    if (first && (!best || STATE_ORDER.indexOf(first) < STATE_ORDER.indexOf(best))) best = first;
  }
  return best;
}

export interface ProjectCounts {
  running: number;
  waiting: number;
}

export function countStates(threads: readonly ThreadSummary[]): ProjectCounts {
  let running = 0;
  let waiting = 0;
  for (const thread of threads) {
    if (thread.state.activity === 'running') running += 1;
    else if (thread.state.activity === 'waiting') waiting += 1;
  }
  return { running, waiting };
}

/** The highest context share among a project's threads, for the collapsed gauge; undefined below the warning step. */
export function worstContext(
  threads: readonly ThreadSummary[],
  thresholds: ContextThresholds = DEFAULT_CONTEXT_THRESHOLDS,
): number | undefined {
  let worst: number | undefined;
  for (const thread of threads) {
    const pct = thread.state.context;
    if (pct !== null && pct >= thresholds.warning && (worst === undefined || pct > worst)) worst = pct;
  }
  return worst;
}

const startOfDay = (ms: number): number => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** A short relative time for a row: "now", "12m", "2h", "Tue" within a week, "3 Oct" after that (with the year when it is another one). */
export function shortTime(translate: Translate, at: number, now = Date.now()): string {
  const diff = Math.max(0, now - at);
  if (diff < 60_000) return translate('common.now');
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  const date = new Date(at);
  if (startOfDay(now) - startOfDay(at) < 7 * 86_400_000)
    return date.toLocaleDateString(translate('common.locale'), { weekday: 'short' });
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(
    translate('common.locale'),
    sameYear ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' },
  );
}
