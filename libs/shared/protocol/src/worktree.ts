import { z } from 'zod';

/**
 * Worktree per thread and the coordination of agents that share a folder: the shapes of the worktree actions
 * (`/api/threads/:id/worktree/...`), the per-project settings, and the file leases the Files panel and review mode show.
 */

/** A thread that runs in its own git worktree. `branch` is read from the worktree's `HEAD` when it can be, else what was recorded at creation. */
export const ThreadWorktreeSchema = z.object({
  /** The worktree folder pi runs in; the Files, Changes, Terminal and review panels work there. */
  path: z.string(),
  branch: z.string().nullable(),
  /** The branch the worktree was cut from and merges back into. */
  base: z.string().nullable(),
  /** False once the folder is gone (removed after a merge, or by hand): the thread then continues in the project's folder. */
  exists: z.boolean(),
  /** The worktree has no branch checked out: "Create branch here" gives it one, Merge back merges its `HEAD`. `branch` is `null` then. */
  detached: z.boolean().optional(),
}).meta({ id: 'ThreadWorktree' });
export type ThreadWorktree = z.infer<typeof ThreadWorktreeSchema>;

/** One of a project's setup scripts: `command` is typed first into the new folder's terminal, `copy` names files of the project (such as `.env.local`) copied into the new worktree before it. */
export const SetupScriptSchema = z
  .object({
    id: z.string().trim().min(1).max(64),
    name: z.string().trim().min(1).max(80),
    command: z.string().max(2000),
    copy: z.array(z.string().trim().min(1).max(300)).max(50).optional(),
  })
  .strict()
  .meta({ id: 'SetupScript' });
export type SetupScript = z.infer<typeof SetupScriptSchema>;

/**
 * `POST /api/threads` `local`: the thread works in the project folder; `branch` switches the checkout to it first (only with a clean tree, 409 with the reason otherwise).
 * `create` makes `branch` from the checked-out branch instead of switching to an existing one ("New branch from main…"); the uncommitted changes come along, as `git switch -c` has it.
 * `setup` is the id of a setup script to type into the folder's terminal first (none by default: a Local thread does not install anything unasked).
 */
export const NewLocalSchema = z
  .object({ branch: z.string().trim().min(1).max(200).optional(), create: z.boolean().optional(), setup: z.string().trim().min(1).max(64).nullable().optional() })
  .strict()
  .meta({ id: 'NewLocal' });
export type NewLocal = z.infer<typeof NewLocalSchema>;

/**
 * `POST /api/threads` `worktree`: the thread gets a worktree of the project. `base` defaults to the project's setting, then the checked-out branch
 * (`origin/<branch>` fetches first). `carryChanges` applies the folder's uncommitted changes (tracked and untracked) to the new worktree; the folder is not touched.
 * `branch`: absent, named `<prefix><name>` (from `name`, else the title, else the thread id); a string, that exact branch; `null`, detached (no branch until "Create branch here").
 * `setup`: absent, the project's first setup script; a script id; `null`, none. `name`: the text the folder and branch are named after (the first message).
 */
export const NewWorktreeSchema = z
  .object({
    base: z.string().trim().min(1).max(200).optional(),
    carryChanges: z.boolean().optional(),
    branch: z.string().trim().min(1).max(200).nullable().optional(),
    setup: z.string().trim().min(1).max(64).nullable().optional(),
    name: z.string().trim().min(1).max(200).optional(),
  })
  .strict()
  .meta({ id: 'NewWorktree' });
export type NewWorktree = z.infer<typeof NewWorktreeSchema>;

/** `POST /api/threads/:id/placement`: where a thread that has no message yet runs (the Where row of the new-thread page): `local` or `worktree`, as for `POST /api/threads`. */
export const ThreadPlacementSchema = z
  .object({ local: NewLocalSchema.optional(), worktree: NewWorktreeSchema.optional() })
  .strict()
  .refine((p) => !(p.local && p.worktree), { message: 'Choose local or worktree, not both.' })
  .meta({ id: 'ThreadPlacement' });
export type ThreadPlacement = z.infer<typeof ThreadPlacementSchema>;

