import { z } from 'zod';
import { SkillDraftSchema, SkillVerificationSchema } from './learn';
import { ThreadOutcomeSchema } from './outcome';
import { HunkLabelEntrySchema, OutcomeScoresSchema } from './score';

/**
 * The plugin API (`doc/docs/plugins.md`): a pi package talks to pi-kit through events on pi's shared bus (`pi.events`). A request is
 * `pi.events.emit('pi-kit:<area>:<what>', { requestId, ...params })`; pi-kit answers on `<channel>:reply` with the same `requestId`, either
 * `{ requestId, ok: true, ...result }` or `{ requestId, ok: false, error, code? }`. A host that is not pi-kit (the pi command line) never answers, so a package
 * waits for the reply with a timeout and says that pi-kit is needed. The schemas here are the documented payloads; the backend validates every request with them.
 */

export const PLUGIN_CHANNELS = {
  transcript: 'pi-kit:thread:transcript',
  outcome: 'pi-kit:thread:outcome',
  attendant: 'pi-kit:attendant:run',
  draft: 'pi-kit:learn:draft',
  baselines: 'pi-kit:thread:baselines',
  annotate: 'pi-kit:thread:annotate',
  verified: 'pi-kit:learn:verified',
} as const;
export type PluginChannel = (typeof PLUGIN_CHANNELS)[keyof typeof PLUGIN_CHANNELS];
export const PLUGIN_CHANNEL_LIST: readonly PluginChannel[] = Object.values(PLUGIN_CHANNELS);

/** The channel a request's answer comes on. */
export const replyChannel = (channel: string): string => `${channel}:reply`;

const RequestBase = z.object({
  /** Chosen by the caller; the answer carries it back. */
  requestId: z.string().min(1).max(100),
  /** A thread id (or the start of one); the thread the package runs in when omitted. */
  thread: z.string().min(1).max(200).optional(),
});

// ---- pi-kit:thread:transcript

/** One tool call of the thread: what it was called on, and how it ended. */
export const TranscriptStepSchema = z.object({
  n: z.number().int().positive(),
  tool: z.string(),
  /** The file, command, pattern or address the call was about (at most 200 characters). */
  target: z.string().nullable(),
  outcome: z.enum(['ok', 'error', 'unknown']),
});
export type TranscriptStep = z.infer<typeof TranscriptStepSchema>;

/** An error pi met and what came of it: `recovered` when a later call of the same tool on the same target worked. */
export const TranscriptErrorSchema = z.object({
  /** The step the error belongs to. */
  step: z.number().int().positive(),
  tool: z.string(),
  target: z.string().nullable(),
  message: z.string(),
  recovered: z.boolean(),
  /** The step that recovered it. */
  recoveredBy: z.number().int().positive().nullable(),
});
export type TranscriptError = z.infer<typeof TranscriptErrorSchema>;

/** A command that checks the work (a test run, a build, a linter) and whether it passed. */
export const TranscriptCheckSchema = z.object({
  step: z.number().int().positive(),
  command: z.string(),
  passed: z.boolean(),
});
export type TranscriptCheck = z.infer<typeof TranscriptCheckSchema>;

/** A dialog the person answered while pi was working on a message: allow, deny, a choice or a text. */
export const TranscriptAnswerSchema = z.object({
  method: z.enum(['confirm', 'select', 'input', 'editor']),
  title: z.string(),
  status: z.enum(['resolved', 'cancelled']),
  /** `confirm`: allowed (true) or denied (false). */
  confirmed: z.boolean().optional(),
  /** `select`, `input`, `editor`: what was chosen or typed (at most 300 characters). */
  value: z.string().optional(),
});
export type TranscriptAnswer = z.infer<typeof TranscriptAnswerSchema>;

/** A review comment that travelled with a message, as the transcript carries it. */
export const TranscriptReviewCommentSchema = z.object({
  file: z.string(),
  side: z.enum(['old', 'new']),
  line: z.number().int().nonnegative(),
  endLine: z.number().int().nonnegative().optional(),
  text: z.string(),
  snippet: z.string(),
});
export type TranscriptReviewComment = z.infer<typeof TranscriptReviewCommentSchema>;

