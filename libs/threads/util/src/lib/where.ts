import type { Translate } from '@pi-kit/i18n';
import type { ProjectGit, StartMode, ThreadPlacement, ThreadSummary, WorktreeSettings } from '@pi-kit/protocol';
import { threadLabel } from './thread-groups';
import { shortTime } from './thread-state';

/**
 * The Where row of the new-thread page as data: what the person chose for the thread that has no message yet, the entries of its
 * menus, the sentences it shows, and the request that applies it at the first Send. Pure functions; `NewThreadStore` keeps the plans, the row component draws them.
 */

export type WhereMode = 'local' | 'worktree';

export interface WherePlan {
  /** `ask`: the project wants the choice made each time; nothing is selected and Send waits. */
  mode: WhereMode | 'ask';
  /** Local: switch to this branch first (null: stay on the checked-out one). */
  localBranch: string | null;
  /** Local: make this branch from the checked-out one ("New branch from main…"). */
  newBranch: string | null;
  /** Local: a setup script to type into the folder's terminal first (null: none). */
  localSetup: string | null;
  /** Worktree: the base (null: the project's, else the checked-out branch). `origin/main` is fetched first. */
  from: string | null;
  /** Worktree: carry the folder's uncommitted changes. */
  carry: boolean;
  /** Worktree: the branch is named `<prefix><name>` from the first message, left off (detached), or typed. */
  naming: 'named' | 'detached' | 'typed';
  typed: string;
  /** Worktree: a setup script id; `undefined` is the project's first (default), `null` none. */
  setup: string | null | undefined;
  /** Keep this choice as the project's default when the thread starts. */
  remember: boolean;
}

/** The plan a new thread starts from: the project's defaults (Start, Carry, Branch). A folder that is not a repository is Local only. */
export function initialPlan(settings: WorktreeSettings | undefined, git: ProjectGit | undefined): WherePlan {
  const repo = git?.git ?? settings?.git ?? false;
  const start: StartMode = !repo ? 'local' : (settings?.start ?? 'local');
  return {
    mode: start,
    localBranch: null,
    newBranch: null,
    localSetup: null,
    from: settings?.base ?? null,
    carry: settings?.carryChanges === 'always' && (git?.dirty ?? 0) > 0,
    naming: settings?.branchMode === 'detached' ? 'detached' : 'named',
    typed: '',
    setup: undefined,
    remember: false,
  };
}

/** The base a worktree is cut from, as the plan or the project says; the checked-out branch otherwise. */
export const baseOf = (plan: WherePlan, git: ProjectGit | undefined): string =>
  plan.from ?? git?.branch ?? git?.head ?? 'HEAD';

/** The branch a Local thread will be on when it starts. */
export const localBranchOf = (plan: WherePlan, git: ProjectGit | undefined): string =>
  plan.newBranch ?? plan.localBranch ?? git?.branch ?? git?.head ?? 'HEAD';

/** A name the first message gives the worktree: its first line, without a command prefix, cut at 80 characters. */
export function nameFromMessage(text: string): string | undefined {
  const line =
    text
      .trim()
      .split('\n')[0]
      ?.replace(/^[/!]+\S*\s*/, '')
      .trim() ?? '';
  return line ? line.slice(0, 80) : undefined;
}

/**
 * The request that applies the plan to the thread, or `undefined` when there is nothing to apply (Local, on the branch that is checked out, no script). `ask` has no
 * request: Send waits for a choice.
 */
export function placementOf(
  plan: WherePlan,
  git: ProjectGit | undefined,
  message: string,
): ThreadPlacement | undefined {
  if (plan.mode === 'ask' || !git?.git) return undefined;
  if (plan.mode === 'local') {
    const switchTo = plan.newBranch ?? (plan.localBranch && plan.localBranch !== git.branch ? plan.localBranch : null);
    if (!switchTo && !plan.localSetup) return undefined;
    return {
      local: {
        ...(switchTo ? { branch: switchTo } : {}),
        ...(plan.newBranch ? { create: true } : {}),
        ...(plan.localSetup ? { setup: plan.localSetup } : {}),
      },
    };
  }
  const name = nameFromMessage(message);
  return {
    worktree: {
      ...(plan.from ? { base: plan.from } : {}),
      // The checkbox exists only while the folder has changes; a project rule of "never" is the server's to keep.
      ...(git.dirty > 0 ? { carryChanges: plan.carry } : {}),
      ...(plan.naming === 'detached'
        ? { branch: null }
        : plan.naming === 'typed' && plan.typed.trim()
          ? { branch: plan.typed.trim() }
          : {}),
      ...(plan.setup !== undefined ? { setup: plan.setup } : {}),
      ...(name ? { name } : {}),
    },
  };
}