export const StartModeSchema = z.enum(['local', 'worktree', 'ask']);
export type StartMode = z.infer<typeof StartModeSchema>;
export const CarryChangesSchema = z.enum(['ask', 'always', 'never']);
export type CarryChanges = z.infer<typeof CarryChangesSchema>;
export const BranchModeSchema = z.enum(['named', 'detached']);
export type BranchMode = z.infer<typeof BranchModeSchema>;
export const RemoveFolderSchema = z.enum(['ask', 'now', 'after-7-days', 'never']);
export type RemoveFolder = z.infer<typeof RemoveFolderSchema>;

/** A project's worktree settings (Settings › Projects); `null` means the default. */
export const WorktreeSettingsSchema = z.object({
  root: z.string().nullable(),
  base: z.string().nullable(),
  /** The command of the first setup script (the single setup command, kept for what reads it). */
  setup: z.string().nullable(),
  /** What `root` is when it is `null` (`~/.pi-kit/worktrees`, or `PI_KIT_WORKTREE_ROOT`). */
  defaultRoot: z.string(),
  /** The folder is inside a git work tree, so a thread can have a worktree of it. */
  git: z.boolean(),
  /** Where a new thread starts, the Where row's default: the folder, a worktree, or ask. */
  start: StartModeSchema,
  /** A new Local thread may switch the folder's branch. */
  allowBranchSwitch: z.boolean(),
  /** Whether a new worktree carries the folder's uncommitted changes. */
  carryChanges: CarryChangesSchema,
  /** A new worktree gets a branch named from the first message, or none. */
  branchMode: BranchModeSchema,
  branchPrefix: z.string(),
  /** What happens to a worktree folder after a merge back or a hand off. */
  removeFolder: RemoveFolderSchema,
  /** The project's setup scripts, the first being the default. With none saved and no single setup command, one is derived from the project's lockfile. */
  setupScripts: z.array(SetupScriptSchema),
  /** `setupScripts` holds the script the project's lockfile suggests and nothing is saved yet (Settings › Projects shows it as "suggested" until the list is saved). */
  setupSuggested: z.boolean().optional(),
}).meta({ id: 'WorktreeSettings' });
export type WorktreeSettings = z.infer<typeof WorktreeSettingsSchema>;

export const PatchWorktreeSettingsSchema = z
  .object({
    root: z.string().max(1000).nullable(),
    base: z.string().max(200).nullable(),
    setup: z.string().max(2000).nullable(),
    start: StartModeSchema,
    allowBranchSwitch: z.boolean(),
    carryChanges: CarryChangesSchema,
    branchMode: BranchModeSchema,
    branchPrefix: z.string().max(100),
    removeFolder: RemoveFolderSchema,
    setupScripts: z.array(SetupScriptSchema).max(30).refine((list) => new Set(list.map((s) => s.id)).size === list.length, { message: 'Two setup scripts have the same id.' }),
  })
  .partial()
  .strict().meta({ id: 'PatchWorktreeSettings' });
export type PatchWorktreeSettings = z.infer<typeof PatchWorktreeSettingsSchema>;

/** The defaults for every project (Settings › Projects › Defaults for every project): where worktrees go and where a new thread starts, unless a project says otherwise. */
export const WorktreeDefaultsSchema = z
  .object({
    /** The folder worktrees are made in for every project that has no folder of its own; `null`: `PI_KIT_WORKTREE_ROOT`, else `~/.pi-kit/worktrees`. */
    root: z.string().nullable(),
    /** What `root` is when it is `null`. */
    defaultRoot: z.string(),
    start: StartModeSchema,
  })
  .meta({ id: 'WorktreeDefaults' });
export type WorktreeDefaults = z.infer<typeof WorktreeDefaultsSchema>;

export const PatchWorktreeDefaultsSchema = z
  .object({ root: z.string().max(1000).nullable(), start: StartModeSchema })
  .partial()
  .strict()
  .meta({ id: 'PatchWorktreeDefaults' });
export type PatchWorktreeDefaults = z.infer<typeof PatchWorktreeDefaultsSchema>;

