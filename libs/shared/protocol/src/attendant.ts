import { z } from 'zod';

/**
 * The attendant: an optional second agent of pi-kit's own that tends the thread list. These are the shapes of
 * `/api/attendant` (settings, activity, suggestions), shared by the backend and the Settings › Attendant page.
 */

export const AttendantWhenSchema = z.object({
  /** After a run of a thread has ended. */
  onEnd: z.boolean(),
  /** When a thread asks a question (pending extension dialog). */
  onInterrupt: z.boolean(),
  /** A sweep over the threads that changed since the attendant looked, every N minutes; 0 = no sweep. */
  everyMinutes: z.number().int().min(0).max(1440),
}).meta({ id: 'AttendantWhen' });
export type AttendantWhen = z.infer<typeof AttendantWhenSchema>;

export const AttendantSettingsSchema = z.object({
  /** Off by default: nothing runs and no model is called while it is false. */
  enabled: z.boolean(),
  /** Offer an editable next prompt after a finished run; independent of the housekeeping schedule. */
  followUpSuggestions: z.boolean().default(false),
  /** The model it uses; null = the cheapest model pi can use (a local one is free). */
  model: z.object({ provider: z.string().min(1), modelId: z.string().min(1) }).nullable(),
  when: AttendantWhenSchema,
  /** USD per local calendar day; null = no limit. A day's spending at or over the cap stops the attendant until tomorrow. */
  dailyCostCap: z.number().min(0).nullable(),
}).meta({ id: 'AttendantSettings' });
export type AttendantSettings = z.infer<typeof AttendantSettingsSchema>;

export const DEFAULT_ATTENDANT_SETTINGS: AttendantSettings = {
  enabled: false,
  followUpSuggestions: false,
  model: null,
  when: { onEnd: true, onInterrupt: true, everyMinutes: 0 },
  dailyCostCap: 0.5,
};

export const PatchAttendantSettingsSchema = z
  .object({
    enabled: z.boolean(),
    followUpSuggestions: z.boolean(),
    model: AttendantSettingsSchema.shape.model,
    when: AttendantWhenSchema.partial(),
    dailyCostCap: AttendantSettingsSchema.shape.dailyCostCap,
  })
  .partial()
  .strict().meta({ id: 'PatchAttendantSettings' });
export type PatchAttendantSettings = z.infer<typeof PatchAttendantSettingsSchema>;

export const ATTENDANT_KINDS = ['title', 'summary', 'label', 'draft', 'learn', 'score', 'prompt'] as const;
export const AttendantKindSchema = z.enum(ATTENDANT_KINDS);
export type AttendantKind = z.infer<typeof AttendantKindSchema>;

/** One thing the attendant did (or declined to do), as listed in "Attendant activity". */
export const AttendantActionSchema = z.object({
  id: z.number().int(),
  at: z.number(),
  kind: AttendantKindSchema,
  status: z.enum(['done', 'skipped', 'error']),
  threadId: z.string().nullable(),
  /** The thread's name when the action was taken (it may have been renamed or deleted since). */
  threadTitle: z.string().nullable(),
  /** What it wrote or proposed; for `skipped` and `error` the reason. */
  text: z.string(),
  model: z.string().nullable(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  /** USD, as pi priced the request (a local model costs nothing). */
  cost: z.number().nonnegative(),
}).meta({ id: 'AttendantAction' });
export type AttendantAction = z.infer<typeof AttendantActionSchema>;

export const AttendantUsageSchema = z.object({
  cost: z.number().nonnegative(),
  calls: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
}).meta({ id: 'AttendantUsage' });
export type AttendantUsage = z.infer<typeof AttendantUsageSchema>;

export const AttendantStatusSchema = z.object({
  settings: AttendantSettingsSchema,
  /** Model requests made since the backend started: 0 for as long as the attendant is off. */
  calls: z.number().int().nonnegative(),
  /** Since local midnight. */
  today: AttendantUsageSchema,
  capReached: z.boolean(),
  /** Threads waiting for the attendant, the one it is working on included. */
  queued: z.number().int().nonnegative(),
  /** The model that would be used now ("provider/id"), or null when none is available. */
  activeModel: z.string().nullable(),
  /** The latest actions, newest first. */
  actions: z.array(AttendantActionSchema),
}).meta({ id: 'AttendantStatus' });
export type AttendantStatus = z.infer<typeof AttendantStatusSchema>;

/** `POST /api/attendant/run`: look at one thread (or every thread that needs it) now, ignoring the schedule but not the on / off switch or the cap. */
export const AttendantRunSchema = z.object({ threadId: z.string().min(1).optional() }).strict().meta({ id: 'AttendantRun' });

/** The answer of `POST /api/attendant/run`: how many threads were queued. */
export const AttendantRunResultSchema = z.object({ queued: z.number().int().nonnegative() }).meta({ id: 'AttendantRunResult' });
export type AttendantRunResult = z.infer<typeof AttendantRunResultSchema>;
