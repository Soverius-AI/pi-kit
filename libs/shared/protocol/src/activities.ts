import { z } from 'zod';
import { ReviewCommentSchema } from './review';
import { PiSkillsContentSchema } from './skills';

/**
 * Stateful transcript surfaces carried as AG-UI `ACTIVITY_SNAPSHOT` / `ACTIVITY_DELTA` content
 * (extended). The adapter emits them, the renderer reads them off the agent's
 * messages (`role: "activity"`).
 *
 * Message ids are derived so a renderer can find the activity that belongs to a tool call:
 * `tool:<toolCallId>`, `bash:<toolCallId>`, `diff:<toolCallId>`, `widget:<key>`, `compaction:<entryId>`, `branch-summary:<entryId>`, `review:<entryId>`, `skills:<entryId>`, `usage:<assistantMessageId>`.
 */

export const PiWidgetContentSchema = z.object({
  key: z.string(),
  lines: z.array(z.string()),
  placement: z.enum(['aboveEditor', 'belowEditor']).optional(),
});

export const PiDiffHunkSchema = z.object({
  oldStart: z.number().int(),
  oldLines: z.number().int(),
  newStart: z.number().int(),
  newLines: z.number().int(),
  /** Unified-diff lines including their leading ` `, `+` or `-`. */
  lines: z.array(z.string()),
});

export const PiDiffContentSchema = z.object({
  path: z.string(),
  hunks: z.array(PiDiffHunkSchema),
  toolCallId: z.string().optional(),
  /** `write` calls: the whole file is shown as added because pi does not report what it replaced. */
  written: z.boolean().optional(),
});

export const PiBashContentSchema = z.object({
  command: z.string(),
  output: z.string(),
  exitCode: z.number().int().optional(),
  running: z.boolean(),
  cancelled: z.boolean().optional(),
  truncated: z.boolean().optional(),
  /** The user typed it with `!command` rather than the model calling the bash tool. */
  user: z.boolean().optional(),
}).meta({ id: 'PiBashContent' });

/** Live state of one tool call: what the activity row's status dot and sub-line show (from `tool_execution_*`). */
export const PiToolContentSchema = z.object({
  toolCallId: z.string(),
  toolName: z.string(),
  status: z.enum(['running', 'done', 'error']),
  /** Epoch milliseconds of `tool_execution_start`. */
  startedAt: z.number(),
  durationMs: z.number().optional(),
  /** Latest `tool_execution_update` boiled down to one line (the last non-empty output line). */
  progress: z.string().optional(),
  /** Inline screenshots returned by a tool, retained for live and restored transcripts. */
  images: z.array(z.object({ data: z.string(), mimeType: z.string() })).optional(),
});

/** "Context compacted" marker; its message id is `compaction:<firstKeptEntryId>` live and in history. */
export const PiCompactionContentSchema = z.object({
  tokensBefore: z.number().optional(),
  tokensAfter: z.number().optional(),
  summary: z.string().optional(),
});

/** Marker for a branch summary: what pi wrote down about the branch it left; id `branch-summary:<entryId>`. */
export const PiBranchSummaryContentSchema = z.object({
  summary: z.string().optional(),
});

/** The structured review batch of a user turn; id `review:<entryId>`, placed right after the user message it belongs to. */
export const PiReviewContentSchema = z.object({
  comments: z.array(ReviewCommentSchema),
});

/**
 * What one model request used, from the assistant message's `usage`; id `usage:<assistantMessageId>`, placed right after
 * that message. The transcript sums the ones of a turn into the usage line under it.
 */
export const PiTurnUsageContentSchema = z.object({
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
  cost: z.number(),
  /** Milliseconds from the request being made to the message being complete. */
  elapsedMs: z.number().optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  thinkingLevel: z.string().optional(),
});

export const PI_ACTIVITY_TYPES = {
  'pi.widget': PiWidgetContentSchema,
  'pi.diff': PiDiffContentSchema,
  'pi.bash': PiBashContentSchema,
  'pi.tool': PiToolContentSchema,
  'pi.compaction': PiCompactionContentSchema,
  'pi.branch_summary': PiBranchSummaryContentSchema,
  'pi.review': PiReviewContentSchema,
  'pi.skills': PiSkillsContentSchema,
  'pi.turn_usage': PiTurnUsageContentSchema,
} as const;

export type PiActivityType = keyof typeof PI_ACTIVITY_TYPES;
export type PiActivityContent<T extends PiActivityType> = z.infer<(typeof PI_ACTIVITY_TYPES)[T]>;
export type PiDiffHunk = z.infer<typeof PiDiffHunkSchema>;

export const activityId = {
  tool: (toolCallId: string) => `tool:${toolCallId}`,
  bash: (toolCallId: string) => `bash:${toolCallId}`,
  diff: (toolCallId: string) => `diff:${toolCallId}`,
  widget: (key: string) => `widget:${key}`,
  compaction: (firstKeptEntryId: string) => `compaction:${firstKeptEntryId}`,
  branchSummary: (entryId: string) => `branch-summary:${entryId}`,
  review: (entryId: string) => `review:${entryId}`,
  skills: (entryId: string) => `skills:${entryId}`,
  usage: (assistantMessageId: string) => `usage:${assistantMessageId}`,
};
