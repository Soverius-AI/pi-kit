import { z } from 'zod';

/**
 * `GET /api/threads/:id/usage`: the usage of a session, aggregated from the session file the way pi's `/session` does
 * (every entry of the file, all branches, assistant messages, tool results with nested usage, `usage` entries, and the summaries of
 * compactions and branch summaries), so turns made in the pi CLI count. The totals equal the sum of the `byTurn` rows and of the
 * `byModel` rows by construction.
 */

const counts = {
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
  /** input + output + cacheRead + cacheWrite, as pi totals it. */
  total: z.number(),
  cost: z.number(),
  /** Model requests behind the numbers (assistant messages, summaries, nested tool usage, cache warming). */
  requests: z.number(),
};

export const UsageRowSchema = z.object(counts);
export type UsageRow = z.infer<typeof UsageRowSchema>;

export const ModelUsageSchema = z.object({ provider: z.string(), model: z.string(), ...counts });
export type ModelUsage = z.infer<typeof ModelUsageSchema>;

export const TurnUsageSchema = z.object({
  /** 1-based in file order of the user messages; 0 collects usage before the first message. */
  turn: z.number().int(),
  entryId: z.string().optional(),
  timestamp: z.string().optional(),
  /** The first words of the user message. */
  preview: z.string(),
  /** Models that answered the turn, in order of first use. */
  models: z.array(z.string()),
  /** Sum of the requests' time from the request to the complete message. */
  elapsedMs: z.number().optional(),
  ...counts,
});
export type TurnUsage = z.infer<typeof TurnUsageSchema>;

export const CompactionUsageSchema = z.object({
  entryId: z.string(),
  timestamp: z.string().optional(),
  tokensBefore: z.number(),
  /** The context the first response after the compaction was given (input and cache, without its output): pi does not store the figure. */
  tokensAfter: z.number().optional(),
});
export type CompactionUsage = z.infer<typeof CompactionUsageSchema>;

export const ThreadUsageSchema = z.object({
  sessionId: z.string(),
  sessionFile: z.string().nullable(),
  totals: z.object({ ...counts, turns: z.number().int() }),
  /** cacheRead / (input + cacheRead + cacheWrite); null when nothing was sent. */
  cacheHitRatio: z.number().nullable(),
  byModel: z.array(ModelUsageSchema),
  byTurn: z.array(TurnUsageSchema),
  compactions: z.array(CompactionUsageSchema),
}).meta({ id: 'ThreadUsage' });
export type ThreadUsage = z.infer<typeof ThreadUsageSchema>;