/**
 * One user message with what came of it: when it was sent, whether pi took it from the queue unattended, the time since pi last spoke, how many tool calls and which
 * edited files followed, the skill chips and review comments it carried, the dialogs the person answered while pi worked on it, and the last thing pi said before it (for the
 * "quoting pi's own words" rule of the ledger). The text is redacted like everything else.
 */
export const TranscriptTurnSchema = z.object({
  /** 1-based, the order of the user messages (the first is the thread's reason for being). */
  n: z.number().int().positive(),
  /** Epoch ms of the message; null when the session entry has no time. */
  at: z.number().nullable(),
  text: z.string(),
  /** A follow-up or steer that pi picked up the moment it finished the turn before: the person was not waiting for it. */
  queued: z.boolean(),
  /** Milliseconds between the previous entry of the session and this message: the person's time between turns; null for the first. */
  gapMs: z.number().nonnegative().nullable(),
  toolCalls: z.number().int().nonnegative(),
  /** Files pi edited or wrote while working on this message (relative to the project, at most 40). */
  files: z.array(z.string()),
  chips: z.array(z.object({ kind: z.enum(['skill', 'prompt']), name: z.string() })),
  review: z.array(TranscriptReviewCommentSchema).nullable(),
  answers: z.array(TranscriptAnswerSchema),
  /** The end of what pi said before this message (at most 400 characters); null before the first. */
  previous: z.string().nullable(),
});
export type TranscriptTurn = z.infer<typeof TranscriptTurnSchema>;

/** The thread as the analysis sees it: reduced, and redacted before it leaves the backend. */
export const ThreadTranscriptSchema = z
  .object({
    threadId: z.string(),
    title: z.string().nullable(),
    /** The project folder. */
    cwd: z.string(),
    /** What the person asked, in order (the first one is the thread's reason for being). */
    prompts: z.array(z.string()),
    /** How many tool calls the thread made (the steps list can be shorter when it was cut). */
    toolCalls: z.number().int().nonnegative(),
    steps: z.array(TranscriptStepSchema),
    errors: z.array(TranscriptErrorSchema),
    checks: z.array(TranscriptCheckSchema),
    /** The outcome's final diff (`git diff base..head`), cut to a size a model can read; null without an outcome. */
    diff: z.string().nullable(),
    /** Lines added and removed in the outcome. */
    changedLines: z.number().int().nonnegative(),
    /** The commit message of the outcome's head. */
    commitMessage: z.string().nullable(),
    base: z.string().nullable(),
    head: z.string().nullable(),
    /** One entry per user message with its timing, tool calls, chips, review comments and dialog answers; `prompts` is the same messages as plain text. pi-kit always sets it; a transcript built without it (a test fixture) has the prompts alone. */
    turns: z.array(TranscriptTurnSchema).optional(),
    /** Something was cut to fit (many steps, a long diff). */
    truncated: z.boolean(),
    /** Secrets masked by the redaction pass. */
    redactions: z.number().int().nonnegative(),
  })
  .meta({ id: 'ThreadTranscript' });
export type ThreadTranscript = z.infer<typeof ThreadTranscriptSchema>;

export const TranscriptRequestSchema = RequestBase.strict();
export type TranscriptRequest = z.infer<typeof TranscriptRequestSchema>;

// ---- pi-kit:thread:outcome

export const OutcomeRequestSchema = RequestBase.extend({
  diff: z.boolean().optional(),
  /** Add what plugins stored with the outcome (`annotations`): the labels and the person's corrections of them, and the scores. */
  annotations: z.boolean().optional(),
}).strict();
export type OutcomeRequest = z.infer<typeof OutcomeRequestSchema>;
export const OutcomeResultSchema = z.object({
  outcome: ThreadOutcomeSchema.nullable(),
  diff: z.string().nullable().optional(),
  annotations: z.object({ hunkLabels: z.unknown().nullable(), scores: z.unknown().nullable() }).optional(),
});

// ---- pi-kit:attendant:run

