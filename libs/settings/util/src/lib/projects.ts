import type { Translate } from '@pi-kit/i18n';
import type {
  PatchWorktreeSettings,
  ProjectGit,
  RemoveFolder,
  SetupScript,
  StartMode,
  ThreadSummary,
  TrustState,
  Workspace,
  WorktreeSettings,
  WorktreeStatus,
} from '@pi-kit/protocol';

/**
 * What Settings › Projects lists and what a project's page edits, with no Angular: the rows of the list (trust chip, branch chip, path, counts,
 * where a new thread starts, the setup script), the open worktrees of a project, the options of the "Cut from" select, the editor of a setup script, and the "dirty save" that
 * sends only the fields that changed. The components render these and forward the clicks.
 */

export type Tone = 'ok' | 'warn' | 'err' | 'off' | 'info';

// ---- the list

/** The trust chip of a project: trusted, not trusted, waiting for an answer, or nothing to trust (a folder with no project resources of its own). */
export function trustChip(
  translate: Translate,
  state: TrustState | undefined,
): { text: string; tone: Tone } | undefined {
  if (!state) return undefined;
  if (!state.hasResources) return { text: translate('settings.projects.nothingToTrust'), tone: 'off' };
  if (state.status === 'trusted') return { text: translate('settings.projects.trusted'), tone: 'ok' };
  if (state.status === 'untrusted') return { text: translate('settings.projects.notTrusted'), tone: 'err' };
  return { text: translate('settings.projects.waiting'), tone: 'warn' };
}

/** Where the answer for a folder came from, in words. */
export function trustSourceText(translate: Translate, source: TrustState['source']): string {
  return {
    none: translate('settings.projects.noAnswerYet'),
    override: translate('settings.projects.trustedByTheTestFlag'),
    extension: translate('settings.projects.decidedByAnExtension'),
    saved: translate('settings.projects.savedAnswer'),
    session: translate('settings.projects.forThisRunOnly'),
    default: translate('settings.projects.defaultForNewFolders'),
  }[source];
}

/** “2 skills, 1 extension, 1 MCP server” for the resources a folder would load. */
export function resourceSummary(translate: Translate, state: Pick<TrustState, 'resources'>): string {
  const counts = new Map<string, number>();
  for (const resource of state.resources)
    counts.set(
      resource.kind,
      (counts.get(resource.kind) ?? 0) + (resource.kind === 'mcp' ? (resource.servers ?? 1) : 1),
    );
  return [...counts].map(([kind, n]) => plural(translate, n, kind)).join(', ');
}

export const startLabels = (translate: Translate): Record<StartMode, string> => ({
  local: translate('settings.projects.startsInTheFolder'),
  worktree: translate('settings.projects.startsInAWorktree'),
  ask: translate('settings.projects.asksWhereToStart'),
});

/** A path with the home folder written as `~`. */
export function tildePath(path: string): string {
  return path.replace(/^\/Users\/[^/]+|^\/home\/[^/]+|^[A-Za-z]:\\Users\\[^\\]+/, '~');
}

export const plural = (translate: Translate, n: number, noun: string): string =>
  translate(`common.counts.${noun}.${n === 1 ? 'one' : 'other'}`, { count: n });

export interface ProjectRow {
  cwd: string;
  name: string;
  path: string;
  trust?: { text: string; tone: Tone };
  /** The checked-out branch, or `null` for a folder that is not a git repository (then `git` is false and the row says so). */
  branch: string | null;
  git: boolean;
  hidden: boolean;
  /** Detail-line pieces after the path, in order: "31 threads", "2 worktrees", "starts in a worktree", "setup pnpm", "4 project resources not loaded". */
  facts: string[];
}

/** The open worktrees of each project: threads whose worktree folder still exists, counted by their project's folder. */
export function worktreeCounts(threads: readonly Pick<ThreadSummary, 'cwd' | 'worktree'>[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const thread of threads) if (thread.worktree?.exists) counts.set(thread.cwd, (counts.get(thread.cwd) ?? 0) + 1);
  return counts;
}

