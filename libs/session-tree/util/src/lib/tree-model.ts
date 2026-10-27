import type { Translate } from '@pi-kit/i18n';
import type { SessionTree } from '@pi-kit/protocol';

/**
 * What words the session graph around its rows: the panel header's summary and the breadcrumb strip. The rows themselves are laid out by `layoutGraph`.
 */

/** "11 turns, 2 forks", as the panel header says it. */
export function treeSummary(translate: Translate, tree: Pick<SessionTree, 'turns' | 'forks'>): string {
  const turns = translate(`common.turns.${tree.turns === 1 ? 'one' : 'other'}`, { count: tree.turns });
  return tree.forks > 0
    ? `${turns}, ${translate(`common.forks.${tree.forks === 1 ? 'one' : 'other'}`, { count: tree.forks })}`
    : turns;
}

/** Fork crumbs the strip shows before it folds the earlier ones into a count. */
const MAX_FORK_CRUMBS = 2;

export interface Crumb {
  label: string;
  tone: 'info' | 'default';
  title?: string;
}

/**
 * The breadcrumb strip above the transcript: "main", one "fork at turn N" per fork point on the active path
 * (the turn where the branches part), and "turn N, current". `note` is the strip's trailing text.
 */
export function pathCrumbs(translate: Translate, tree: SessionTree | undefined): { crumbs: Crumb[]; note: string } {
  if (!tree) return { crumbs: [{ label: translate('session-tree.treeModel.main'), tone: 'default' }], note: '' };
  const active = tree.rows.filter((r) => r.onActivePath && r.kind !== 'ghost');
  const crumbs: Crumb[] = [{ label: translate('session-tree.treeModel.main'), tone: 'default' }];
  let sinceFork = 0;
  let forkCount = 0;
  for (let i = 0; i < active.length; i++) {
    const row = active[i];
    if (row.kind === 'turn') sinceFork += 1;
    // The leaf's own children are branches ahead of the current turn, not forks on the way to it.
    if (row.childCount > 1 && !row.isLeaf) {
      const next = active.slice(i + 1).find((r) => r.kind === 'turn');
      crumbs.push({
        label: next
          ? translate('session-tree.treeModel.forkAtTurn', { value1: next.turn })
          : translate('session-tree.treeModel.forkHere'),
        tone: 'info',
        title: translate('session-tree.treeModel.branchesContinueAfter', {
          value1: row.childCount,
          value2: row.preview,
        }),
      });
      forkCount += 1;
      sinceFork = 0;
    }
  }
  // Many forks do not fit a 28px strip: the latest ones stay, the rest is counted.
  const forkCrumbs = crumbs.slice(1);
  if (forkCrumbs.length > MAX_FORK_CRUMBS) {
    const hidden = forkCrumbs.length - MAX_FORK_CRUMBS;
    crumbs.splice(1, hidden, {
      label: translate('session-tree.treeModel.earlier', {
        value1: hidden,
        value2: hidden === 1 ? translate('session-tree.treeModel.fork') : translate('session-tree.treeModel.forks'),
      }),
      tone: 'default',
    });
  }
  const leaf = tree.rows.find((r) => r.isLeaf);
  const current =
    leaf?.kind === 'turn' && leaf.turn
      ? translate('session-tree.treeModel.turnCurrent', { value1: leaf.turn })
      : translate('session-tree.treeModel.start');
  crumbs.push({ label: current, tone: 'default' });
  const note =
    forkCount > 0
      ? translate('session-tree.treeModel.sinceTheLastFork', {
          value1: sinceFork,
          value2:
            sinceFork === 1 ? translate('session-tree.treeModel.turn') : translate('session-tree.treeModel.turns'),
        })
      : '';
  return { crumbs, note };
}

/** The sticky foot's path: "main › fork at turn 6", the nearest fork on the way to the current turn (the strip above the transcript lists them all). */
export function footPath(translate: Translate, tree: SessionTree | undefined): string {
  const { crumbs } = pathCrumbs(translate, tree);
  const forks = crumbs.slice(1, -1);
  return forks.length > 0 ? `${crumbs[0].label} › ${forks[forks.length - 1].label}` : crumbs[0].label;
}
