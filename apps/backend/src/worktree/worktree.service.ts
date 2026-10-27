import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname } from 'node:path';
import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type {
  NewLocal,
  NewWorktree,
  ProjectGit,
  PatchWorktreeDefaults,
  SetupScript,
  StartMode,
  ThreadWorktree,
  WorktreeBranchResult,
  WorktreeDefaults,
  WorktreeHandoffRequest,
  WorktreeHandoffResult,
  WorktreeMergeRequest,
  WorktreeMergeResult,
  WorktreeMessage,
  WorktreeRemoveRequest,
  WorktreeSettings,
  WorktreeStatus,
  WorktreeSyncResult,
} from '@pi-kit/protocol';
import { MetaRepository } from '../db/meta.repository';
import { type ThreadRow, ThreadsRepository, type WorktreeFacts } from '../db/threads.repository';
import { PiSessionService } from '../pi/pi-session.service';
import { TrustService } from '../pi/trust.service';
import { TerminalService } from '../terminal/terminal.service';
import { currentBranch, readHead } from '../threads/branch';
import { OutcomesService } from '../threads/outcomes.service';
import { ThreadStatusService } from '../threads/thread-status.service';
import { generateCommitMessage, mergeCommitMessage } from './commit-message';
import * as wt from './worktree-git';
import { copyScriptFiles, detectSetupScriptIn, effectiveScripts, pickScript } from './setup-scripts';
import { localBaseName, normalizePrefix, resolveBase, resolveRoot, uniqueSlug, worktreeNames, worktreePath } from './worktree-paths';

/** The settings key that holds the worktree folders waiting to be removed (Remove the folder: after 7 days). */
const SWEEP_KEY = 'worktree.sweep';

/** Is the GitHub CLI installed? Looked up once; `PI_KIT_GH` overrides the command (the tests point it at a script, or at nothing). */
let ghChecked: boolean | undefined;
export function ghAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env === process.env && ghChecked !== undefined) return ghChecked;
  const command = env['PI_KIT_GH'] || 'gh';
  const found = command !== 'none' && spawnSync(command, ['--version'], { stdio: 'ignore' }).status === 0;
  if (env === process.env) ghChecked = found;
  return found;
}

/**
 * A git worktree per thread: create it next to nothing but the repository's own `.git`, keep it in sync with the base branch, merge it
 * back (a merge commit on the base, or a pull request), and remove it. pi has no idea: its session just has another `cwd`. Everything that changes files waits
 * for the thread's run to end.
 */
@Injectable()
export class WorktreeService {
  private readonly logger = new Logger(WorktreeService.name);

  constructor(
    private readonly meta: MetaRepository,
    private readonly threads: ThreadsRepository,
    private readonly sessions: PiSessionService,
    private readonly terminals: TerminalService,
    private readonly trust: TrustService,
    private readonly status: ThreadStatusService,
    private readonly outcomes: OutcomesService,
  ) {
    // A worktree folder inherits the project's trust answer (the trust service checks that the resources are the same).
    this.trust.useWorktrees((path) => this.threads.worktreeAt(path)?.cwd);
  }

  // ---- settings

  /** The settings key of the defaults for every project (Settings › Projects): `{ root?, start? }`. */
  private static readonly DEFAULTS_KEY = 'worktree.defaults';

  /** The defaults for every project: where worktrees go and where a new thread starts when a project says nothing. */
  defaults(): WorktreeDefaults {
    const saved = (this.meta.getSetting(WorktreeService.DEFAULTS_KEY) as { root?: string | null; start?: StartMode } | undefined) ?? {};
    return { root: saved.root?.trim() ? saved.root.trim() : null, defaultRoot: resolveRoot({}), start: saved.start ?? 'local' };
  }

  patchDefaults(patch: PatchWorktreeDefaults): WorktreeDefaults {
    const now = this.defaults();
    const next = { root: patch.root === undefined ? now.root : patch.root?.trim() ? patch.root.trim() : null, start: patch.start ?? now.start };
    this.meta.setSetting(WorktreeService.DEFAULTS_KEY, next);
    return this.defaults();
  }