/** The rows of the list, in the order of the sidebar (hidden projects included, quieter). `folders` is the trust state read per folder (absent while it loads). */
export function projectRows(
  translate: Translate,
  workspaces: readonly Workspace[],
  folders: Readonly<Record<string, TrustState>>,
  counts: ReadonlyMap<string, number>,
): ProjectRow[] {
  return workspaces.map((w) => {
    const state = folders[w.cwd];
    const trust = trustChip(translate, state);
    const git = w.worktree?.git ?? w.branch !== null;
    const facts = [plural(translate, w.threadCount, 'thread')];
    if (git) {
      const open = counts.get(w.cwd) ?? 0;
      facts.push(open > 0 ? plural(translate, open, 'worktree') : translate('settings.projects.noWorktrees'));
      if (w.worktree) facts.push(startLabels(translate)[w.worktree.start]);
      const script = w.worktree?.setupScripts[0];
      if (script) facts.push(translate('settings.projects.setup', { value1: script.name }));
    }
    if (state?.hasResources && state.status !== 'trusted')
      facts.push(
        translate('settings.projects.notLoaded', {
          value1: plural(translate, state.resources.length, 'project-resource'),
        }),
      );
    return {
      cwd: w.cwd,
      name: w.name,
      path: tildePath(w.cwd),
      ...(trust ? { trust } : {}),
      branch: w.branch,
      git,
      hidden: w.hidden,
      facts,
    };
  });
}

/** The nav count of the section: the number of projects. */
export const projectCountText = (workspaces: readonly unknown[]): string | undefined =>
  workspaces.length > 0 ? String(workspaces.length) : undefined;

// ---- reorder

/** Where a dragged project goes when it is dropped on `over`: before `over` when it came from below, before the one after `over` when it came from above (`undefined`: the end); `null` when nothing moves. */
export function dropBefore(
  order: readonly string[],
  from: string,
  over: string,
): { before: string | undefined } | null {
  const a = order.indexOf(from);
  const b = order.indexOf(over);
  if (a < 0 || b < 0 || a === b) return null;
  return { before: b < a ? over : order[b + 1] };
}

/** The same for one place up or down (the keyboard's way): `null` at the top or the bottom. */
export function neighbour(
  order: readonly string[],
  cwd: string,
  offset: -1 | 1,
): { before: string | undefined } | null {
  const at = order.indexOf(cwd);
  const over = order[at + offset];
  return at < 0 || over === undefined ? null : dropBefore(order, cwd, over);
}

// ---- the options of the page

export const startOptions = (translate: Translate): { value: StartMode; label: string }[] => [
  { value: 'local', label: translate('settings.projects.local') },
  { value: 'worktree', label: translate('settings.projects.worktree') },
  { value: 'ask', label: translate('settings.projects.ask') },
];

export const removeOptions = (translate: Translate): { value: RemoveFolder; label: string }[] => [
  { value: 'ask', label: translate('settings.projects.ask') },
  { value: 'now', label: translate('settings.projects.rightAway') },
  { value: 'after-7-days', label: translate('settings.projects.after7Days') },
  { value: 'never', label: translate('settings.projects.never') },
];

export const carryOptions = (translate: Translate): { value: WorktreeSettings['carryChanges']; label: string }[] => [
  { value: 'ask', label: translate('settings.projects.askInTheWhereRow') },
  { value: 'always', label: translate('settings.projects.always') },
  { value: 'never', label: translate('settings.projects.never') },
];

export const defaultStartOptions = (translate: Translate): { value: StartMode; label: string }[] => [
  { value: 'local', label: translate('settings.projects.local') },
  { value: 'worktree', label: translate('settings.projects.worktree') },
  { value: 'ask', label: translate('settings.projects.askEveryTime') },
];