/** Send has to wait: the project asks each time and nothing was chosen, or a typed branch is empty. */
export function sendBlocker(translate: Translate, plan: WherePlan): string | undefined {
  if (plan.mode === 'ask') return translate('threads.where.chooseWhereThisThreadRunsLocalOr');
  if (plan.mode === 'worktree' && plan.naming === 'typed' && !plan.typed.trim())
    return translate('threads.where.typeABranchNameOrLetIt');
  return undefined;
}

// ---- the menus

export interface BranchOption {
  name: string;
  current: boolean;
  /** Why it cannot be chosen; the entry shows it in place of the usual line. */
  disabled: string | undefined;
  /** The line under the name. */
  sub: string;
}

const files = (n: number): string => `${n} ${n === 1 ? 'file' : 'files'}`;

/** The entries of the Local branch menu: the checked-out branch, the ones that can be switched to, and the ones that cannot with the reason. */
export function localBranchOptions(translate: Translate, git: ProjectGit, allowSwitch: boolean): BranchOption[] {
  return git.branches.map((b): BranchOption => {
    if (b.current)
      return {
        name: b.name,
        current: true,
        disabled: undefined,
        sub:
          git.dirty > 0
            ? translate('threads.where.checkedOutNotCommittedStay', { value1: files(git.dirty) })
            : translate('threads.where.checkedOut'),
      };
    if (b.heldBy) {
      const reason = b.heldBy.thread
        ? translate('threads.where.heldByTheWorktreeOf', { value1: b.heldBy.thread })
        : translate('threads.where.heldByTheWorktreeAt', { value1: b.heldBy.path });
      return { name: b.name, current: false, disabled: reason, sub: reason };
    }
    if (!allowSwitch)
      return {
        name: b.name,
        current: false,
        disabled: translate('threads.where.switchingBranchesIsTurnedOffForThis'),
        sub: translate('threads.where.switchingBranchesIsTurnedOffForThis'),
      };
    if (git.dirty > 0) {
      const reason = translate('threads.where.stashOrCommitTheFirst', { value1: files(git.dirty) });
      return {
        name: b.name,
        current: false,
        disabled: reason,
        sub: translate('threads.where.switchesTheCheckout', { value1: reason }),
      };
    }
    return {
      name: b.name,
      current: false,
      disabled: undefined,
      sub: translate('threads.where.switchesTheCheckout47d9c'),
    };
  });
}

/** The bases a worktree can be cut from: every local branch, then the remote ones with "fetch first". */
export function baseOptions(translate: Translate, git: ProjectGit): { value: string; label: string; sub: string }[] {
  const local = git.branches.map((b) => ({
    value: b.name,
    label: b.name,
    sub: b.current ? translate('threads.where.checkedOutNow') : '',
  }));
  const remote = git.remoteBranches
    .filter((r) => r.startsWith('origin/'))
    .map((r) => ({
      value: r,
      label: translate('threads.where.fetchFirst', { value1: r }),
      sub: translate('threads.where.theRemoteSBranch'),
    }));
  return [...local, ...remote];
}

// ---- the sentences

/** A path with the home folder written as `~`. */
export function tildePath(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, '~').replace(/^[A-Za-z]:\\Users\\[^\\]+/, '~');
}

