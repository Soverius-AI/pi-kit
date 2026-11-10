import { z } from 'zod';

const ToolProgressSchema = z.looseObject({
  callId: z.string(),
  name: z.string(),
  status: z.enum(['pending', 'running', 'done']),
  /** The tail of the output so far; `droppedBytes`/`droppedLines` were cut from its head. */
  output: z.string().optional(),
  droppedBytes: z.number().optional(),
  droppedLines: z.number().optional(),
});

/** pi-durable's `pi.live` document: what a background agent is doing right now. Unknown fields pass through. */
export const PiLiveStateSchema = z.looseObject({
  /** Present while a run is going. */
  run: z.looseObject({ turns: z.number() }).optional(),
  /** The model request in flight. Its answer is not here: it streams as an AG-UI assistant message. */
  generation: z
    .looseObject({
      attempt: z.number(),
      retry: z.looseObject({ at: z.number(), error: z.string() }).optional(),
      deferred: z.looseObject({ pollAt: z.number() }).optional(),
    })
    .optional(),
  tools: z.array(ToolProgressSchema).optional(),
  /** Calls a tool made itself, under the call `parentCallId`. */
  nestedTools: z
    .array(
      ToolProgressSchema.extend({
        parentCallId: z.string(),
        arguments: z.record(z.string(), z.unknown()).optional(),
        summary: z
          .looseObject({ isError: z.boolean(), durationMs: z.number().optional(), error: z.string().optional() })
          .optional(),
      }),
    )
    .optional(),
  compactions: z
    .array(
      z.looseObject({
        trigger: z.string(),
        blocking: z.boolean(),
        attempt: z.number(),
        retry: z.looseObject({ at: z.number(), error: z.string() }).optional(),
      }),
    )
    .optional(),
  compactionFailure: z.looseObject({ trigger: z.string(), error: z.string() }).optional(),
  /** Why the last run ended without an answer: `model_error`, `no_model`, `aborted`, `reset`, `faulted`, … */
  runFailure: z.looseObject({ reason: z.string(), detail: z.string().optional() }).optional(),
});
export type PiLiveState = z.infer<typeof PiLiveStateSchema>;

/**
 * The live state of one background agent, forwarded from its durable conversation's view; id `agent-live:<agentId>`.
 * `docs` holds the view's documents as they are (`pi.live`, `pi.inbox`, `pi.agent`, `pi.usage`), except the answer being
 * streamed (`pi.live.generation.message`), which is an AG-UI assistant message. `ACTIVITY_DELTA` patches it with pi's own
 * updates translated to JSON Patch.
 */
export const PiAgentLiveContentSchema = z
  .looseObject({
    docs: z.looseObject({ 'pi.live': PiLiveStateSchema.optional() }),
    /** When each live tool call's task started and ended (wall-clock milliseconds, from pi's task records), by call id. */
    timing: z
      .record(z.string(), z.looseObject({ startedAt: z.number().optional(), endedAt: z.number().optional() }))
      .optional(),
  })
  .meta({ id: 'PiAgentLiveContent' });

/** The run id prefix of a run that only carries live-state changes made while the agent was idle: never shown as busy. */
export const AGENT_LIVE_SYNC_RUN = 'agent-live-sync:';