/** One model call through the attendant: its model, its cost cap and its activity list. */
export const AttendantRunRequestSchema = RequestBase.extend({
  /** What the call is for, one word for the activity list (`learn`, `score`). */
  task: z.enum(['learn', 'score']),
  system: z.string().min(1).max(40_000),
  user: z.string().min(1).max(400_000),
  /** The person agreed to send this thread's text to the model while the attendant is off. */
  consent: z.boolean().optional(),
}).strict();
export type AttendantRunRequest = z.infer<typeof AttendantRunRequestSchema>;
export const AttendantRunResultPluginSchema = z.object({
  text: z.string(),
  model: z.string(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cost: z.number().nonnegative(),
});
export type AttendantRunPluginResult = z.infer<typeof AttendantRunResultPluginSchema>;

// ---- pi-kit:learn:draft

/** A package hands a draft back; pi-kit stores it as `pending` (it never writes a skills folder). */
export const DraftRequestSchema = RequestBase.extend({
  /** The `SKILL.md`: frontmatter with name and description, then the instructions. */
  text: z.string().min(1).max(200_000),
  /** The model that wrote it, `provider/id`. */
  model: z.string().max(200).optional(),
}).strict();
export type DraftRequest = z.infer<typeof DraftRequestSchema>;
export const DraftResultSchema = z.object({ draft: SkillDraftSchema });

// ---- pi-kit:thread:baselines

export const BaselinesRequestSchema = RequestBase.strict();
export type BaselinesRequest = z.infer<typeof BaselinesRequestSchema>;
/** A file the thread's runs changed: never its content, which may be large or private. */
export const BaselineFileSchema = z.object({
  path: z.string(),
  /** The file existed before the thread's first run that changed it (false: the thread created it). */
  existed: z.boolean(),
  /** When the run that first changed it started (epoch ms). */
  at: z.number(),
  /** The 1-based message in which pi first touched it; null when the session does not say. */
  turn: z.number().int().positive().nullable(),
  /** How many `edit` and `write` calls touched it. */
  edits: z.number().int().nonnegative(),
});
export type BaselineFile = z.infer<typeof BaselineFileSchema>;

// ---- pi-kit:thread:annotate

/**
 * A package hands labels and scores back; pi-kit stores them with the thread's outcome and draws them (the badge's second line, the Outcome view's hunk labels, the project histogram) for as
 * long as the package is installed. `labels` replace the package's earlier labels of the thread (the person's corrections of them stay); `scores` replace the stored scores; `null` clears
 * either. `base` and `head` are the outcome the labels describe: when the outcome moves on, pi-kit says the labels are out of date.
 */
export const AnnotateRequestSchema = RequestBase.extend({
  base: z.string().min(1).max(100),
  head: z.string().min(1).max(100),
  model: z.string().max(200).nullable().optional(),
  labels: z.array(HunkLabelEntrySchema).nullable().optional(),
  scores: OutcomeScoresSchema.nullable().optional(),
}).strict();
export type AnnotateRequest = z.infer<typeof AnnotateRequestSchema>;
// ---- pi-kit:learn:verified

/**
 * Replays the thread's draft skill from the outcome's base commit in a scratch worktree and answers with the report when it is done (a minute to many, so the caller waits long).
 * `start: false` only reads the report of the last verification without starting one. `prompt` replaces the thread's first prompt for this run.
 */
export const VerifiedRequestSchema = RequestBase.extend({
  start: z.boolean().optional(),
  prompt: z.string().trim().min(1).max(20_000).optional(),
}).strict();
export type VerifiedRequest = z.infer<typeof VerifiedRequestSchema>;
export const VerifiedResultSchema = z.object({
  draft: z.object({ id: z.string(), name: z.string(), state: z.string() }),
  /** The verification record; `null` when the draft has never been verified (`start: false`). */
  verification: SkillVerificationSchema.nullable(),
});

/** Why a request failed, for the caller's decision: `consent` means ask the person and send it again with `consent: true`. */
export const PluginFailureCodeSchema = z.enum([
  'invalid',
  'not-found',
  'consent',
  'off',
  'cap',
  'no-model',
  'conflict',
  'failed',
]);
export type PluginFailureCode = z.infer<typeof PluginFailureCodeSchema>;

export type PluginFailure = {
  requestId: string;
  ok: false;
  error: string;
  code: PluginFailureCode;
  /** `consent`: the model the text would go to. */
  model?: string;
};
export type PluginReply<T extends object> = ({ requestId: string; ok: true } & T) | PluginFailure;
