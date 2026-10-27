import { z } from 'zod';
import { ThreadDraftBadgeSchema } from './learn';
import { ThreadOutcomeBadgeSchema } from './outcome';
import { AgentQuestionDialogSchema, BgAgentSchema } from './bg-agents';
import { NewLocalSchema, NewWorktreeSchema,PatchWorktreeSettingsSchema, ThreadWorktreeSchema, WorktreeKeepSchema, WorktreeSettingsSchema } from './worktree';

/**
 * REST shapes of `/api/threads` and `/api/workspaces`, shared by the backend
 * (request validation) and the renderer (types).
 */

export const ThreadOriginSchema = z.enum(['app', 'cli']);
export const LastRunStatusSchema = z.enum(['finished', 'error', 'aborted']);

/** What the attendant offers the user on a thread: a label for a fork point, an answer to a mechanical question, or a skill drafted from the thread to read. The user accepts or dismisses it; nothing is applied by itself. */
export const ThreadSuggestionSchema = z.object({
  id: z.number().int(),
  kind: z.enum(['label', 'answer', 'learn', 'prompt']),
  /** `label`: session entry. `answer`: dialog id. `learn`: skill draft id. `prompt`: opaque fingerprint of its run, active message and agent state. */
  target: z.string(),
  /** `label`: the proposed label. `answer`: the choice, `Allow` / `Deny` for a confirm, one of the options for a select. `learn`: the drafted skill's name. */
  text: z.string(),
  /** One sentence on why, for the tooltip. */
  reason: z.string().optional(),
}).meta({ id: 'ThreadSuggestion' });
export type ThreadSuggestion = z.infer<typeof ThreadSuggestionSchema>;

/** The dialog a waiting thread is blocked on: enough for the sidebar's "Needs you" strip to answer it with a chip. The answer itself goes through the AG-UI resume, like the approval block's. */
export const ThreadDialogSchema = z.object({
  /** The interrupt id: what a resume answers. */
  id: z.string(),
  method: z.enum(['confirm', 'select', 'input', 'editor']),
  /** A `select` dialog's options. */
  options: z.array(z.string()).optional(),
}).meta({ id: 'ThreadDialog' });
export type ThreadDialog = z.infer<typeof ThreadDialogSchema>;

/**
 * The state of a thread at a glance, computed in the backend and pushed over `GET /api/threads/events`: what
 * the sidebar draws next to the title and, strongest first, on a collapsed project.
 */
export const ThreadStateSchema = z.object({
  /** `running`: a run holds the lock. `waiting`: pi is blocked in an extension dialog and needs an answer. */
  activity: z.enum(['idle', 'running', 'waiting']),
  /** The first words of the pending question of a waiting thread. */
  question: z.string().nullable(),
  /** The first pending dialog of a waiting thread; null or absent for a question in prose and for a thread that does not wait. */
  dialog: ThreadDialogSchema.nullable().optional(),
  /** Share of the model's context window in use, whole percent; null while unknown (never measured, or right after a compaction). */
  context: z.number().int().nonnegative().nullable(),
  /** Outcome of the latest finished run. */
  lastRun: LastRunStatusSchema.nullable(),
  /** A run finished (not stopped, not failed) since the user last looked at the thread. */
  unread: z.boolean(),
  /** A run ended, however it ended, since the user last looked: a stopped or failed run only lights up a collapsed project while it is unseen. */
  unseen: z.boolean(),
  /** The session file was changed outside pi-kit (the pi command line) since the user last looked. */
  cli: z.boolean(),
  /** The attendant's one-line "what it is doing / what it needs"; null while it has none (or is off). */
  summary: z.string().nullable(),
  /** Open suggestions of the attendant, newest first. */
  suggestions: z.array(ThreadSuggestionSchema),
  /** How the thread ended: merged back, a pull request, or committed in its folder; null while it has no outcome. */
  outcome: ThreadOutcomeBadgeSchema.nullable(),
  /** The skill drafted from this thread: pending (read it), approved or discarded (reopen it); null while the thread has none. */
  draft: ThreadDraftBadgeSchema.nullable(),
  /** Questions of the thread's background agents the user has to answer; absent or empty when there are none. */
  agentQuestions: z.array(AgentQuestionDialogSchema).optional(),
  /** The AG-UI run that holds the lock while the thread runs: a client that already follows it needs no second replay. */
  run: z.string().nullable().optional(),
}).meta({ id: 'ThreadState' });
export type ThreadState = z.infer<typeof ThreadStateSchema>;