/** The folder name of a project inside the worktree root (`Reporting API` becomes `reporting-api`). */
export const repoSlug = (cwd: string): string =>
  (cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'project';

export interface WhereWords {
  /** "in ~/Development/pi-kit as it is" / "a fresh checkout under ~/.pi-kit/worktrees/pi-kit/" */
  sentence: string;
  /** The line under the header: "runs in this folder on main" / "starts in a new worktree from main". */
  crumb: string;
  /** Under the well: what Send will do. */
  hint: string;
}

/** What the row, the crumb line and the hint under the well say about the plan. */
export function whereWords(
  translate: Translate,
  plan: WherePlan,
  git: ProjectGit | undefined,
  settings: WorktreeSettings | undefined,
  cwd: string,
): WhereWords {
  const folder = tildePath(cwd);
  const scripts = settings?.setupScripts ?? [];
  if (plan.mode === 'ask') {
    return {
      sentence: translate('threads.where.chooseWhereThisThreadRuns'),
      crumb: translate('threads.where.chooseWhereItRuns'),
      hint: translate('threads.where.chooseLocalOrWorktreeAboveThenSend'),
    };
  }
  if (plan.mode === 'local') {
    const branch = localBranchOf(plan, git);
    const script = scripts.find((s) => s.id === plan.localSetup);
    const to = plan.newBranch
      ? translate('threads.where.sendingMakesTheBranchFrom', {
          value1: plan.newBranch,
          value2: git?.branch ?? translate('threads.where.here'),
        })
      : plan.localBranch && plan.localBranch !== git?.branch
        ? translate('threads.where.sendingSwitchesTo', { value1: folder, value2: plan.localBranch })
        : '';
    const start = to
      ? translate('threads.where.thenStartsTheThreadInTheFolder', {
          value1: to,
          value2: script ? translate('threads.where.runs', { value1: script.command }) : '',
        })
      : translate('threads.where.sendingStartsTheThreadInOn', {
          value1: folder,
          value2: branch,
          value3: script ? translate('threads.where.after', { value1: script.command }) : '',
        });
    return {
      sentence: translate('threads.where.inAsItIs', { value1: folder }),
      crumb: plan.newBranch
        ? translate('threads.where.runsInThisFolderOnANew', { value1: plan.newBranch })
        : plan.localBranch && plan.localBranch !== git?.branch
          ? translate('threads.where.switchesToRunsInThisFolder', { value1: plan.localBranch })
          : translate('threads.where.runsInThisFolderOn', { value1: branch }),
      hint: start,
    };
  }
  const root = tildePath(settings?.root ?? settings?.defaultRoot ?? '~/.pi-kit/worktrees');
  const base = baseOf(plan, git);
  const script =
    plan.setup === null
      ? undefined
      : (scripts.find((s) => s.id === plan.setup) ?? (plan.setup === undefined ? scripts[0] : undefined));
  const prefix = settings?.branchPrefix ?? 'pi-kit/';
  const branch =
    plan.naming === 'detached'
      ? translate('threads.where.aDetachedCheckout')
      : plan.naming === 'typed'
        ? translate('threads.where.theBranch', { value1: plan.typed.trim() || '…' })
        : `the worktree ${prefix}<name>`;
  const carried =
    plan.carry && (git?.dirty ?? 0) > 0
      ? translate('threads.where.carriesOfChanges', { value1: files(git?.dirty ?? 0) })
      : '';
  return {
    sentence: translate('threads.where.aFreshCheckoutUnder', {
      value1: root.replace(/\/$/, ''),
      value2: repoSlug(cwd),
    }),
    crumb: translate('threads.where.startsInANewWorktreeFrom', { value1: base }),
    hint: translate('threads.where.sendingMakesFromThenStartsTheThread', {
      value1: branch,
      value2: base,
      value3: carried,
      value4: script ? translate('threads.where.runs4ea55', { value1: script.command }) : '',
    }),
  };
}

// ---- the page

export interface RecentThing {
  kind: 'thread' | 'draft';
  /** The thread to continue. */
  id?: string;
  title: string;
  sub: string;
}

/**
 * The up to two things the new-thread page offers: the last thread of the project to continue, and an unsent draft if the composer keeps one. A thread that has no
 * message, an archived one and the open thread itself are not offered.
 */
export function recentThings(
  translate: Translate,
  threads: readonly ThreadSummary[],
  cwd: string,
  openId: string | undefined,
  draft: string,
  now = Date.now(),
): RecentThing[] {
  const things: RecentThing[] = [];
  const last = threads
    .filter((t) => t.cwd === cwd && t.id !== openId && !t.archived && t.messageCount > 0)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  if (last)
    things.push({
      kind: 'thread',
      id: last.id,
      title: translate('threads.where.continue', { value1: threadLabel(translate, last) }),
      sub: `${last.worktree?.exists ? translate('threads.where.worktree') : ''}${shortTime(translate, last.updatedAt, now)}`,
    });
  const text = draft.trim().split('\n')[0] ?? '';
  if (text)
    things.push({
      kind: 'draft',
      title: text.length > 80 ? `${text.slice(0, 79)}…` : text,
      sub: translate('threads.where.aDraftYouDidNotSend'),
    });
  return things;
}