/** What the worktree dialogs need to know before they offer an action. */
export const WorktreeStatusSchema = z.object({
  path: z.string(),
  exists: z.boolean(),
  branch: z.string().nullable(),
  base: z.string().nullable(),
  /** Changed files in the worktree (staged, unstaged and untracked). */
  dirty: z.number().int().nonnegative(),
  /** Commits the branch has that the base does not, and the other way round. */
  ahead: z.number().int().nonnegative(),
  behind: z.number().int().nonnegative(),
  /** Files with unresolved conflicts, and the operation they belong to. */
  conflicts: z.array(z.string()),
  operation: z.enum(['merge', 'rebase']).nullable(),
  /** The main checkout has the base branch checked out (a merge back needs that), and is clean. */
  baseCheckedOut: z.boolean(),
  projectDirty: z.number().int().nonnegative(),
  /** The repository has a remote (a sync fetches first, a PR needs one). */
  remote: z.boolean(),
  /** `gh` is installed and can open a pull request. */
  gh: z.boolean(),
  /** Other threads that run in the same worktree (a removal would take their folder away too). */
  sharedWith: z.number().int().nonnegative(),
  /** The project's "Remove the folder" setting: the Merge back dialog's removal switch starts from it. */
  removeFolder: RemoveFolderSchema,
}).meta({ id: 'WorktreeStatus' });
export type WorktreeStatus = z.infer<typeof WorktreeStatusSchema>;

export const WorktreeSyncRequestSchema = z.object({ strategy: z.enum(['merge', 'rebase']).default('merge') }).strict().meta({ id: 'WorktreeSyncRequest' });
export type WorktreeSyncRequest = z.infer<typeof WorktreeSyncRequestSchema>;

export const WorktreeSyncResultSchema = z.object({
  status: z.enum(['up-to-date', 'synced', 'conflict']),
  /** The remote was fetched first. */
  fetched: z.boolean(),
  /** Conflicting files (`status: conflict`): the merge or rebase is left in progress in the worktree, and review mode shows them with their markers. */
  conflicts: z.array(z.string()),
  message: z.string(),
}).meta({ id: 'WorktreeSyncResult' });
export type WorktreeSyncResult = z.infer<typeof WorktreeSyncResultSchema>;

/** The commit message pi-kit proposes for the worktree's uncommitted changes; the person edits it in the Merge back dialog. */
export const WorktreeMessageSchema = z.object({ message: z.string(), files: z.number().int().nonnegative() }).meta({ id: 'WorktreeMessage' });
export type WorktreeMessage = z.infer<typeof WorktreeMessageSchema>;

export const WorktreeMergeRequestSchema = z
  .object({
    /** `merge`: merge the branch into the base in the main checkout. `pr`: push the branch and open a pull request with `gh`. */
    mode: z.enum(['merge', 'pr']).default('merge'),
    /** The commit message for uncommitted changes; required when there are some. */
    message: z.string().trim().max(5000).optional(),
    /** Remove the worktree (and the merged branch) afterwards. */
    remove: z.boolean().default(false),
  })
  .strict().meta({ id: 'WorktreeMergeRequest' });
export type WorktreeMergeRequest = z.infer<typeof WorktreeMergeRequestSchema>;

export const WorktreeMergeResultSchema = z.object({
  status: z.enum(['merged', 'pr', 'conflict']),
  /** The merge commit on the base (`merged`), or the pull request's URL (`pr`). */
  commit: z.string().optional(),
  url: z.string().optional(),
  conflicts: z.array(z.string()),
  removed: z.boolean(),
  message: z.string(),
}).meta({ id: 'WorktreeMergeResult' });
export type WorktreeMergeResult = z.infer<typeof WorktreeMergeResultSchema>;

export const WorktreeRemoveRequestSchema = z.object({ force: z.boolean().default(false) }).strict().meta({ id: 'WorktreeRemoveRequest' });
export type WorktreeRemoveRequest = z.infer<typeof WorktreeRemoveRequestSchema>;

/** What happens to a thread's worktree when the thread is archived or deleted. */
export const WorktreeKeepSchema = z.enum(['keep', 'remove']);
export type WorktreeKeep = z.infer<typeof WorktreeKeepSchema>;

/** Another thread's soft lease on a file of the folder (Files panel chip, review mode). */
export const FileLeaseSchema = z.object({
  /** Relative to the folder, `/` separators. */
  path: z.string(),
  threadId: z.string(),
  /** The other thread's title, for "being edited by Fix e2e". */
  title: z.string(),
  since: z.number(),
  at: z.number(),
});
export type FileLease = z.infer<typeof FileLeaseSchema>;

/** Another agent that works next to a thread: another thread in the same folder or in a worktree of the same repository, or the pi command line in the same folder. */
export const OtherAgentInfoSchema = z.object({
  title: z.string(),
  state: z.enum(['running', 'idle', 'waiting', 'terminal']),
  relation: z.enum(['same-folder', 'worktree']),
});
export type OtherAgentInfo = z.infer<typeof OtherAgentInfoSchema>;