/** One line of the status stream (`GET /api/threads/events`, newline-delimited JSON). `list`: threads or projects were added, removed or renamed; fetch the list again. */
export const ThreadsEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('snapshot'), states: z.record(z.string(), ThreadStateSchema) }),
  z.object({ type: z.literal('state'), id: z.string(), state: ThreadStateSchema }),
  z.object({ type: z.literal('gone'), id: z.string() }),
  /** The background agents of a thread changed: the whole list, so a panel needs no second request. */
  z.object({ type: z.literal('agents'), id: z.string(), agents: z.array(BgAgentSchema) }),
  z.object({ type: z.literal('list') }),
  z.object({ type: z.literal('ping') }),
]).meta({ id: 'ThreadsEvent' });
export type ThreadsEvent = z.infer<typeof ThreadsEventSchema>;

export const ThreadSummarySchema = z.object({
  /** The pi session id. */
  id: z.string(),
  /** The project's folder; for a thread in a worktree the main checkout, so the thread stays under its project. */
  cwd: z.string(),
  /** pi's session name, if one was set (`/name`, or by renaming in the app). */
  title: z.string().nullable(),
  /** First user message; the fallback label for a thread without a name. */
  preview: z.string().nullable(),
  /** The first line of the last assistant message of the active branch, short and redacted; the sidebar's summary line when the attendant has none. Null or absent while unknown. */
  lastLine: z.string().nullable().optional(),
  pinned: z.boolean(),
  archived: z.boolean(),
  /** `cli` for sessions the pi CLI created and the app only found. */
  origin: ThreadOriginSchema,
  messageCount: z.number().int().nonnegative(),
  /** True while a run holds the thread's lock. */
  running: z.boolean(),
  /** An extension dialog is waiting for the user's answer (the run ended in an interrupt, pi is still blocked). */
  waiting: z.boolean(),
  /** Outcome of the latest finished run; `aborted` also covers a run cut off by quitting the app. */
  lastRun: LastRunStatusSchema.nullable(),
  parentThreadId: z.string().nullable(),
  /** Extra branches in the session tree (0 for a straight conversation); the sidebar says "N forks". */
  forkCount: z.number().int().nonnegative(),
  /** Epoch milliseconds. */
  createdAt: z.number(),
  updatedAt: z.number(),
  lastOpenedAt: z.number().nullable(),
  /** The same facts as `running`, `waiting` and `lastRun`, plus context, unread, cli and the attendant's summary. */
  state: ThreadStateSchema,
  /** Present for a thread that has (or had) a worktree of its own. */
  worktree: ThreadWorktreeSchema.optional(),
  /** A persistent learning workspace; its draft and provenance belong to the source chat. */
  learning: z.object({ sourceThreadId: z.string() }).optional(),
}).meta({ id: 'ThreadSummary' });
export type ThreadSummary = z.infer<typeof ThreadSummarySchema>;

export const ThreadDetailSchema = ThreadSummarySchema.extend({
  sessionPath: z.string(),
}).meta({ id: 'ThreadDetail' });
export type ThreadDetail = z.infer<typeof ThreadDetailSchema>;

export const CreateThreadSchema = z.object({
  cwd: z.string().min(1),
  title: z.string().trim().min(1).max(200).optional(),
  /** Give the thread a worktree of the project instead of the project's folder. */
  worktree: NewWorktreeSchema.optional(),
  /** Or work in the project folder, on another branch (switched before the first run). */
  local: NewLocalSchema.optional(),
}).refine((t) => !(t.local && t.worktree), { message: 'Choose local or worktree, not both.' }).meta({ id: 'CreateThread' });
export type CreateThread = z.infer<typeof CreateThreadSchema>;