  /** A project's worktree settings, what a new thread or worktree would use. `git` is whether the folder is inside a work tree. */
  settingsOf(projectCwd: string): WorktreeSettings {
    const row = this.meta.listWorkspaces().find((w) => w.cwd === projectCwd);
    const defaults = this.defaults();
    const scripts = effectiveScripts({ saved: row?.scripts ?? null, detect: () => detectSetupScriptIn(projectCwd) });
    return {
      root: row?.worktreeRoot ?? null,
      base: row?.worktreeBase ?? null,
      // The single command is the first script's, when one was configured (a script the lockfile suggests is not a saved setting).
      setup: row?.scripts?.[0]?.command ?? null,
      // What the folder is when the project has none of its own: the defaults for every project, else PI_KIT_WORKTREE_ROOT, else ~/.pi-kit/worktrees.
      defaultRoot: resolveRoot({ setting: defaults.root, projectCwd }),
      git: currentBranch(projectCwd) !== null,
      start: row?.wtStart ?? defaults.start,
      allowBranchSwitch: row?.wtAllowSwitch ?? true,
      carryChanges: row?.wtCarry ?? 'ask',
      branchMode: row?.wtBranchMode ?? 'named',
      branchPrefix: normalizePrefix(row?.wtBranchPrefix),
      removeFolder: row?.wtRemove ?? 'ask',
      setupScripts: scripts,
      ...(row?.scripts == null && scripts.length > 0 ? { setupSuggested: true } : {}),
    };
  }

  // ---- the folder as the Where row shows it

  /** The checked-out branch, the changed files, the local branches (and which worktree holds each) and the remote ones. */
  async projectGit(cwd: string): Promise<ProjectGit> {
    if (!(await wt.toplevel(cwd))) return { git: false, branch: null, head: null, dirty: 0, branches: [], remoteBranches: [], hasRemote: false };
    const head = readHead(cwd);
    const [dirty, branches, remotes, hasRemote] = await Promise.all([
      wt.changedFiles(cwd).then((f) => f.length, () => 0),
      wt.localBranches(cwd).catch(() => []),
      wt.remoteBranches(cwd),
      wt.hasRemote(cwd),
    ]);
    const rows = this.threads.all();
    return {
      git: true,
      branch: head?.branch ?? null,
      head: head?.short ?? null,
      dirty,
      // The checked-out branch first, the rest newest first (as listed by commit date).
      branches: branches
        .map((b) => ({
          name: b.name,
          current: b.name === head?.branch,
          heldBy: b.heldBy ? { path: b.heldBy, thread: rows.find((t) => t.worktreePath === b.heldBy)?.title ?? null } : null,
        }))
        .sort((a, b) => Number(b.current) - Number(a.current)),
      remoteBranches: remotes,
      hasRemote,
    };
  }

  /**
   * A new Local thread on another branch: the folder's checkout is switched before the first run. Only with a clean tree (changed files, untracked ones
   * included, are what the Where row counts), only when the project allows it, never to a branch a worktree holds, and `create` makes the branch from the checked-out one.
   * Every refusal is a 409 whose sentence says what to do. Returns the branch that is checked out afterwards.
   */
  async switchLocal(projectCwd: string, local: NewLocal): Promise<string | null> {
    const wanted = local.branch?.trim();
    if (!(await wt.toplevel(projectCwd))) throw new BadRequestException('A branch switch needs a git repository. This folder is not one.');
    const current = await wt.branchOf(projectCwd);
    if (!wanted || (!local.create && wanted === current)) return current;
    const settings = this.settingsOf(projectCwd);
    if (!settings.allowBranchSwitch) throw new ConflictException('Switching branches is turned off for this project (Settings › Projects › New threads).');
    if (!(await wt.validBranchName(projectCwd, wanted))) throw new BadRequestException(`“${wanted}” is not a branch name.`);
    if (await wt.operationInProgress(projectCwd)) throw new ConflictException('A merge or rebase is waiting in the folder. Finish it or abort it, then switch.');
    if (local.create) {
      if (await wt.branchExists(projectCwd, wanted)) throw new ConflictException(`The branch ${wanted} exists already. Pick another name, or switch to it.`);
    } else {
      if (!(await wt.branchExists(projectCwd, wanted))) throw new ConflictException(`There is no branch ${wanted} in this repository.`);
      const held = (await wt.localBranches(projectCwd)).find((b) => b.name === wanted)?.heldBy;
      if (held) throw new ConflictException(`${wanted} is checked out in the worktree at ${held}. A branch can only be checked out once: hand that thread off to local, or pick another branch.`);
    }
    // A new branch takes the uncommitted changes along (the switch -c of git keeps them); moving to another branch needs them stashed or committed.
    const dirty = local.create ? 0 : (await wt.changedFiles(projectCwd)).length;
    if (dirty > 0) throw new ConflictException(`The folder has ${dirty} uncommitted ${dirty === 1 ? 'file' : 'files'}. Stash or commit ${dirty === 1 ? 'it' : 'them'}, then switch to ${wanted}.`);
    const switched = await wt.run(projectCwd, local.create ? ['switch', '-c', wanted] : ['switch', wanted]);
    if (!switched.ok) throw new ConflictException(`git could not switch to ${wanted}: ${switched.stderr || switched.stdout}`.trim());
    this.logger.log(`Folder ${projectCwd} switched to ${wanted}${local.create ? ' (new)' : ''}`);
    return wanted;
  }

  // ---- create

