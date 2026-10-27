import type { AgentQuestionDialog, PiDialogRequest, ThreadDraftBadge, ThreadOutcomeBadge, ThreadState, ThreadSuggestion } from '@pi-kit/protocol';

/** What the state of a thread is computed. Pure, so it can be tested without a database or a pi session. */
export interface StateFacts {
  /** The lock row of the thread's latest run says `running`. */
  running: boolean;
  /** Dialogs an extension is waiting on (pi is blocked), oldest first. */
  dialogs: readonly { id: string; request: PiDialogRequest }[];
  /** The last answer ended in this question and nothing is running: pi waits for the user without a dialog. */
  prose?: string | null;
  /** The latest run's outcome and when it ended. */
  lastRun: { runId?: string; status: 'running' | 'finished' | 'error' | 'aborted'; endedAt: number | null } | undefined;
  contextPct: number | null;
  /** When the user last looked at the thread; null for a thread nobody has opened since the pi command line made it. */
  seenAt: number | null;
  origin: 'app' | 'cli';
  /** The session file's mtime now, and the mtime the app's replay log last matched. */
  fileMtime: number | null;
  logMtime: number | null;
  summary: string | null;
  suggestions: readonly ThreadSuggestion[];
  /** How the thread ended: the outcome store's row as a badge, or null. */
  outcome?: ThreadOutcomeBadge | null;
  /** The skill drafted from the thread, or null. */
  draft?: ThreadDraftBadge | null;
  /** Questions of the thread's background agents the user has to answer: the thread waits for them as for pi's dialogs, after those. */
  agentQuestions?: readonly AgentQuestionDialog[];
}

/** How much newer than the log a file has to be before it counts as changed outside pi-kit (a run's own writes land within this). */
export const CLI_SLACK_MS = 1500;

export function computeThreadState(f: StateFacts): ThreadState {
  const prose = f.prose?.trim() || null;
  const dialogs = [...f.dialogs, ...(f.agentQuestions ?? [])];
  const waiting = dialogs.length > 0 || (!f.running && prose !== null);
  const activity = waiting ? 'waiting' : f.running ? 'running' : 'idle';
  const outcome = f.lastRun && f.lastRun.status !== 'running' ? f.lastRun.status : null;
  const endedAt = f.lastRun?.endedAt ?? null;
  const unseen = activity === 'idle' && outcome !== null && endedAt !== null && endedAt > (f.seenAt ?? 0);
  const unread = unseen && outcome === 'finished';
  // A file that changed after the user's last look and that the replay log does not account for was written by someone else; looking at the thread clears it.
  const changedOutside =
    (f.origin === 'cli' && f.seenAt === null) ||
    (f.logMtime !== null && f.fileMtime !== null && f.fileMtime > f.logMtime + CLI_SLACK_MS && f.fileMtime > (f.seenAt ?? 0));
  return {
    activity,
    question: dialogs.length > 0 ? questionHead(dialogs[0].request) : prose !== null ? textHead(prose) : null,
    dialog: dialogs.length > 0 ? dialogHead(dialogs[0]) : null,
    context: f.contextPct,
    lastRun: outcome,
    unread,
    unseen,
    cli: activity === 'idle' && !unread && changedOutside,
    summary: f.summary,
    suggestions: [...f.suggestions],
    outcome: f.outcome ?? null,
    draft: f.draft ?? null,
    ...(f.agentQuestions?.length ? { agentQuestions: [...f.agentQuestions] } : {}),
    ...(f.running && f.lastRun?.runId ? { run: f.lastRun.runId } : {}),
  };
}

/** What the sidebar's chips need of the first pending dialog: its id, its kind and a select's options. */
export function dialogHead(dialog: { id: string; request: PiDialogRequest }): NonNullable<ThreadState['dialog']> {
  const { method, options } = dialog.request;
  return { id: dialog.id, method, ...(method === 'select' && options?.length ? { options: [...options] } : {}) };
}

/** The first words of a pending question, for the badge: the dialog's title (else its message), at most `words` words and `chars` characters. */
export function questionHead(request: PiDialogRequest, words = 8, chars = 60): string {
  return textHead(request.title.trim() || request.message?.trim() || 'Needs an answer', words, chars);
}

/** The first words of a text, for a badge. */
export function textHead(raw: string, words = 8, chars = 60): string {
  const text = raw.replace(/\s+/g, ' ').trim();
  const parts = text.split(' ');
  let head = parts.slice(0, words).join(' ');
  let cut = parts.length > words;
  if (head.length > chars) {
    head = head.slice(0, chars).replace(/\s+\S*$/, '');
    cut = true;
  }
  return cut ? `${head}…` : head;
}
