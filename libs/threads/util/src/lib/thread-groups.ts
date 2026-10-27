import type { Translate } from '@pi-kit/i18n';
import type { ThreadSummary } from '@pi-kit/protocol';
import { forkMeta } from './fork-meta';

export interface ThreadGroup {
  label: string;
  threads: ThreadSummary[];
}

/** What a row shows when the thread has no name: the first message, else a placeholder. */
export function threadLabel(translate: Translate, thread: ThreadSummary): string {
  return thread.title ?? (thread.preview?.trim().slice(0, 80) || translate('threads.threadGroups.newThread'));
}

export function matches(thread: ThreadSummary, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [thread.title, thread.preview, thread.state.summary].some((text) => text?.toLowerCase().includes(q));
}

const startOfDay = (ms: number): number => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** Pinned first, then by how recently the session file changed; `now` is injectable for tests. */
export function groupThreads(translate: Translate, threads: ThreadSummary[], now = Date.now()): ThreadGroup[] {
  const today = startOfDay(now);
  const day = 86_400_000;
  const buckets: ThreadGroup[] = [
    { label: translate('threads.threadGroups.pinned'), threads: [] },
    { label: translate('threads.threadGroups.today'), threads: [] },
    { label: translate('threads.threadGroups.yesterday'), threads: [] },
    { label: translate('threads.threadGroups.previous7Days'), threads: [] },
    { label: translate('threads.threadGroups.older'), threads: [] },
  ];
  for (const thread of threads) {
    const index = thread.pinned
      ? 0
      : thread.updatedAt >= today
        ? 1
        : thread.updatedAt >= today - day
          ? 2
          : thread.updatedAt >= today - 7 * day
            ? 3
            : 4;
    buckets[index].threads.push(thread);
  }
  return buckets.filter((b) => b.threads.length > 0);
}

/**
 * The 12px line under a row title: the attendant's summary when it has one, else a short fact about the thread. A waiting thread's
 * line is the pill the template draws ("Waiting:" and the question), so this is only what follows it.
 */
export function threadMeta(translate: Translate, thread: ThreadSummary): string {
  const state = thread.state;
  if (state.summary) return state.summary;
  const parts: string[] = [];
  if (state.activity === 'running') parts.push(translate('threads.threadGroups.running'));
  else if (state.lastRun === 'aborted') parts.push(translate('threads.threadGroups.aborted'));
  else if (state.lastRun === 'error') parts.push(translate('threads.threadGroups.theLastRunFailed'));
  else if (thread.messageCount === 0) parts.push(translate('threads.threadGroups.noMessagesYet'));
  else
    parts.push(
      `${thread.messageCount} ${thread.messageCount === 1 ? translate('common.words.message') : translate('common.words.messages')}`,
    );
  const forks = forkMeta(translate, thread.forkCount);
  if (forks) parts.push(forks);
  if (thread.archived) parts.push('archived');
  return parts.join(', ');
}

/** More threads than this and a project's list gets section headers (Pinned, Today, ...); with fewer they are noise. */
export const SECTION_HEADERS_ABOVE = 8;

/** A project's threads in the order the sidebar lists them: pinned first, then the most recently changed. */
export function sortThreads(threads: readonly ThreadSummary[]): ThreadSummary[] {
  return [...threads].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt);
}
