import type { Translate } from '@pi-kit/i18n';
import type { OutcomeKind, ThreadOutcomeBadge } from '@pi-kit/protocol';

/** What the outcome badge says: pure, so the tooltip and the menu texts are tested without a component. */

/** A commit as people write it: the first seven characters. */
export const shortHead = (head: string): string => head.slice(0, 7);

/** "just now", "12 min ago", "2 h ago", "3 d ago", then the date. */
export function agoText(translate: Translate, at: number, now = Date.now()): string {
  const diff = Math.max(0, now - at);
  if (diff < 60_000) return translate('threads.outcome.justNow');
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return translate('threads.outcome.minAgo', { value1: minutes });
  const hours = Math.floor(diff / 3_600_000);
  if (hours < 24) return translate('threads.outcome.hAgo', { value1: hours });
  const days = Math.floor(diff / 86_400_000);
  if (days < 30) return translate('threads.outcome.dAgo', { value1: days });
  const date = new Date(at);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return translate('threads.outcome.on', {
    value1: date.toLocaleDateString(
      translate('common.locale'),
      sameYear ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' },
    ),
  });
}

/** The word for a kind, for the review header and the menu. */
export const outcomeLabels = (translate: Translate): Record<OutcomeKind, string> => ({
  merged: translate('threads.outcome.merged'),
  committed: translate('threads.outcome.committed'),
  pr: translate('threads.outcome.pullRequest'),
});

/**
 * The badge's tooltip: "Merged into main as a1b2c3d, 2 h ago", "Committed as a1b2c3d, 12 min ago", "Pull request opened for a1b2c3d, just now".
 * `base` is the branch a worktree thread was cut from and merged into; a thread outside a worktree has none and the sentence says "the base branch".
 */
export function outcomeTitle(
  translate: Translate,
  outcome: ThreadOutcomeBadge,
  base: string | null | undefined,
  now = Date.now(),
): string {
  const when = agoText(translate, outcome.at, now);
  const head = shortHead(outcome.head);
  const first =
    outcome.kind === 'merged'
      ? translate('threads.outcome.mergedIntoAs', {
          value1: base || translate('threads.outcome.theBaseBranch'),
          value2: head,
          value3: when,
        })
      : outcome.kind === 'pr'
        ? translate('threads.outcome.pullRequestOpenedFor', { value1: head, value2: when })
        : translate('threads.outcome.committedAs28db6', { value1: head, value2: when });
  const second = scoreLine(translate, outcome);
  return second ? `${first}\n${second}` : first;
}

/** The badge's second line: "62 % steered: 14 of 23 hunks, 9 by the first prompt, 3 by review comments, 2 by hand"; empty without a score. */
export function scoreLine(translate: Translate, outcome: ThreadOutcomeBadge): string {
  const score = outcome.score;
  if (!score?.line) return '';
  return score.stale
    ? translate('threads.outcome.theOutcomeHasChangedSinceScoreIt', { value1: score.line })
    : score.line;
}

/** The review header's words for the Outcome source: "merged as a1b2c3d". */
export function outcomeSummary(translate: Translate, outcome: ThreadOutcomeBadge): string {
  switch (outcome.kind) {
    case 'merged':
      return translate('threads.outcome.mergedAs', { value1: shortHead(outcome.head) });
    case 'pr':
      return translate('threads.outcome.aPullRequestAt', { value1: shortHead(outcome.head) });
    case 'committed':
      return translate('threads.outcome.committedAs', { value1: shortHead(outcome.head) });
  }
}