/** The `Cut from` select: the checked-out branch (`''`, follows whatever the folder is on), every local branch, the remote ones (fetched first); a saved base that is no longer there stays selectable and says so. */
export function baseOptions(
  translate: Translate,
  git: Pick<ProjectGit, 'branches' | 'remoteBranches'> | undefined,
  saved: string | null,
): { value: string; label: string }[] {
  const options = [{ value: '', label: translate('settings.projects.theCheckedOutBranch') }];
  const known = new Set<string>(['']);
  for (const branch of git?.branches ?? []) {
    options.push({ value: branch.name, label: branch.name });
    known.add(branch.name);
  }
  for (const remote of git?.remoteBranches ?? []) {
    options.push({ value: remote, label: translate('settings.projects.fetchFirst', { value1: remote }) });
    known.add(remote);
  }
  if (saved && !known.has(saved))
    options.push({ value: saved, label: translate('settings.projects.notFound', { value1: saved }) });
  return options;
}

// ---- the dirty save

/** Is this the same as what the project has? A blank text is the same as `null` (the default). */
function same(a: unknown, b: unknown): boolean {
  const norm = (v: unknown): unknown => (typeof v === 'string' ? (v.trim() === '' ? null : v.trim()) : v);
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}

/** Only the fields of `patch` that differ from the settings the project has, so a blur on an unchanged field sends nothing. */
export function dirtyPatch(current: WorktreeSettings | undefined, patch: PatchWorktreeSettings): PatchWorktreeSettings {
  if (!current) return patch;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const now = (current as unknown as Record<string, unknown>)[key];
    if (!same(now, value)) out[key] = value;
  }
  return out as PatchWorktreeSettings;
}

// ---- the open worktrees

export interface OpenWorktreeRow {
  threadId: string;
  /** The branch, or “detached” while the worktree has none. */
  branch: string;
  detached: boolean;
  title: string;
  state: { text: string; tone: Tone };
  /** Commits ahead of the base, when the status has been read. */
  ahead: number | null;
  base: string | null;
  path: string;
  archived: boolean;
  /** The thread runs or waits: nothing may be done to its folder. */
  busy: boolean;
  /** Merged back: the folder can go. */
  merged: boolean;
}

/** How a thread in a worktree stands: running, waiting for an answer, merged, or idle. */
export function worktreeState(
  translate: Translate,
  thread: Pick<ThreadSummary, 'state' | 'archived'>,
): { text: string; tone: Tone } {
  if (thread.state.activity === 'running') return { text: translate('settings.projects.running'), tone: 'ok' };
  if (thread.state.activity === 'waiting') return { text: translate('settings.projects.waiting'), tone: 'warn' };
  if (thread.state.outcome?.kind === 'merged') return { text: translate('settings.projects.merged'), tone: 'info' };
  if (thread.state.outcome?.kind === 'pr') return { text: translate('settings.projects.pullRequest'), tone: 'info' };
  return { text: thread.archived ? 'archived' : 'idle', tone: 'off' };
}

/** “14 commits ahead of main”, “merged: the folder can go”, or nothing when the status is unknown. */
export function aheadText(
  translate: Translate,
  row: Pick<OpenWorktreeRow, 'ahead' | 'base' | 'merged'>,
): string | undefined {
  if (row.merged) return translate('settings.projects.mergedTheFolderCanGo');
  if (row.ahead === null) return undefined;
  const base = row.base ? translate('settings.projects.of', { value1: row.base }) : '';
  return row.ahead === 0
    ? translate('settings.projects.upToDateWith', { value1: row.base ?? translate('settings.projects.itsBase') })
    : translate('settings.projects.ahead', { value1: plural(translate, row.ahead, 'commit'), value2: base });
}