/** `GET /api/threads/:id/coordination`: what the Files panel, the Changes panel and review mode show about the agents next to a thread. */
export const CoordinationSchema = z.object({
  /** Other threads' active leases on files in the folder the thread works in. */
  leases: z.array(FileLeaseSchema),
  others: z.array(OtherAgentInfoSchema),
}).meta({ id: 'Coordination' });
export type Coordination = z.infer<typeof CoordinationSchema>;

/** The answer of `POST /api/threads/:id/worktree/remove`. */
export const WorktreeRemoveResultSchema = z.object({ removed: z.boolean() }).meta({ id: 'WorktreeRemoveResult' });
export type WorktreeRemoveResult = z.infer<typeof WorktreeRemoveResultSchema>;

// ---- the Where row

/** A local branch of a project, and the worktree that holds it, if one does (a held branch cannot be checked out in the folder). */
export const GitBranchSchema = z.object({
  name: z.string(),
  current: z.boolean(),
  heldBy: z.object({ path: z.string(), thread: z.string().nullable() }).nullable(),
});
export type GitBranch = z.infer<typeof GitBranchSchema>;

/** `GET /api/workspaces/:id/git`: what the Where row shows about the folder. */
export const ProjectGitSchema = z
  .object({
    git: z.boolean(),
    /** The checked-out branch; `null` on a detached `HEAD` (then `head` is the short commit). */
    branch: z.string().nullable(),
    head: z.string().nullable(),
    /** Changed files in the folder (staged, unstaged, untracked): a branch switch needs this to be 0. */
    dirty: z.number().int().nonnegative(),
    branches: z.array(GitBranchSchema),
    /** `origin/<branch>` names, for "from origin/main (fetch first)". */
    remoteBranches: z.array(z.string()),
    hasRemote: z.boolean(),
  })
  .meta({ id: 'ProjectGit' });
export type ProjectGit = z.infer<typeof ProjectGitSchema>;

// ---- hand off

/** `POST /api/threads/:id/worktree/handoff`: `to: 'local'` moves a worktree thread's changes into the folder; `to: 'worktree'` moves a Local thread into a new worktree. */
export const WorktreeHandoffRequestSchema = z
  .object({
    to: z.enum(['local', 'worktree']),
    /** `to: local`: remove the worktree folder afterwards (default: the project's "Remove the folder"; `ask` keeps it unless this is true). */
    remove: z.boolean().optional(),
    /** `to: worktree`: carry the folder's uncommitted changes into the worktree and take them out of the folder (default true). */
    carryChanges: z.boolean().optional(),
    /** `to: worktree`: the branch (absent: named after the thread; `null`: detached) and the setup script, as for a new worktree. */
    branch: z.string().trim().min(1).max(200).nullable().optional(),
    setup: z.string().trim().min(1).max(64).nullable().optional(),
  })
  .strict()
  .meta({ id: 'WorktreeHandoffRequest' });
export type WorktreeHandoffRequest = z.infer<typeof WorktreeHandoffRequestSchema>;

export const WorktreeHandoffResultSchema = z
  .object({
    to: z.enum(['local', 'worktree']),
    /** The folder the thread works in now. */
    path: z.string(),
    branch: z.string().nullable(),
    /** Files whose uncommitted changes moved. */
    moved: z.number().int().nonnegative(),
    /** The old worktree folder was removed. */
    removed: z.boolean(),
    message: z.string(),
  })
  .meta({ id: 'WorktreeHandoffResult' });
export type WorktreeHandoffResult = z.infer<typeof WorktreeHandoffResultSchema>;

/** `POST /api/threads/:id/worktree/branch`: gives a detached worktree a branch. */
export const WorktreeBranchRequestSchema = z.object({ name: z.string().trim().min(1).max(200) }).strict().meta({ id: 'WorktreeBranchRequest' });
export type WorktreeBranchRequest = z.infer<typeof WorktreeBranchRequestSchema>;
export const WorktreeBranchResultSchema = z.object({ branch: z.string() }).meta({ id: 'WorktreeBranchResult' });
export type WorktreeBranchResult = z.infer<typeof WorktreeBranchResultSchema>;