  /**
   * `git worktree add <root>/<repo-slug>/<name-slug> -b <prefix><name-slug> <base>`, or `--detach` without a branch. The slug comes from `name` (the first message),
   * else the title, else the thread id; a taken folder or branch name gets a number. A typed branch is used as typed and must be free. `base` may be `origin/<branch>`
   * (fetched first); the thread merges back into the local branch of that name. `carryChanges` applies the folder's uncommitted changes, which stay where they are.
   * The setup script (the project's first unless the request names one or none) has its files copied in and its command typed into the new folder's terminal.
   */
  async create(projectCwd: string, options: { threadId: string; title?: string; request?: NewWorktree; setup?: 'terminal' | 'skip' }): Promise<WorktreeFacts> {
    const request = options.request ?? {};
    if (!(await wt.toplevel(projectCwd))) throw new BadRequestException('A worktree needs a git repository. This folder is not one.');
    if (!(await wt.refExists(projectCwd, 'HEAD'))) throw new BadRequestException('This repository has no commits yet, so there is nothing to make a worktree from. Commit once first.');
    const settings = this.settingsOf(projectCwd);
    const requested = resolveBase({ requested: request.base, setting: settings.base, current: await wt.branchOf(projectCwd) });
    if (requested?.startsWith('-')) throw new BadRequestException(`“${requested}” is not a branch name.`);
    if (!requested) throw new BadRequestException('The project has no branch checked out (a detached HEAD). Check one out, or set the base branch in Settings › Projects.');
    if (requested.startsWith('origin/') && (await wt.hasRemote(projectCwd))) await wt.run(projectCwd, ['fetch', '--quiet', 'origin', requested.slice('origin/'.length)], { timeoutMs: 30_000 });
    if (!(await wt.refExists(projectCwd, requested))) throw new BadRequestException(`The base branch “${requested}” does not exist in this repository.`);
    const base = localBaseName(requested);
    const typed = typeof request.branch === 'string' ? request.branch : undefined;
    const detached = request.branch === null || (request.branch === undefined && settings.branchMode === 'detached');
    if (typed) {
      if (!(await wt.validBranchName(projectCwd, typed))) throw new BadRequestException(`“${typed}” is not a branch name.`);
      if (await wt.branchExists(projectCwd, typed)) throw new ConflictException(`The branch ${typed} exists already. Pick another name.`);
    }
    const scripts = settings.setupScripts;
    const script = pickScript(scripts, request.setup);
    const carry = settings.carryChanges === 'never' ? false : (request.carryChanges ?? settings.carryChanges === 'always');
    // Read before anything is added, from the folder, without touching its index or files.
    const carried = carry ? await wt.workingTreePatch(projectCwd) : undefined;
    const root = resolveRoot({ setting: settings.root ?? this.defaults().root, projectCwd });
    const names = worktreeNames({ ...(request.name ? { name: request.name } : {}), ...(options.title ? { title: options.title } : {}), threadId: options.threadId, prefix: settings.branchPrefix, ...(typed ? { typed } : {}), detached });
    const slug = await this.freeSlug(projectCwd, root, names.slug, names.branch, !typed);
    const path = worktreePath(root, projectCwd, slug);
    const branch = names.branch(slug);
    mkdirSync(dirname(path), { recursive: true });
    try {
      await wt.addWorktree(projectCwd, path, branch, requested);
    } catch (error) {
      throw new ConflictException(`git could not create the worktree: ${error instanceof Error ? error.message : String(error)}`);
    }
    // The same folder as git and pi will see it (a symlinked temp folder resolves to its real path).
    const real = realpathSync(path);
    const facts: WorktreeFacts = { path: real, branch, projectCwd, base };
    if (carried && carried.patch) {
      try {
        await wt.applyPatch(real, carried.patch);
      } catch (error) {
        await this.discard(facts);
        throw new ConflictException(`The folder's uncommitted changes do not apply on ${requested}: ${error instanceof Error ? error.message : String(error)}`.trim());
      }
    }
    this.logger.log(`Worktree ${branch ?? '(detached)'} (from ${requested}) created at ${real}${carried?.files.length ? `, carrying ${carried.files.length} changed files` : ''}`);
    // A verification run runs the setup itself and waits for it, so the checks it repeats have what they need: it asks for `skip` here.
    if (script && options.setup !== 'skip') this.runSetup(real, script, projectCwd);
    return facts;
  }

  /** The folder a project's thread worktrees go into (the project's setting, `PI_KIT_WORKTREE_ROOT`, or the default). */
  rootOf(projectCwd: string): string {
    return resolveRoot({ setting: this.settingsOf(projectCwd).root ?? this.defaults().root, projectCwd });
  }