/** The project's threads that have a worktree folder now, as rows; `status` is what `GET /api/threads/:id/worktree` answered for each (ahead count). */
export function openWorktreeRows(
  translate: Translate,
  threads: readonly ThreadSummary[],
  cwd: string,
  status: Readonly<Record<string, WorktreeStatus | undefined>>,
): OpenWorktreeRow[] {
  return threads
    .filter((t) => t.cwd === cwd && t.worktree?.exists)
    .map((t) => {
      const worktree = t.worktree as NonNullable<ThreadSummary['worktree']>;
      const s = status[t.id];
      const detached = worktree.detached === true || worktree.branch === null;
      return {
        threadId: t.id,
        branch: detached ? 'detached' : (s?.branch ?? worktree.branch ?? 'detached'),
        detached,
        title: t.title ?? t.preview ?? translate('settings.projects.untitledThread'),
        state: worktreeState(translate, t),
        ahead: s ? s.ahead : null,
        base: s?.base ?? worktree.base,
        path: worktree.path,
        archived: t.archived,
        busy: t.state.activity !== 'idle',
        merged: t.state.outcome?.kind === 'merged',
      };
    })
    .sort((a, b) => Number(a.archived) - Number(b.archived) || a.title.localeCompare(b.title));
}

// ---- setup scripts

/** A setup script as the editor holds it: the files to copy are one text, a path per line. */
export interface ScriptDraft {
  /** `null` for a script that is not saved yet. */
  id: string | null;
  name: string;
  command: string;
  copy: string;
}

export const newDraft = (): ScriptDraft => ({ id: null, name: '', command: '', copy: '' });
export const draftOf = (script: SetupScript): ScriptDraft => ({
  id: script.id,
  name: script.name,
  command: script.command,
  copy: (script.copy ?? []).join('\n'),
});

/** The paths of a “files to copy” text: one per line (a comma also separates), trimmed, without blanks or repeats. */
export function parseCopy(text: string): string[] {
  const seen = new Set<string>();
  for (const part of text.split(/[\n,]/)) {
    const path = part.trim();
    if (path) seen.add(path);
  }
  return [...seen];
}

/** What is wrong with a draft, in a sentence, or `undefined` when it can be saved. */
export function draftProblem(translate: Translate, draft: ScriptDraft): string | undefined {
  if (!draft.name.trim()) return translate('settings.projects.giveTheScriptAName');
  if (draft.name.trim().length > 80) return translate('settings.projects.theNameIsAtMost80Characters');
  if (!draft.command.trim() && parseCopy(draft.copy).length === 0)
    return translate('settings.projects.addACommandOrFilesToCopy');
  if (draft.command.length > 2000) return translate('settings.projects.theCommandIsAtMost2000Characters');
  const unsafe = parseCopy(draft.copy).find((p) => p.startsWith('/') || p.split(/[\\/]/).includes('..'));
  if (unsafe) return translate('settings.projects.isNotInsideTheProjectUseA', { value1: unsafe });
  return undefined;
}

/** A free id for a new script: its name as a slug, numbered when taken. */
export function scriptId(name: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const slug =
    name
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'script';
  if (!used.has(slug)) return slug;
  for (let n = 2; n < 1000; n++) if (!used.has(`${slug}-${n}`)) return `${slug}-${n}`;
  return `${slug}-${used.size + 1}`;
}

/** The list with the draft saved: a new script goes last, an edited one stays where it is. */
export function withScript(list: readonly SetupScript[], draft: ScriptDraft): SetupScript[] {
  const copy = parseCopy(draft.copy);
  const script: SetupScript = {
    id:
      draft.id ??
      scriptId(
        draft.name,
        list.map((s) => s.id),
      ),
    name: draft.name.trim(),
    command: draft.command.trim(),
    ...(copy.length > 0 ? { copy } : {}),
  };
  if (draft.id === null) return [...list, script];
  return list.map((s) => (s.id === draft.id ? script : s));
}

export const withoutScript = (list: readonly SetupScript[], id: string): SetupScript[] =>
  list.filter((s) => s.id !== id);

/** The script becomes the default: the first of the list. */
export function withDefault(list: readonly SetupScript[], id: string): SetupScript[] {
  const found = list.find((s) => s.id === id);
  return found ? [found, ...list.filter((s) => s.id !== id)] : [...list];
}

/** The detail line of a script row: the command and the files it copies. */
export function scriptLine(script: SetupScript): { command: string; copies: string[] } {
  return { command: script.command, copies: script.copy ?? [] };
}