export const PatchThreadSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    pinned: z.boolean(),
    archived: z.boolean(),
    /** With `archived: true` on a thread that has a worktree: keep it or remove it (a worktree with uncommitted changes is not removed unasked). */
    worktree: WorktreeKeepSchema,
  })
  .partial()
  .strict().meta({ id: 'PatchThread' });
export type PatchThread = z.infer<typeof PatchThreadSchema>;

export const ForkThreadSchema = z
  .object({
    cwd: z.string().min(1).optional(),
    /** Fork only the path from the root to this entry (the session tree's "Fork to new thread"); default is the whole history. */
    entryId: z.string().min(1).optional(),
  })
  .strict().meta({ id: 'ForkThread' });
export const CloneThreadSchema = z.object({ entryId: z.string().min(1).optional() }).strict().meta({ id: 'CloneThread' });

/** A project of the sidebar: a known folder. */
export const WorkspaceSchema = z.object({
  cwd: z.string(),
  name: z.string(),
  lastOpenedAt: z.number(),
  threadCount: z.number().int().nonnegative(),
  /** The group is folded in the sidebar. */
  collapsed: z.boolean(),
  /** The group is not listed in the sidebar (it stays a known folder; the filter menu brings it back). */
  hidden: z.boolean(),
  /** The attendant may work on this project's threads (the per-project opt-out is `false`). */
  attendant: z.boolean(),
  /** Background agents may run for this project's threads: on unless the project's page in Settings › Projects switched them off. */
  agents: z.boolean(),
  /** The checked-out branch (or the short commit when detached); null for a folder that is not a git working tree. */
  branch: z.string().nullable(),
  /** Where this project's thread worktrees go and what runs in a new one. */
  worktree: WorktreeSettingsSchema.optional(),
}).meta({ id: 'Workspace' });
export type Workspace = z.infer<typeof WorkspaceSchema>;

/** `PATCH /api/workspaces`: one project's sidebar flags. */
export const PatchWorkspaceSchema = z
  .object({
    cwd: z.string().min(1),
    collapsed: z.boolean(),
    hidden: z.boolean(),
    attendant: z.boolean(),
    agents: z.boolean(),
    worktree: PatchWorktreeSettingsSchema,
  })
  .partial({ collapsed: true, hidden: true, attendant: true, agents: true, worktree: true })
  .strict().meta({ id: 'PatchWorkspace' });
export type PatchWorkspace = z.infer<typeof PatchWorkspaceSchema>;

/** `PUT /api/workspaces/order`: the projects in the order the sidebar lists them. */
export const WorkspaceOrderSchema = z.object({ order: z.array(z.string().min(1)).min(1) }).strict().meta({ id: 'WorkspaceOrder' });

export const OpenWorkspaceSchema = z.object({ cwd: z.string().min(1) }).strict().meta({ id: 'OpenWorkspace' });

/** `GET /api/threads?workspace=&archived=`: the threads of one folder (every folder without `workspace`), the archived ones on request. */
export const ListThreadsQuerySchema = z
  .object({
    workspace: z.string().optional().describe("The project's folder; every project when absent."),
    archived: z.enum(['0', '1', 'true', 'false']).optional().describe('`1` or `true` lists the archived threads too.'),
  })
  ;

/** `DELETE /api/threads/:id?worktree=`: what happens to the thread's worktree. */
export const DeleteThreadQuerySchema = z
  .object({
    worktree: z
      .enum(['keep', 'remove', 'force'])
      .optional()
      .describe('`keep` (the default) leaves the worktree, `remove` removes it when it is clean (409 otherwise), `force` removes it whatever it holds.'),
  })
  ;

/** The app's own settings (`GET /api/settings`): a JSON value per key, whatever the renderer stored (view preferences, onboarding state). */
export const AppSettingsSchema = z.record(z.string(), z.unknown()).meta({ id: 'AppSettings' });

/** `PUT /api/settings/:key`: a missing `value` stores `null`. */
export const PutAppSettingSchema = z.object({ value: z.unknown().optional() }).meta({ id: 'PutAppSetting' });