  private async freeSlug(projectCwd: string, root: string, wanted: string, branchOf: (slug: string) => string | null, checkBranch: boolean): Promise<string> {
    const taken = new Set<string>();
    // Folders and branches are checked up front (the callback has to be synchronous). A typed branch is checked by the caller, not numbered.
    for (let n = 1; n < 50; n++) {
      const candidate = n === 1 ? wanted : `${wanted}-${n}`;
      const branch = branchOf(candidate);
      const branchTaken = checkBranch && branch !== null && (await wt.branchExists(projectCwd, branch));
      if (existsSync(worktreePath(root, projectCwd, candidate)) || branchTaken) taken.add(candidate);
      else break;
    }
    return uniqueSlug(wanted, (candidate) => taken.has(candidate));
  }

  /** A Local thread's setup script: its command is typed into the folder's own terminal. `id` null or absent runs nothing. */
  runLocalSetup(projectCwd: string, id: string | null | undefined): void {
    if (!id) return;
    const script = pickScript(this.settingsOf(projectCwd).setupScripts, id);
    if (script) this.runSetup(projectCwd, script, projectCwd);
  }

  /** The script's files are copied from the project, then its command goes to the new folder's terminal, so its output is where the person looks for it. The shell reads it as soon as it is up. */
  private runSetup(path: string, script: SetupScript, projectCwd: string): void {
    try {
      if (path !== projectCwd) copyScriptFiles(script, projectCwd, path);
      if (!script.command.trim()) return;
      this.terminals.start(path, 120, 30);
      this.terminals.write(path, `${script.command}\r`);
    } catch (error) {
      this.logger.warn(`Could not run the setup script in ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // ---- reads

  /** The worktree of a row as the thread list shows it; `undefined` for a thread that never had one. */
  describe(row: ThreadRow): ThreadWorktree | undefined {
    if (!row.worktreePath && !row.branch) return undefined;
    const exists = !!row.worktreePath && existsSync(row.worktreePath);
    const head = exists && row.worktreePath ? readHead(row.worktreePath) : null;
    return {
      path: row.worktreePath ?? row.sessionCwd,
      // A detached worktree has no branch (`detached`); a folder git cannot be read in falls back to what was recorded.
      branch: head ? head.branch : row.branch,
      base: row.baseBranch,
      exists,
      ...(head?.detached ? { detached: true } : {}),
    };
  }

  async state(row: ThreadRow): Promise<WorktreeStatus> {
    const path = row.worktreePath;
    const base = row.baseBranch;
    if (!path || !existsSync(path)) {
      return { path: path ?? row.sessionCwd, exists: false, branch: row.branch, base, dirty: 0, ahead: 0, behind: 0, conflicts: [], operation: null, baseCheckedOut: false, projectDirty: 0, remote: false, gh: false, sharedWith: 0, removeFolder: this.settingsOf(row.cwd).removeFolder };
    }
    const [dirty, counts, conflicts, operation, projectBranch, projectDirty, remote] = await Promise.all([
      wt.changedFiles(path),
      base ? wt.aheadBehind(path, base) : Promise.resolve({ ahead: 0, behind: 0 }),
      wt.unresolvedFiles(path),
      wt.operationInProgress(path),
      wt.branchOf(row.cwd),
      wt.trackedChanges(row.cwd).catch(() => 0),
      wt.hasRemote(row.cwd),
    ]);
    return {
      path,
      exists: true,
      branch: (await wt.branchOf(path)) ?? row.branch,
      base,
      dirty: dirty.length,
      ahead: counts.ahead,
      behind: counts.behind,
      conflicts,
      operation,
      baseCheckedOut: !!base && projectBranch === base,
      projectDirty,
      remote,
      gh: ghAvailable(),
      sharedWith: this.threads.all().filter((t) => t.id !== row.id && t.worktreePath === path).length,
      removeFolder: this.settingsOf(row.cwd).removeFolder,
    };
  }

  /** The commit message proposed for the worktree's uncommitted changes. */
  async message(row: ThreadRow): Promise<WorktreeMessage> {
    const path = this.requireWorktree(row);
    const files = await wt.changedFiles(path);
    return { message: generateCommitMessage({ title: row.title, files }), files: files.length };
  }

  // ---- sync

  /** Fetches (when there is a remote) and brings the base into the worktree's branch, by merge or by rebase. A conflict stays in progress in the worktree. */
  async sync(row: ThreadRow, strategy: 'merge' | 'rebase'): Promise<WorktreeSyncResult> {
    const path = this.requireWorktree(row);
    const base = this.requireBase(row);
    this.requireIdle(row);
    if (await wt.operationInProgress(path)) throw new ConflictException('A merge or rebase is already waiting in this worktree. Finish it or abort it first.');
    const fetched = (await wt.hasRemote(path)) ? (await wt.run(path, ['fetch', '--quiet'], { timeoutMs: 30_000 })).ok : false;
    // The base as the remote has it, when it is ahead of the local branch; else the local branch (the main checkout may have moved on without a push).
    let ref = base;
    const remoteRef = `origin/${base}`;
    if (fetched && (await wt.refExists(path, remoteRef)) && (await wt.isAncestor(path, base, remoteRef))) ref = remoteRef;
    if (await wt.isAncestor(path, ref, 'HEAD')) return { status: 'up-to-date', fetched, conflicts: [], message: `Already up to date with ${base}.` };
    if (strategy === 'rebase' && (await wt.changedFiles(path)).length > 0) throw new ConflictException('Commit or discard the uncommitted changes first: a rebase needs a clean worktree.');
    const result = await wt.run(path, strategy === 'rebase' ? ['rebase', ref] : ['merge', '--no-edit', ref], { identity: true });
    if (result.ok) {
      this.status.touch(row.id);
      return { status: 'synced', fetched, conflicts: [], message: `${base} is in ${row.branch ?? 'the branch'} now (${strategy}).` };
    }
    const conflicts = await wt.conflictedFiles(path);
    if (conflicts.length === 0) throw new ConflictException(`git could not ${strategy} ${ref}: ${result.stderr || result.stdout}`.trim());
    return { status: 'conflict', fetched, conflicts, message: `${conflicts.length} ${conflicts.length === 1 ? 'file has' : 'files have'} conflicts. Resolve them in the worktree (review mode shows them), then merge back.` };
  }

  /** Gives up the merge or rebase that waits in the worktree. */
  async abort(row: ThreadRow): Promise<void> {
    const path = this.requireWorktree(row);
    this.requireIdle(row);
    const operation = await wt.operationInProgress(path);
    if (!operation) return;
    await wt.out(path, operation === 'merge' ? ['merge', '--abort'] : ['rebase', '--abort']);
    this.status.touch(row.id);
  }

  // ---- merge back

  /**
   * Commits what is uncommitted (with the message the person edited), then either merges the branch into the base in the main checkout (`--no-ff`, so
   * the thread is one merge commit) or pushes it and opens a pull request with `gh`. With `remove`, the worktree goes afterwards. A merge that
   * conflicts is undone in the main checkout, which never stays in conflict; the person syncs the base into the worktree and resolves there.
   */
  async merge(row: ThreadRow, request: WorktreeMergeRequest): Promise<WorktreeMergeResult> {
    const path = this.requireWorktree(row);
    const base = this.requireBase(row);
    // A detached worktree merges back from its HEAD: the commit stands in for the branch.
    const named = (await wt.branchOf(path)) ?? row.branch;
    if (!named && request.mode === 'pr') throw new ConflictException('A pull request needs a branch, and this worktree is detached. Use “Create branch here” in the thread menu, or merge it locally.');
    this.requireIdle(row);
    const conflicts = await wt.unresolvedFiles(path);
    if (conflicts.length > 0) {
      return { status: 'conflict', conflicts, removed: false, message: 'There are unresolved conflicts in the worktree. Resolve them first.' };
    }
    const operation = await wt.operationInProgress(path);
    const dirty = await wt.changedFiles(path);
    if (operation === 'rebase') {
      await wt.out(path, ['add', '-A', '--', '.']);
      await wt.out(path, ['rebase', '--continue'], { identity: true });
    } else if (operation === 'merge') {
      await wt.out(path, ['add', '-A', '--', '.']);
      await wt.out(path, ['commit', '--no-edit'], { identity: true });
    } else if (dirty.length > 0) {
      const message = request.message?.trim() || generateCommitMessage({ title: row.title, files: dirty });
      await wt.commitAll(path, message);
    }
    const title = row.title ?? undefined;
    const branch = named ?? (await wt.headCommit(path));
    let result: WorktreeMergeResult;
    if (request.mode === 'pr') {
      result = await this.openPullRequest(path, branch, base, row);
      // The branch tip is where the pull request ends; it is the thread's outcome until the pull request is merged.
      if (result.status === 'pr' && result.url) await this.outcomes.recordPullRequest(row, path, result.url);
    } else {
      result = await this.mergeIntoBase(row, branch, base, title);
      if (result.status === 'merged' && result.commit) await this.outcomes.recordMerged(row, result.commit);
    }
    if (request.remove && (result.status === 'merged' || result.status === 'pr')) {
      await this.remove(row, { force: false }, result.status === 'merged' ? (named ?? undefined) : undefined);
      result = { ...result, removed: true };
    }
    this.status.touch(row.id);
    return result;
  }

  private async mergeIntoBase(row: ThreadRow, branch: string, base: string, title: string | undefined): Promise<WorktreeMergeResult> {
    const project = row.cwd;
    const checkedOut = await wt.branchOf(project);
    if (checkedOut !== base) throw new ConflictException(`The main checkout has ${checkedOut ?? 'no branch'} checked out, not ${base}. Check ${base} out there, then merge back.`);
    if ((await wt.trackedChanges(project)) > 0) throw new ConflictException(`The main checkout has uncommitted changes. Commit or stash them, then merge back.`);
    if (await wt.isAncestor(project, branch, base)) {
      return { status: 'merged', conflicts: [], removed: false, message: `${branch} has nothing that ${base} lacks.` };
    }
    const merged = await wt.run(project, ['merge', '--no-ff', '-m', mergeCommitMessage(branch, base, title), branch], { identity: true });
    if (!merged.ok) {
      const conflicts = await wt.conflictedFiles(project);
      // The main checkout is left as it was.
      await wt.run(project, ['merge', '--abort']);
      if (conflicts.length === 0) throw new ConflictException(`git could not merge ${branch}: ${merged.stderr || merged.stdout}`.trim());
      return { status: 'conflict', conflicts, removed: false, message: `${branch} conflicts with ${base} in ${conflicts.length} ${conflicts.length === 1 ? 'file' : 'files'}. Sync with ${base} in the worktree and resolve there first.` };
    }
    const commit = await wt.headCommit(project);
    this.logger.log(`Merged ${branch} into ${base} at ${project} (${commit})`);
    return { status: 'merged', commit, conflicts: [], removed: false, message: `${branch} is merged into ${base} (${commit}).` };
  }

  private async openPullRequest(path: string, branch: string, base: string, row: ThreadRow): Promise<WorktreeMergeResult> {
    if (!(await wt.hasRemote(path))) throw new ConflictException('This repository has no remote to push to, so a pull request is not possible. Merge it locally instead.');
    if (!ghAvailable()) throw new ConflictException('The GitHub CLI (gh) is not installed, so a pull request cannot be opened from here.');
    const push = await wt.run(path, ['push', '--set-upstream', 'origin', branch], { timeoutMs: 60_000 });
    if (!push.ok) throw new ConflictException(`git could not push ${branch}: ${push.stderr || push.stdout}`.trim());
    const log = (await wt.out(path, ['log', '-1', '--format=%s%n%n%b'])).trim().split('\n');
    const title = (row.title ?? log[0] ?? branch).slice(0, 200);
    const gh = spawnSync(process.env['PI_KIT_GH'] || 'gh', ['pr', 'create', '--base', base, '--head', branch, '--title', title, '--body', log.slice(2).join('\n') || `Opened from pi-kit.`], { cwd: path, encoding: 'utf8' });
    if (gh.status !== 0) throw new ConflictException(`gh could not open the pull request: ${(gh.stderr || gh.stdout || '').trim()}`);
    const url = gh.stdout.trim().split('\n').at(-1) ?? '';
    return { status: 'pr', url, conflicts: [], removed: false, message: `Pull request opened: ${url}` };
  }

  // ---- hand off

  /**
   * Moves a thread between the project's folder and a worktree. `to: local` (a worktree thread) puts the worktree's branch, or its commit when it is detached, and its
   * uncommitted changes into the folder, which must be clean; the worktree folder is removed as the request or the project's "Remove the folder" says. `to: worktree`
   * (a Local thread) makes a worktree from the folder's branch and moves the folder's uncommitted changes into it (a copy stays in the folder's stash). The pi session
   * goes on in the new folder: only its working directory changes.
   */
  async handoff(row: ThreadRow, request: WorktreeHandoffRequest): Promise<WorktreeHandoffResult> {
    this.requireIdle(row);
    return request.to === 'local' ? this.handOffToLocal(row, request) : this.moveIntoWorktree(row, request);
  }

  private async handOffToLocal(row: ThreadRow, request: WorktreeHandoffRequest): Promise<WorktreeHandoffResult> {
    if (!row.worktreePath) throw new ConflictException('This thread works in the project folder already.');
    const path = this.requireWorktree(row);
    const project = row.cwd;
    if (!existsSync(project)) throw new ConflictException(`The project folder ${project} is gone.`);
    if (this.threads.all().some((t) => t.id !== row.id && t.worktreePath === path)) throw new ConflictException('Another thread runs in this worktree too, so it cannot be handed off.');
    if (await wt.operationInProgress(path)) throw new ConflictException('A merge or rebase is waiting in the worktree. Finish it or abort it, then hand off.');
    if (await wt.operationInProgress(project)) throw new ConflictException('A merge or rebase is waiting in the folder. Finish it or abort it, then hand off.');
    const dirty = (await wt.changedFiles(project)).length;
    if (dirty > 0) throw new ConflictException(`The folder has ${dirty} uncommitted ${dirty === 1 ? 'file' : 'files'}. Commit or stash ${dirty === 1 ? 'it' : 'them'}, then hand off.`);
    const branch = await wt.branchOf(path);
    const commit = (await wt.out(path, ['rev-parse', 'HEAD'])).trim();
    const folderBranch = await wt.branchOf(project);
    const folderCommit = (await wt.out(project, ['rev-parse', 'HEAD'])).trim();
    const carried = await wt.workingTreePatch(path);
    const back = async (): Promise<void> => {
      await wt.run(project, folderBranch ? ['switch', folderBranch] : ['switch', '--detach', folderCommit]);
      if (branch) await wt.run(path, ['switch', branch]);
    };
    // The branch can only be checked out in one place: the worktree lets go of it (it stays on the same commit, with its changes), then the folder takes it.
    if (branch) await wt.out(path, ['switch', '--detach']);
    try {
      if (branch) await wt.out(project, ['switch', branch]);
      else if (folderCommit !== commit) await wt.out(project, ['switch', '--detach', commit]);
      await wt.applyPatch(project, carried.patch);
    } catch (error) {
      await back();
      throw new ConflictException(`git could not move the worktree's work into the folder: ${error instanceof Error ? error.message : String(error)}`.trim());
    }
    const policy = this.settingsOf(project).removeFolder;
    const remove = request.remove ?? policy === 'now';
    this.sessions.dispose(row.id);
    let removed = false;
    if (remove) {
      this.terminals.kill(path);
      try {
        await wt.removeWorktree(project, path, { force: true });
        removed = true;
      } catch (error) {
        this.logger.warn(`Could not remove ${path} after the hand off: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else if (policy === 'after-7-days') {
      this.scheduleSweep(path, project);
    }
    this.threads.clearWorktreeFully(row.id);
    this.status.listChanged();
    this.status.touch(row.id);
    const where = branch ? `on ${branch}` : `at ${commit.slice(0, 7)} (detached)`;
    this.logger.log(`Thread ${row.id} handed off from ${path} to ${project} ${where}, ${carried.files.length} changed files${removed ? ', worktree removed' : ''}`);
    return {
      to: 'local',
      path: project,
      branch: branch ?? null,
      moved: carried.files.length,
      removed,
      message: `The thread works in the project folder now, ${where}${carried.files.length ? `, with ${carried.files.length} uncommitted ${carried.files.length === 1 ? 'file' : 'files'}` : ''}.${removed ? ' The worktree folder is removed.' : ` The worktree folder stays at ${path}.`}`,
    };
  }

  private async moveIntoWorktree(row: ThreadRow, request: WorktreeHandoffRequest): Promise<WorktreeHandoffResult> {
    if (row.worktreePath) throw new ConflictException('This thread works in a worktree already.');
    const project = row.cwd;
    if (await wt.operationInProgress(project)) throw new ConflictException('A merge or rebase is waiting in the folder. Finish it or abort it, then move the thread.');
    const carry = request.carryChanges ?? true;
    const name = (row.title ?? row.preview ?? '').trim().slice(0, 80);
    const facts = await this.create(project, {
      threadId: row.id,
      ...(row.title ? { title: row.title } : {}),
      request: {
        carryChanges: carry,
        ...(request.branch !== undefined ? { branch: request.branch } : {}),
        ...(request.setup !== undefined ? { setup: request.setup } : {}),
        ...(name ? { name } : {}),
      },
    });
    let moved = 0;
    let note = '';
    if (carry) {
      moved = (await wt.changedFiles(project)).length;
      if (moved > 0) {
        // Moved, not copied: the folder goes back to what is committed; the stash keeps a copy to get them back from.
        const label = `pi-kit: moved to ${facts.branch ?? facts.path}`;
        const stashed = await wt.run(project, ['stash', 'push', '--include-untracked', '-m', label], { identity: true });
        if (stashed.ok) note = ` A copy is in the folder's stash (“${label}”).`;
        else note = ` The folder could not be cleaned (${stashed.stderr || stashed.stdout}), so the changes are in both places.`.trim();
      }
    }
    this.sessions.dispose(row.id);
    this.threads.setWorktree(row.id, facts);
    this.status.listChanged();
    this.status.touch(row.id);
    this.logger.log(`Thread ${row.id} moved from ${project} into the worktree ${facts.path}, ${moved} changed files`);
    return {
      to: 'worktree',
      path: facts.path,
      branch: facts.branch,
      moved,
      removed: false,
      message: `The thread works in a worktree now, ${facts.branch ? `on ${facts.branch}` : 'detached'}, cut from ${facts.base}${moved ? `, with ${moved} uncommitted ${moved === 1 ? 'file' : 'files'}` : ''}.${note}`,
    };
  }

  /** Gives a detached worktree a branch ("Create branch here"). */
  async createBranch(row: ThreadRow, name: string): Promise<WorktreeBranchResult> {
    const path = this.requireWorktree(row);
    this.requireIdle(row);
    if (await wt.branchOf(path)) throw new ConflictException('This worktree has a branch already.');
    if (await wt.operationInProgress(path)) throw new ConflictException('A merge or rebase is waiting in the worktree. Finish it or abort it first.');
    if (!(await wt.validBranchName(path, name))) throw new BadRequestException(`“${name}” is not a branch name.`);
    if (await wt.branchExists(path, name)) throw new ConflictException(`The branch ${name} exists already. Pick another name.`);
    await wt.out(path, ['switch', '-c', name]);
    this.threads.setBranch(row.id, name);
    this.status.listChanged();
    this.status.touch(row.id);
    return { branch: name };
  }

  // ---- folders that stay for a while (Remove the folder: after 7 days)

  /** A worktree folder that outlived its thread (a hand off) is removed once it is a week old and still clean. */
  private scheduleSweep(path: string, project: string, days = 7): void {
    const list = (this.meta.getSetting(SWEEP_KEY) as { path: string; project: string; at: number }[] | undefined) ?? [];
    this.meta.setSetting(SWEEP_KEY, [...list.filter((e) => e.path !== path), { path, project, at: Date.now() + days * 86_400_000 }]);
  }

  /** Removes the folders whose time has come, if they are clean and no thread uses them; the others are looked at again next time. */
  async sweep(now = Date.now()): Promise<string[]> {
    const list = (this.meta.getSetting(SWEEP_KEY) as { path: string; project: string; at: number }[] | undefined) ?? [];
    if (list.length === 0) return [];
    const removed: string[] = [];
    const keep: typeof list = [];
    for (const entry of list) {
      if (!existsSync(entry.path) || this.threads.all().some((t) => t.worktreePath === entry.path)) continue;
      if (entry.at > now) {
        keep.push(entry);
        continue;
      }
      try {
        if ((await wt.changedFiles(entry.path)).length > 0) {
          keep.push({ ...entry, at: now + 86_400_000 });
          continue;
        }
        this.terminals.kill(entry.path);
        await wt.removeWorktree(entry.project, entry.path);
        removed.push(entry.path);
      } catch (error) {
        this.logger.warn(`Could not remove ${entry.path}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    this.meta.setSetting(SWEEP_KEY, keep);
    return removed;
  }

  // ---- remove

  /**
   * Removes the worktree folder (and, when `deleteBranch` is given, the merged branch). Without `force` only a clean worktree goes; a dirty one, or one that
   * another thread also runs in, is a conflict the caller turns into a question.
   */
  async remove(row: ThreadRow, request: WorktreeRemoveRequest, deleteBranch?: string): Promise<{ removed: boolean }> {
    const path = row.worktreePath;
    if (!path) return { removed: false };
    if (existsSync(path)) {
      this.requireIdle(row);
      if (!request.force) {
        const dirty = (await wt.changedFiles(path)).length;
        if (dirty > 0) throw new ConflictException(`The worktree has ${dirty} uncommitted ${dirty === 1 ? 'change' : 'changes'}. Merge them back, keep the worktree, or remove it anyway.`);
        const shared = this.threads.all().filter((t) => t.id !== row.id && t.worktreePath === path).length;
        if (shared > 0) throw new ConflictException('Another thread runs in this worktree too. Keep it, or remove it anyway.');
      }
      this.sessions.dispose(row.id);
      this.terminals.kill(path);
      try {
        await wt.removeWorktree(row.cwd, path, { force: request.force, ...(deleteBranch ? { deleteBranch } : {}) });
      } catch (error) {
        throw new ConflictException(`git could not remove the worktree: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    // Every thread that ran there carries on in the project's folder.
    for (const thread of this.threads.all().filter((t) => t.worktreePath === path)) {
      this.sessions.dispose(thread.id);
      this.threads.clearWorktree(thread.id);
    }
    this.status.listChanged();
    this.logger.log(`Worktree ${path} removed`);
    return { removed: true };
  }

  /** Undoes a worktree whose thread could not be created. */
  async discard(facts: WorktreeFacts): Promise<void> {
    try {
      await wt.removeWorktree(facts.projectCwd, facts.path, { force: true, ...(facts.branch ? { deleteBranch: facts.branch } : {}) });
    } catch (error) {
      this.logger.warn(`Could not remove the unused worktree ${facts.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Worktree facts for the row, or a 404 for a thread without one. */
  requireWorktree(row: ThreadRow): string {
    if (!row.worktreePath) throw new NotFoundException('This thread does not run in a worktree.');
    if (!existsSync(row.worktreePath)) throw new ConflictException(`The worktree ${row.worktreePath} is gone.`);
    return row.worktreePath;
  }

  private requireBase(row: ThreadRow): string {
    if (!row.baseBranch) throw new ConflictException('This worktree has no base branch recorded.');
    return row.baseBranch;
  }

  private requireIdle(row: ThreadRow): void {
    if (this.sessions.has(row.id) && this.sessions.isStreaming(row.id)) throw new ConflictException('Stop the run first: its files are about to change.');
  }
}
